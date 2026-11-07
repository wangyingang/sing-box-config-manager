import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import manifestSchema from '../contracts/artifact-manifest.schema.json' with { type: 'json' };
import subscriptionSchema from '../contracts/rule-subscription.schema.json' with { type: 'json' };
import subscriptionV2Schema from '../contracts/rule-subscription-v2.schema.json' with { type: 'json' };
import { verifyActivationCandidate } from './activation.js';
import { githubActivation, type ActivationTransport } from './activation-transport.js';
import { parseBuildConfiguration, type RuleDefinition } from './configured-build.js';
import type { PublicationRepository } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, githubPublication, immutableUrl, type PublicationTransport } from './publication.js';
import { readRemoteState } from './remote-state.js';
import { manualControl, readActivationOperationResults, type ObservedActivation } from './manual-activation.js';
import { sha256 } from './release.js';

const ajv = new Ajv({ strict: true });
const validateManifest = ajv.compile(manifestSchema);
const validateSubscription = ajv.compile(subscriptionSchema);
const validateSubscriptionV2 = ajv.compile(subscriptionV2Schema);
const requiredFiles = ['domains.json', 'domains.srs', 'manifest.json', 'source.json', 'conversion-report.json', 'build.json', 'readback.json'];
const commitId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

interface CandidateAvailability {
  status: 'available' | 'incomplete' | 'unavailable' | 'verification-pending';
  verification?: 'structural' | 'native'; evidenceUrl?: string; missingFiles?: string[]; error?: string;
}
interface HistoryTarget { commit: string; id: string; candidateId: string }
interface RollbackTarget extends HistoryTarget { candidateEvidenceUrl: string; verification: 'structural' | 'native' }
interface UnavailableTarget extends HistoryTarget { reason: string }
interface ActiveVersion { status: 'activated'; commit: string; activation: Record<string, any>; candidate: CandidateAvailability }
interface PendingOperation { id: string; candidateId?: string; logicalId?: string; phase?: string; status: string; error?: string }

