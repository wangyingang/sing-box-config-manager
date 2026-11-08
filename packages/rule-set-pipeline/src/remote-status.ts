import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import manifestSchema from '../contracts/artifact-manifest.schema.json' with { type: 'json' };
import subscriptionSchema from '../contracts/rule-subscription.schema.json' with { type: 'json' };
import subscriptionV2Schema from '../contracts/rule-subscription-v2.schema.json' with { type: 'json' };
import { candidateFiles } from './candidate-publication.js';
import { verifyActivationCandidate, verifyCandidateEvidence } from './activation.js';
import { githubActivation, type ActivationTransport } from './activation-transport.js';
import { parseRuleDefinition, type RuleDefinition } from './configuration.js';
import { retainedCandidateDownload, type PublicationRepository } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, githubPublication, immutableUrl, type PublicationTransport } from './publication.js';
import { readRemoteState } from './remote-state.js';
import { applicableResume, effectiveControl, manualControl, readActivationOperationResults, type ObservedActivation } from './manual-activation.js';
import { sha256 } from './release.js';

const ajv = new Ajv({ strict: true });
const validateManifest = ajv.compile(manifestSchema);
const validateSubscription = ajv.compile(subscriptionSchema);
const validateSubscriptionV2 = ajv.compile(subscriptionV2Schema);
export const candidateEvidenceFiles = candidateFiles();
const commitId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

interface CandidateAvailability {
  status: 'available' | 'incomplete' | 'unavailable' | 'verification-pending';
  verification?: 'structural' | 'native'; evidenceUrl?: string; missingFiles?: string[]; error?: string;
}
export interface HistoryTarget { commit: string; id: string; candidateId: string }
interface RollbackTarget extends HistoryTarget { candidateEvidenceUrl: string; verification: 'structural' | 'native' }
interface UnavailableTarget extends HistoryTarget { reason: string }
interface ActiveVersion { status: 'activated'; commit: string; activation: Record<string, any>; candidate: CandidateAvailability; control?: ReturnType<typeof effectiveControl> }
export interface PendingOperation { id: string; candidateId?: string; logicalId?: string; phase?: string; status: string; error?: string }

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
  const expected = new Map<string, { signature: string; candidateFile: string }>();
  for (const usage of ['route', 'dns-query']) {
    for (const [format, endpoint] of Object.entries(subscription.projections[usage].formats) as [string, any][]) {
      requireThat(endpoint.url.startsWith(prefix), 'Unapproved remote subscription host or branch');
      const file = endpoint.url.slice(prefix.length);
      requireThat(/^stable\/[a-z0-9/_.-]+\.(srs|json)$/.test(file) && file !== path
        && !file.split('/').some((part: string) => !part || part === '.' || part === '..'), 'Invalid remote subscription stable path');
      if (configured) requireThat(file === `${directory}/${format === 'binary' ? 'domains.srs' : 'domains.json'}`
        && endpoint.requiredCapabilities.length === 0, 'Remote subscription stable path or capability mismatch');
      const signature = JSON.stringify([format, [...endpoint.requiredCapabilities].sort()]);
      requireThat(!expected.has(file) || expected.get(file)?.signature === signature, 'Conflicting remote subscription endpoint declarations');
      expected.set(file, { signature, candidateFile: format === 'binary' ? 'domains.srs' : 'domains.json' });
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
  return { record: value as Record<string, any> & ObservedActivation, history,
    candidateFiles: Object.fromEntries([...expected].map(([path, { candidateFile }]) => [path, candidateFile])) };
}

/** Legacy records link to the head that preceded each activation. */
export async function* walkLegacyActivationHistory(record: ReturnType<typeof activationRecord>['record'], head: string,
  targetBranch: string, download: ActivationTransport['download']): AsyncGenerator<
    { commit: string; record: ReturnType<typeof activationRecord>['record'] } | { commit: unknown; error: unknown }> {
  const path = 'stable/activation.json';
  const seenCommits = new Set([head]), seenIds = new Set([record.id]);
  let previous: unknown = record.expectedHead;
  while (true) {
    if (!commitId(previous) || seenCommits.has(previous)) {
      yield { commit: previous, error: new Error('Invalid or cyclic legacy activation history') };
      return;
    }
    seenCommits.add(previous);
    const url = immutableUrl(previous, path);
    try {
      const historical = activationRecord(JSON.parse((await download(url)).toString()), path, targetBranch).record;
      requireThat(historical.logicalId === undefined && !seenIds.has(historical.id), 'Invalid or cyclic legacy activation identity');
      seenIds.add(historical.id);
      yield { commit: previous, record: historical };
      previous = historical.expectedHead;
    } catch (error) {
      // The exact absence is emitted only when an immutable Git tree has no activation.
      if (!(error instanceof Error && error.message === `Readback HTTP 404: ${url}`)) yield { commit: previous, error };
      return;
    }
  }
}

export async function verifyStableFiles(record: Record<string, any>, read: (path: string) => Promise<Buffer | undefined>) {
  for (const [path, metadata] of Object.entries(record.files) as [string, { sha256: string; byteLength: number }][]) {
    const bytes = await read(path);
    requireThat(bytes && bytes.length === metadata.byteLength && sha256(bytes) === metadata.sha256, `Stable file integrity mismatch: ${path}`);
  }
}

async function readStatusSnapshots(repository: PublicationRepository) {
  // A split-branch switch can happen between the two reads. Re-read the
  // journal head before using the pair so a new stable head cannot be
  // interpreted against the previous generation's state.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { snapshot, journal } = await readRemoteState(repository);
    if (repository.branch === journal.targetBranch) return { snapshot, journal, stable: snapshot };
    const stable = await repository.snapshot(journal.targetBranch);
    if ((await repository.snapshot()).head === snapshot.head) return { snapshot, journal, stable };
  }
  throw new Error('PUBLICATION_CONFLICT: remote heads changed during status read');
}