export function activationRecord(value: unknown, path: string, targetBranch: string) {
  requireThat(object(value) && value.schemaVersion === 1 && typeof value.id === 'string' && value.id.length
    && typeof value.candidateId === 'string' && /^[a-f0-9-]+$/.test(value.candidateId)
    && typeof value.candidateEvidenceUrl === 'string' && object(value.files), 'Invalid remote activation record');
  const configured = path !== 'stable/activation.json';
  if (configured) {
    requireThat(typeof value.logicalId === 'string' && /^[a-z][a-z0-9-]*$/.test(value.logicalId)
      && Array.isArray(value.history), 'Invalid configured activation history');
    if (value.control !== undefined) {
      const kind = value.operation === 'rollback' ? 'rollback' : 'activate';
      requireThat(isDeepStrictEqual(value.control, manualControl({ id: value.id, kind })), 'Invalid manual control record');
    }
  } else requireThat(value.logicalId === undefined, 'Invalid legacy activation identity');
  requireThat((configured ? validateSubscriptionV2 : validateSubscription)(value.subscription), 'Invalid remote Rule Subscription');
  const subscription: any = value.subscription;
  requireThat(subscription.systemRuleSetId === (configured ? value.logicalId : 'v2fly:domain-list-community:category-ai-!cn'),
    'Remote subscription identity mismatch');
  requireThat(subscription.projections['dns-response'].unavailable === 'empty'
    && subscription.projections.route.formats && subscription.projections['dns-query'].formats, 'Remote subscription usage mismatch');
  if (configured) requireThat(isDeepStrictEqual(subscription.projections.route.formats, subscription.projections['dns-query'].formats),
    'Remote subscription file reuse mismatch');
  const directory = path.slice(0, -'/activation.json'.length);
  const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${targetBranch}/`;
  const expected = new Map<string, string>();
  for (const usage of ['route', 'dns-query']) {
    for (const [format, endpoint] of Object.entries(subscription.projections[usage].formats) as [string, any][]) {
      requireThat(endpoint.url.startsWith(prefix), 'Unapproved remote subscription host or branch');
      const file = endpoint.url.slice(prefix.length);
      requireThat(/^stable\/[a-z0-9/_.-]+\.(srs|json)$/.test(file) && file !== path
        && !file.split('/').some((part: string) => !part || part === '.' || part === '..'), 'Invalid remote subscription stable path');
      if (configured) requireThat(file === `${directory}/${format === 'binary' ? 'domains.srs' : 'domains.json'}`
        && endpoint.requiredCapabilities.length === 0, 'Remote subscription stable path or capability mismatch');
      const signature = JSON.stringify([format, [...endpoint.requiredCapabilities].sort()]);
      requireThat(!expected.has(file) || expected.get(file) === signature, 'Conflicting remote subscription endpoint declarations');
      expected.set(file, signature);
    }
  }
  requireThat(isDeepStrictEqual(Object.keys(value.files).sort(), [...expected.keys()].sort()), 'Invalid remote activation file set');
  for (const metadata of Object.values(value.files)) {
    requireThat(object(metadata) && /^[a-f0-9]{64}$/.test(metadata.sha256) && Number.isSafeInteger(metadata.byteLength)
      && metadata.byteLength > 0, 'Invalid remote activation file metadata');
  }
  const history: HistoryTarget[] = value.history ?? [];
  requireThat(Array.isArray(history), 'Invalid activation history');
  const ids = new Set<string>();
  for (const item of history) {
    requireThat(object(item) && commitId(item.commit) && typeof item.id === 'string' && item.id.length
      && typeof item.candidateId === 'string' && /^[a-f0-9-]+$/.test(item.candidateId) && !ids.has(item.id), 'Invalid activation history entry');
    ids.add(item.id);
  }
  return { record: value as Record<string, any> & ObservedActivation, history };
}

export async function verifyStableFiles(record: Record<string, any>, read: (path: string) => Promise<Buffer | undefined>) {
  for (const [path, metadata] of Object.entries(record.files) as [string, { sha256: string; byteLength: number }][]) {
    const bytes = await read(path);
    requireThat(bytes && bytes.length === metadata.byteLength && sha256(bytes) === metadata.sha256, `Stable file integrity mismatch: ${path}`);
  }
}

/** Query authoritative Git state. No local receipt participates in this result. */
export async function readRemoteStatus(options: {
  repository: PublicationRepository; binary?: string; publication?: PublicationTransport;
  /** Injected only for isolated reads; production distinguishes Git absence from CDN errors. */
  activation?: Pick<ActivationTransport, 'download'>;
  /** Limit delivery and switch verification to these stable activation paths. */
  recordPaths?: ReadonlySet<string>;
}) {
  const { snapshot, journal } = await readRemoteState(options.repository);
  const publication = options.publication ?? githubPublication();
  const activation = options.activation ?? githubActivation(journal.targetBranch);
  const stable = options.repository.branch === journal.targetBranch ? snapshot : await options.repository.snapshot(journal.targetBranch);
  const candidateAvailability: Record<string, CandidateAvailability> = {};
  const pendingOperations: PendingOperation[] = [];
  const inspectCandidate = async (id: string, evidenceUrl?: string): Promise<CandidateAvailability> => {
    const known = candidateAvailability[id];
    if (known && (!evidenceUrl || known.evidenceUrl === evidenceUrl || known.status !== 'available')) return known;
    const candidate = journal.state.candidates[id];
    const prefix = `candidates/${id}`;
    if (candidate?.retained === false) return candidateAvailability[id] = { status: 'unavailable', error: 'Candidate is no longer retained' };
    const missingFiles = requiredFiles.filter(file => !snapshot.paths.includes(`${prefix}/${file}`));
    if (missingFiles.length) return candidateAvailability[id] = { status: 'incomplete', missingFiles };
    try {
      const files = new Map<string, Buffer>();
      for (const file of requiredFiles) {
        const bytes = await snapshot.read(`${prefix}/${file}`);
        requireThat(bytes?.length, `Missing retained candidate file: ${file}`); files.set(file, bytes);
      }
      const evidence = JSON.parse(files.get('readback.json')!.toString());
      const selectedUrl = evidenceUrl ?? candidate?.evidenceUrl ?? immutableUrl(snapshot.head, `${prefix}/readback.json`);
      const evidencePrefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
      requireThat(selectedUrl.startsWith(evidencePrefix)
        && /^[a-f0-9]{40}$/.test(selectedUrl.slice(evidencePrefix.length).split('/')[0])
        && selectedUrl.slice(evidencePrefix.length + 41) === `${prefix}/readback.json`, 'Invalid candidate evidence URL');
      requireThat(evidence.schemaVersion === 1 && evidence.status === 'remote-verified' && evidence.candidateId === id
        && commitId(evidence.filesCommit) && commitId(evidence.metadataCommit)
        && Array.isArray(evidence.readback) && evidence.readback.length === 6, 'Incomplete candidate evidence');
      for (const file of requiredFiles.filter(name => name !== 'readback.json')) {
        const url = immutableUrl(file.startsWith('domains.') ? evidence.filesCommit : evidence.metadataCommit, `${prefix}/${file}`);
        const matches = evidence.readback.filter((entry: any) => entry?.url === url);
        const bytes = files.get(file)!;
        requireThat(matches.length === 1 && matches[0].exactBytes === true && matches[0].byteLength === bytes.length
          && matches[0].sha256 === sha256(bytes), `Candidate evidence mismatch: ${file}`);
        requireThat((await publication.download(url)).equals(bytes), `Candidate immutable address mismatch: ${file}`);
      }
      requireThat((await publication.download(selectedUrl)).equals(files.get('readback.json')!), 'Candidate evidence address mismatch');
      const manifest = JSON.parse(files.get('manifest.json')!.toString());
      const build = JSON.parse(files.get('build.json')!.toString());
      const source = JSON.parse(files.get('source.json')!.toString());
      requireThat(validateManifest(manifest) && manifest.revision === id && build.candidateId === id
        && build.buildId === evidence.buildId && isDeepStrictEqual(build.source, source), 'Invalid retained candidate records');
      let definition: RuleDefinition | undefined;
      if (build.definition !== undefined) {
        definition = parseBuildConfiguration(JSON.stringify({ schemaVersion: 1, source: 'v2fly/domain-list-community',
          target: build.target, ruleSets: [build.definition] })).ruleSets[0];
        requireThat(build.target.branch === journal.targetBranch && manifest.id === definition.id && build.id === definition.id,
          'Candidate target or logical identity mismatch');
      }
      if (candidate) requireThat(source.releaseId === candidate.releaseId && source.tag === candidate.tag
        && (!candidate.logicalId || candidate.logicalId === manifest.id), 'Candidate source or logical identity mismatch');
      if (options.binary) await verifyActivationCandidate({ candidateEvidenceUrl: selectedUrl, binary: options.binary }, {
        branch: journal.targetBranch, download: url => publication.download(url),
      }, definition, 'rollback');
      return candidateAvailability[id] = { status: 'available', verification: options.binary ? 'native' : 'structural', evidenceUrl: selectedUrl };
    } catch (error) {
      return candidateAvailability[id] = { status: 'verification-pending', error: error instanceof Error ? error.message : String(error) };
    }
  };
  const activeRuleVersions: Record<string, ActiveVersion> = {};
  let activeRuleVersion: ActiveVersion | null = null;
  const rollbackTargets: Record<string, RollbackTarget[]> = {};
  const unavailableRollbackTargets: Record<string, UnavailableTarget[]> = {};
  const historyComplete: Record<string, boolean> = {};
  const historyErrors: Record<string, { commit?: string; error: string }[]> = {};
  const currentByPath = new Map<string, ObservedActivation>();
  const paths = stable.paths.filter(path => (!options.recordPaths || options.recordPaths.has(path)) && /^stable\/(?:[a-z0-9._-]+\/)*activation\.json$/.test(path));
  for (const path of paths) {
    const bytes = await stable.read(path);
    requireThat(bytes, `Missing activation record: ${path}`);
    const { record, history } = activationRecord(JSON.parse(bytes.toString()), path, journal.targetBranch);
    await verifyStableFiles(record, file => stable.read(file));
    currentByPath.set(path, record);
    const candidate = await inspectCandidate(record.candidateId, record.candidateEvidenceUrl);
    const current: ActiveVersion = { status: 'activated', commit: stable.head, activation: record, candidate };
    const id: string = record.logicalId ?? 'v2fly:category-ai-!cn';
    if (candidate.status !== 'available') pendingOperations.push({ id: record.id, candidateId: record.candidateId,
      logicalId: record.logicalId, status: 'activated-verification-pending', error: candidate.error ?? 'Current candidate dependencies are incomplete' });
    requireThat(!Object.hasOwn(activeRuleVersions, id), 'Duplicate active logical ID');
    if (path === 'stable/activation.json') activeRuleVersion = current;
    else activeRuleVersions[id] = current;
    rollbackTargets[id] = []; unavailableRollbackTargets[id] = [];
    historyComplete[id] = true; historyErrors[id] = [];
    const historyError = (commit: unknown, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      historyComplete[id] = false;
      historyErrors[id].push({ ...(typeof commit === 'string' ? { commit } : {}), error: message });
      pendingOperations.push({ id: `history:${id}:${String(commit)}`, logicalId: record.logicalId,
        status: 'history-verification-pending', error: message });
    };
    const inspectHistorical = async (target: HistoryTarget, historical: Record<string, any>) => {
      try {
        requireThat(historical.id === target.id && historical.candidateId === target.candidateId
          && historical.logicalId === record.logicalId, 'Historical activation identity mismatch');
        requireThat(isDeepStrictEqual(historical.subscription, record.subscription), 'Historical subscription is incompatible with current delivery');
        await verifyStableFiles(historical, file => publication.download(immutableUrl(target.commit, file)));
        const available = await inspectCandidate(target.candidateId, historical.candidateEvidenceUrl);
        requireThat(available.status === 'available', available.error ?? 'Historical candidate is incomplete or no longer retained');
        rollbackTargets[id].push({ ...target, candidateEvidenceUrl: historical.candidateEvidenceUrl, verification: available.verification! });
      } catch (error) {
        unavailableRollbackTargets[id].push({ ...target, reason: error instanceof Error ? error.message : String(error) });
      }
    };
    if (path === 'stable/activation.json') {
      // Legacy activations predate the explicit per-set history index. Every
      // record identifies its old branch head, including the first activation.
      let previous: unknown = record.expectedHead;
      const seenCommits = new Set([stable.head]), seenIds = new Set([record.id]);
      while (true) {
        if (!commitId(previous) || seenCommits.has(previous)) {
          historyError(previous, new Error('Invalid or cyclic legacy activation history')); break;
        }
        seenCommits.add(previous);
        const url = immutableUrl(previous, path);
        let bytes: Buffer;
        try { bytes = await activation.download(url); }
        catch (error) {
          // githubActivation emits this exact absence only after an immutable
          // Git tree proves there was no activation. A missing commit or a CDN
          // failure cannot establish the beginning of the history.
          if (error instanceof Error && error.message === `Readback HTTP 404: ${url}`) break;
          historyError(previous, error); break;
        }
        let historical: Record<string, any>;
        try {
          historical = activationRecord(JSON.parse(bytes.toString()), path, journal.targetBranch).record;
          requireThat(historical.logicalId === undefined && !seenIds.has(historical.id), 'Invalid or cyclic legacy activation identity');
          seenIds.add(historical.id);
        } catch (error) { historyError(previous, error); break; }
        await inspectHistorical({ commit: previous, id: historical.id, candidateId: historical.candidateId }, historical);
        previous = historical.expectedHead;
      }
    } else for (const target of history) {
      try {
        const historical = activationRecord(JSON.parse((await activation.download(immutableUrl(target.commit, path))).toString()), path, journal.targetBranch).record;
        await inspectHistorical(target, historical);
      } catch (error) {
        unavailableRollbackTargets[id].push({ ...target, reason: error instanceof Error ? error.message : String(error) });
        historyError(target.commit, error);
      }
    }
  }
  for (const candidate of options.recordPaths ? [] : Object.values(journal.state.candidates)) {
    const availability = await inspectCandidate(candidate.id);
    if (candidate.retained && (candidate.phase !== 'complete' || availability.status !== 'available')) {
      pendingOperations.push({ id: candidate.id, candidateId: candidate.id, logicalId: candidate.logicalId,
        phase: candidate.phase, status: availability.status === 'available' ? 'verification-pending' : availability.status,
        ...(availability.error ? { error: availability.error } : {}) });
    }
  }
  const operation = journal.state.pendingOperation;
  if (operation?.status === 'pending') pendingOperations.unshift({ id: operation.id, status: 'pending' });
  const operations = await readActivationOperationResults(options.repository, journal, stable, currentByPath,
    url => activation.download(url), [...Object.values(journal.manualOperations ?? {}), ...Object.values(journal.automaticOperations ?? {})]
      .filter(operation => !options.recordPaths || options.recordPaths.has(operation.recordPath)));
  const manualOperations = operations.filter(operation => operation.kind !== 'automatic');
  const automaticOperations = operations.filter(operation => operation.kind === 'automatic');
  for (const operation of operations) {
    if (operation.status === 'pending') pendingOperations.push({ id: operation.id, logicalId: operation.logicalId,
      candidateId: operation.candidateId, status: (operation.commit || operation.containingCommit) ? 'activated-readback-pending' : operation.kind === 'automatic' ? 'automatic-commit-pending' : 'manual-commit-pending',
      ...(operation.error ? { error: operation.error } : {}) });
  }
  return { authority: 'remote' as const, head: snapshot.head, stableHead: stable.head, generation: journal.generation,
    maintenance: journal.maintenance, state: journal.state, activeRuleVersion,
    activeRuleVersions, rollbackTargets, unavailableRollbackTargets, candidateAvailability, manualOperations, automaticOperations, pendingOperations,
    historyComplete, historyErrors };
}