/** Query authoritative Git state. No local receipt participates in this result. */
export async function readRemoteStatus(options: {
  repository: PublicationRepository; binary?: string; publication?: PublicationTransport;
  /** Injected only for isolated reads; production distinguishes Git absence from CDN errors. */
  activation?: Pick<ActivationTransport, 'download'>;
  /** Limit delivery and switch verification to these stable activation paths. */
  recordPaths?: ReadonlySet<string>;
  /** Verify current delivery and in-flight writes, while only inventorying discardable history. */
  maintenanceInventory?: true;
}) {
  const { snapshot, journal, stable } = await readStatusSnapshots(options.repository);
  const publication = options.publication ?? githubPublication();
  const activation = options.activation ?? githubActivation(journal.targetBranch);
  const candidateAvailability: Record<string, CandidateAvailability> = {};
  const pendingOperations: PendingOperation[] = [];
  const inspectCandidate = async (id: string, evidenceUrl?: string, native = true): Promise<CandidateAvailability> => {
    const known = candidateAvailability[id];
    if (known && (!evidenceUrl || known.evidenceUrl === evidenceUrl || known.status !== 'available')) return known;
    const candidate = journal.state.candidates[id];
    const prefix = `candidates/${id}`;
    if (candidate?.retained === false) return candidateAvailability[id] = { status: 'unavailable', error: 'Candidate is no longer retained' };
    const git = candidate?.sourceKey !== undefined;
    const missingFiles = candidateFiles(candidate?.definition).filter(file => !snapshot.paths.includes(`${prefix}/${file}`));
    if (missingFiles.length) return candidateAvailability[id] = { status: 'incomplete', missingFiles };
    try {
      if (git) {
        const selectedUrl = evidenceUrl ?? candidate.evidenceUrl ?? immutableUrl(snapshot.head, `${prefix}/readback.json`);
        const verified = await verifyCandidateEvidence({ candidateEvidenceUrl: selectedUrl, binary: native ? options.binary : undefined,
          evidenceSha256: candidate.evidenceSha256 }, {
          branch: journal.targetBranch, download: retainedCandidateDownload(snapshot, id, url => publication.download(url)),
        }, candidate.definition);
        const pin = journal.state.commitPins?.[candidate.sourceKey];
        requireThat(verified.candidateId === id && isDeepStrictEqual(verified.source, pin?.source)
          && verified.buildId === candidate.buildId, 'Candidate source or build identity mismatch');
        return candidateAvailability[id] = { status: 'available', verification: verified.validation ? 'native' : 'structural', evidenceUrl: selectedUrl };
      }
      const files = new Map<string, Buffer>();
      for (const file of candidateEvidenceFiles) {
        const bytes = await snapshot.read(`${prefix}/${file}`);
        requireThat(bytes?.length, `Missing retained candidate file: ${file}`); files.set(file, bytes);
      }
      const evidence = JSON.parse(files.get('readback.json')!.toString());
      const evidencePath = `${prefix}/readback.json`;
      const selectedUrl = evidenceUrl ?? candidate?.evidenceUrl ?? immutableUrl(
        (options.maintenanceInventory && await options.repository.lastChange?.(snapshot.head, evidencePath)) || snapshot.head, evidencePath);
      const evidencePrefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
      requireThat(selectedUrl.startsWith(evidencePrefix)
        && /^[a-f0-9]{40}$/.test(selectedUrl.slice(evidencePrefix.length).split('/')[0])
        && selectedUrl.slice(evidencePrefix.length + 41) === `${prefix}/readback.json`, 'Invalid candidate evidence URL');
      requireThat(evidence.schemaVersion === 1 && evidence.status === 'remote-verified' && evidence.candidateId === id
        && commitId(evidence.filesCommit) && commitId(evidence.metadataCommit)
        && Array.isArray(evidence.readback) && evidence.readback.length === 6, 'Incomplete candidate evidence');
      for (const file of candidateEvidenceFiles.filter(name => name !== 'readback.json')) {
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
        definition = parseRuleDefinition(build.definition);
        requireThat(build.target?.repository === ARTIFACT_REPOSITORY && build.target.branch === journal.targetBranch && manifest.id === definition.id && build.id === definition.id,
          'Candidate target or logical identity mismatch');
      }
      if (candidate) requireThat(source.releaseId === candidate.releaseId && source.tag === candidate.tag
        && (!candidate.logicalId || candidate.logicalId === manifest.id), 'Candidate source or logical identity mismatch');
      if (native && options.binary) await verifyActivationCandidate({ candidateEvidenceUrl: selectedUrl, binary: options.binary }, {
        branch: journal.targetBranch, download: url => publication.download(url),
      }, definition, 'rollback');
      return candidateAvailability[id] = { status: 'available', verification: native && options.binary ? 'native' : 'structural', evidenceUrl: selectedUrl };
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
  const historicalActivations: Record<string, HistoryTarget[]> = {};
  const currentByPath = new Map<string, ReturnType<typeof activationRecord>['record']>();
  const paths = stable.paths.filter(path => (!options.recordPaths || options.recordPaths.has(path)) && /^stable\/(?:[a-z0-9._-]+\/)*activation\.json$/.test(path));
  for (const path of paths) {
    const bytes = await stable.read(path);
    requireThat(bytes, `Missing activation record: ${path}`);
    const { record, history, candidateFiles } = activationRecord(JSON.parse(bytes.toString()), path, journal.targetBranch);
    await verifyStableFiles(record, file => stable.read(file));
    currentByPath.set(path, record);
    const candidate = await inspectCandidate(record.candidateId, record.candidateEvidenceUrl);
    if (options.maintenanceInventory && candidate.status === 'available') {
      for (const [file, source] of Object.entries(candidateFiles)) {
        const expected = record.files[file];
        const bytes = await snapshot.read(`candidates/${record.candidateId}/${source}`);
        if (!bytes || bytes.length !== expected.byteLength || sha256(bytes) !== expected.sha256) {
          pendingOperations.push({ id: record.id, status: 'current-evidence-mismatch', error: `${path}: ${file}` });
        }
      }
    }
    const current: ActiveVersion = { status: 'activated', commit: stable.head, activation: record, candidate };
    const id: string = record.logicalId ?? 'v2fly:category-ai-!cn';
    if (candidate.status !== 'available') pendingOperations.push({ id: record.id, candidateId: record.candidateId,
      logicalId: record.logicalId, status: 'activated-verification-pending', error: candidate.error ?? 'Current candidate dependencies are incomplete' });
    requireThat(!Object.hasOwn(activeRuleVersions, id), 'Duplicate active logical ID');
    if (path === 'stable/activation.json') activeRuleVersion = current;
    else {
      current.control = effectiveControl(journal, id, record);
      const resume = applicableResume(journal, id, record);
      if (resume?.checkPending) pendingOperations.push({ id: resume.revision, logicalId: id, status: 'resume-check-pending' });
      activeRuleVersions[id] = current;
    }
    rollbackTargets[id] = []; unavailableRollbackTargets[id] = [];
    historicalActivations[path] = [];
    historyComplete[id] = true; historyErrors[id] = [];
    const historyError = (commit: unknown, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      historyComplete[id] = false;
      historyErrors[id].push({ ...(typeof commit === 'string' ? { commit } : {}), error: message });
      pendingOperations.push({ id: `history:${id}:${String(commit)}`, logicalId: record.logicalId,
        status: 'history-verification-pending', error: message });
    };
    const inspectHistorical = async (target: HistoryTarget, historical: Record<string, any>) => {
      if (options.maintenanceInventory) {
        historicalActivations[path].push(target);
        return;
      }
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
      for await (const item of walkLegacyActivationHistory(record, stable.head, journal.targetBranch, url => activation.download(url))) {
        if ('error' in item) { historyError(item.commit, item.error); break; }
        const { commit, record: historical } = item;
        await inspectHistorical({ commit, id: historical.id, candidateId: historical.candidateId }, historical);
      }
    } else for (const target of history) {
      if (options.maintenanceInventory) {
        historicalActivations[path].push(target);
        continue;
      }
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
    if (options.maintenanceInventory && candidate.phase === 'complete') continue;
    const availability = await inspectCandidate(candidate.id);
    if (candidate.retained && (candidate.phase !== 'complete' || availability.status !== 'available')) {
      pendingOperations.push({ id: candidate.id, candidateId: candidate.id, logicalId: candidate.logicalId,
        phase: candidate.phase, status: availability.status === 'available' ? 'verification-pending' : availability.status,
        ...(availability.error ? { error: availability.error } : {}) });
    }
  }
  if (options.maintenanceInventory) {
    // Pre-journal candidates can have an evidence file whose final HTTPS
    // readback never completed. File names alone do not establish completion.
    const ids = new Set(snapshot.paths.flatMap(path => /^candidates\/([a-f0-9-]+)\//.exec(path)?.[1] ?? []));
    for (const id of ids) {
      if (!journal.state.candidates[id] && !candidateAvailability[id]) await inspectCandidate(id, undefined, false);
    }
  }
  const operation = journal.state.pendingOperation;
  if (operation?.status === 'pending') pendingOperations.unshift({ id: operation.id, status: 'pending' });
  for (const parked of journal.parkedOperations ?? []) pendingOperations.push({ id: parked.id, status: 'parked' });
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
    historyComplete, historyErrors,
    ...(options.maintenanceInventory ? { inventory: { targetBranch: journal.targetBranch, snapshot, stable, currentByPath, historicalActivations, resumes: journal.resumes ?? {} } } : {}) };
}
