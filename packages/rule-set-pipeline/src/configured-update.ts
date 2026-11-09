import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredInput } from './configuration.js';
import { buildConfiguredCommit, buildConfiguredRelease, CONFIGURED_BUILD_RECORD, parseBuildConfiguration } from './configured-build.js';
import { publishCandidate } from './candidate-publication.js';
import { githubPublication, immutableUrl, type PublicationTransport } from './publication.js';
import { lookupRelease, type ReleaseInput } from './release.js';
import { commitSourceKey, fullGitCommit, resolveCommit, withCommitCheckpoint, type CommitInput, type CommitSourceRecord } from './github-commit.js';
import type { SourceRecord } from './types.js';
import { readUpdateState, ruleDefinitionSha256, sourceReferenceKey, type Candidate, type SourceReference, type UpdateState } from './update.js';
import { openRemoteSession, selectRemoteOperation, type RemoteOperation } from './remote-state.js';
import { verifyRetainedCandidate } from './candidate-recovery.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
type Pin = Pick<SourceRecord, 'repository' | 'releaseId' | 'tag' | 'commit' | 'yaml' | 'checksum'>;
const canonicalPin = (value: Pin) => JSON.stringify([value.repository, value.releaseId, value.tag, value.commit,
  value.yaml.id, value.yaml.name, value.yaml.url, value.checksum.id, value.checksum.name, value.checksum.url]);

export interface ConfiguredUpdateOptions {
  stateDirectory: string; binary: string; configuration: string; selectedIds?: string[];
  token?: string; fetch?: typeof fetch; publication?: PublicationTransport;
  /** Fixed official sample acceptance; normal CLI update never accepts a tag. */
  sampleTag?: string;
  /** Retry selected sets against a previously pinned and fully checked Release. */
  retryRelease?: string;
}
type FixedVersion = { release: string; commit?: never } | { commit: string; release?: never };
export type ConfiguredRebuildOptions = Omit<ConfiguredUpdateOptions, 'sampleTag' | 'retryRelease'>
  & FixedVersion & { selectedIds: string[] };
type BatchEntry = { id: string; status: 'skipped'; candidateId: string; evidenceUrl: string }
  | { id: string; status: 'processed'; candidate: Candidate; readback: { url: string; sha256: string; byteLength: number; exactBytes: true }[] }
  | { id: string; status: 'failed'; candidateId: string; candidate?: Candidate; error: string };

export async function processConfiguredUpdate(options: ConfiguredUpdateOptions, rebuild?: FixedVersion) {
  const configuration = parseBuildConfiguration(options.configuration);
  const selected = options.selectedIds;
  if (selected && (selected.length === 0 || new Set(selected).size !== selected.length ||
      selected.some(id => !configuration.ruleSets.some(rule => rule.id === id)))) {
    throw new Error('Selected logical ID is duplicate or unknown');
  }
  if (options.retryRelease && (!selected || options.retryRelease.toLowerCase() === 'latest' || options.sampleTag)) {
    throw new Error('Fixed Release retry requires selected logical IDs and a prior pin');
  }
  if (rebuild && (!selected?.length || options.retryRelease || options.sampleTag)) {
    throw new Error('Configured rebuild requires selected logical IDs and a fixed source');
  }
  const definitions = selected ? configuration.ruleSets.filter(rule => selected.includes(rule.id)) : configuration.ruleSets;
  const source = configuredInput(configuration, definitions);
  const git = source.version === 'git-branch';
  if (git ? options.sampleTag || options.retryRelease || rebuild?.release !== undefined
    : rebuild?.commit !== undefined) throw new Error('Use a fixed version matching the configured source (--commit or --release)');
  if (rebuild?.commit !== undefined && !fullGitCommit(rebuild.commit)) throw new Error('Expected a full lowercase commit SHA');
  await mkdir(options.stateDirectory, { recursive: true });
  const lock = join(options.stateDirectory, 'update.lock');
  await mkdir(lock);
  try {
    const transport = options.publication ?? githubPublication(undefined,
      configuration.target.branch === 'main' ? 'candidates' : configuration.target.branch);
    const session = transport.repository ? await openRemoteSession(transport, options.stateDirectory, configuration.target.branch) : undefined;
    if (git && !session) throw new Error('Git candidate publication requires a remote journal');
    const publication = session?.publication ?? transport;
    const state: UpdateState = session?.state ?? (await readUpdateState(options.stateDirectory)).state;
    const fixedTag = rebuild?.release ?? options.retryRelease;
    const matches = (entry: RemoteOperation) => entry.kind === (rebuild ? 'rebuild' : 'update') && entry.configuration
      && JSON.stringify(parseBuildConfiguration(entry.configuration)) === JSON.stringify(configuration)
      && definitions.every(rule => !entry.selectedIds || entry.selectedIds.includes(rule.id))
      && (entry.sourceKey !== undefined) === git
      && (!fixedTag || fixedTag === entry.tag) && (!rebuild?.commit || (entry.sourceKey && state.commitPins?.[entry.sourceKey]?.identity.commit === rebuild.commit));
    const recovery = session && selectRemoteOperation(session.journal, matches);
    if (recovery && (recovery.sourcePins !== undefined || !matches(recovery)) || !recovery && session?.journal.parkedOperations?.length) {
      throw new Error('RECOVERY_REQUEST_MISMATCH: resume the registered operation with its original configuration and selection');
    }
    state.configuredProcessed ??= {};
    const processedFor = (id: string) => Object.hasOwn(state.configuredProcessed!, id) ? state.configuredProcessed![id] : undefined;
    const definitionHash = (definition: typeof definitions[number]) => ruleDefinitionSha256(definition, configuration.target);
    const operationFinished = () => {
      const operation = state.pendingOperation!;
      if (operation.sourcePins !== undefined) throw new Error('Expected a single-source candidate operation');
      return configuration.ruleSets.filter(rule => !operation.selectedIds || operation.selectedIds.includes(rule.id)).every(rule => {
        const completed = Object.values(state.candidates).some(candidate => candidate.operationId === operation.id
          && candidate.logicalId === rule.id && candidate.retained && candidate.phase === 'complete' && candidate.status === 'verified');
        const previous = processedFor(rule.id)?.[sourceReferenceKey(operation)];
        return completed || operation.kind === 'update' && previous?.definitionSha256 === definitionHash(rule)
          && state.candidates[previous.candidateId]?.retained === true && state.candidates[previous.candidateId]?.phase === 'complete';
      });
    };
    const save = session?.save ?? (async () => {
      const temporary = join(options.stateDirectory, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, encode(state));
      await rename(temporary, join(options.stateDirectory, 'update-state.json'));
    });
    const recoveredResults: BatchEntry[] = [];
    const verify = (candidate: Candidate, definition: typeof definitions[number], allowEvidence = false) =>
      verifyRetainedCandidate({ candidate, source: candidate.sourceKey === undefined ? state.pinned[String(candidate.releaseId)]?.source : state.commitPins?.[candidate.sourceKey]?.source, snapshot: session!.snapshot,
        publication, binary: options.binary, targetBranch: configuration.target.branch, definition, allowEvidence });
    const requireRebuildHistory = async (reference: SourceReference) => {
      for (const definition of definitions) {
        const previous = processedFor(definition.id)?.[sourceReferenceKey(reference)];
        if (!previous || previous.definitionSha256 !== definitionHash(definition)) {
          throw new Error('Configured rebuild requires a successfully processed rule definition at the fixed source');
        }
        if (session && !recovery) {
          const candidate = state.candidates[previous.candidateId];
          if (!candidate || candidate.phase !== 'complete') throw new Error('CANDIDATE_UNAVAILABLE: rebuild history is no longer retained');
          await verify(candidate, definition);
        }
      }
    };
    const retryTag = recovery?.tag ?? fixedTag;
    const retryRelease = retryTag
      ? Object.values(state.pinned).find(entry => entry.identity?.tag === retryTag && (recovery || entry.source))
      : undefined;
    if (retryTag && !retryRelease?.identity) throw new Error('Fixed Release requires a previously pinned source');
    if (rebuild?.release) await requireRebuildHistory(retryRelease!.identity!);
    if (session && recovery) {
      for (const definition of definitions) {
        const candidate = Object.values(state.candidates).find(value => value.operationId === recovery.id && value.logicalId === definition.id);
        if (!candidate || !['evidence', 'complete'].includes(candidate.phase!)) continue;
        const { readback } = await verify(candidate, definition, true);
        candidate.status = 'verified'; candidate.phase = 'complete'; delete candidate.error;
        if (!rebuild) {
          if (!processedFor(definition.id)) state.configuredProcessed[definition.id] = {};
          state.configuredProcessed[definition.id][sourceReferenceKey(recovery)] = { candidateId: candidate.id, tag: recovery.tag,
            evidenceUrl: candidate.evidenceUrl!, definitionSha256: definitionHash(definition) };
        }
        recoveredResults.push({ id: definition.id, status: 'processed', candidate, readback });
      }
      if (recoveredResults.length) {
        if (operationFinished()) recovery.status = 'complete';
        await save();
        if (recoveredResults.length === definitions.length) {
          await session.confirmGeneration();
          return { status: 'processed', ...versionFields(recovery, state),
            results: recoveredResults, ...(session.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
        }
      }
    }
    const prepared = source.version === 'git-branch'
      ? await prepareCommit(source, options, state, recovery, rebuild?.commit, save)
      : await prepareRelease(source, options, state, retryRelease, save);
    const { pin, build } = prepared;
    const reference: SourceReference = prepared.reference;
    const key = sourceReferenceKey(reference);
    if (rebuild?.commit) await requireRebuildHistory(reference);
    if (session && !recovery) state.pendingOperation = { id: randomUUID(), kind: rebuild ? 'rebuild' : 'update',
      generation: session.generation, expectedHead: session.snapshot.head, candidateIds: [], ...reference,
      status: 'pending', configuration: options.configuration, selectedIds: selected };
    const results: BatchEntry[] = [...recoveredResults];
    const pending = [] as typeof definitions;
    for (const definition of definitions) {
      if (recoveredResults.some(result => result.id === definition.id)) continue;
      if (rebuild) { pending.push(definition); continue; }
      const existing = processedFor(definition.id)?.[key];
      const definitionSha256 = definitionHash(definition);
      if (!existing || existing.definitionSha256 !== definitionSha256 || !pin.source) { pending.push(definition); continue; }
      let evidenceUrl = existing.evidenceUrl;
      if (session) {
        const candidate = state.candidates[existing.candidateId];
        if (!candidate || candidate.phase !== 'complete') throw new Error('CANDIDATE_UNAVAILABLE: processed candidate is incomplete');
        const { verified } = await verify(candidate, definition);
        evidenceUrl = verified.evidenceUrl;
      }
      if (!evidenceUrl) throw new Error('CANDIDATE_UNAVAILABLE: processed candidate has no retained address');
      results.push({ id: definition.id, status: 'skipped', candidateId: existing.candidateId, evidenceUrl });
    }
    if (pending.length) {
      const built = await build(pending.map(rule => rule.id));
      for (const result of built.results) {
        const previousProcessed = processedFor(result.id)?.[key];
        const recovering = session && Object.values(state.candidates).find(candidate => candidate.operationId === state.pendingOperation!.id && candidate.logicalId === result.id);
        const candidate: Candidate = recovering || { id: randomUUID(), logicalId: result.id, ...reference,
          status: 'building', operation: rebuild ? 'rebuild' : 'update', previousCandidateId: previousProcessed?.candidateId,
          ...(session ? { generation: session.generation, phase: 'registered' as const, retained: true,
            definition: result.definition, targetBranch: configuration.target.branch, operationId: state.pendingOperation!.id } : {}) };
        if (session && !candidate.retained) throw new Error('CANDIDATE_UNAVAILABLE: registered candidate has been removed');
        state.candidates[candidate.id] = candidate;
        if (session && !state.pendingOperation!.candidateIds.includes(candidate.id)) state.pendingOperation!.candidateIds.push(candidate.id);
        await save();
        if (result.status === 'failed') {
          candidate.status = 'failed'; candidate.error = `${result.error}: ${JSON.stringify(result.report.diagnostics)}`;
          await save();
          results.push({ id: result.id, status: 'failed', candidateId: candidate.id, candidate, error: candidate.error });
          continue;
        }
        try {
          if (candidate.buildId && candidate.buildId !== result.buildId) throw new Error('RECOVERY_BUILD_CHANGED: original tool and build identity required');
          candidate.buildId = result.buildId;
          const readback = await publishConfiguredCandidate(result, candidate, built.source, built.tools, configuration.target, publication, options.binary, save);
          candidate.status = 'verified'; delete candidate.error;
          if (session) candidate.phase = 'complete';
          if (!rebuild) {
            if (!processedFor(result.id)) state.configuredProcessed[result.id] = {};
            state.configuredProcessed[result.id][key] = { candidateId: candidate.id, tag: reference.tag,
              evidenceUrl: candidate.evidenceUrl!, definitionSha256: definitionHash(result.definition) };
          }
          await save();
          results.push({ id: result.id, status: 'processed', candidate, readback });
        } catch (error) {
          if (session && /PUBLICATION_(CONFLICT|PENDING)/.test(String(error))) throw error;
          const records = processedFor(result.id);
          if (records) {
            if (previousProcessed) records[key] = previousProcessed;
            else delete records[key];
          }
          candidate.status = 'failed'; candidate.error = error instanceof Error ? error.message : String(error);
          await save();
          results.push({ id: result.id, status: 'failed', candidateId: candidate.id, candidate, error: candidate.error });
        }
      }
    }
    results.sort((a, b) => definitions.findIndex(rule => rule.id === a.id) - definitions.findIndex(rule => rule.id === b.id));
    const failed = results.filter(entry => entry.status === 'failed').length;
    if (session && !failed) { state.pendingOperation!.status = operationFinished() ? 'complete' : 'pending'; await save(); }
    await session?.confirmGeneration();
    return { status: failed ? (failed === results.length ? 'failed' : 'partial') : pending.length ? 'processed' : 'skipped',
      ...versionFields(reference, state), results, ...(session?.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
  } finally { await rm(lock, { recursive: true, force: true }); }
}

function versionFields(reference: SourceReference, state: UpdateState) {
  return reference.sourceKey === undefined ? { releaseId: reference.releaseId, tag: reference.tag }
    : { sourceKey: reference.sourceKey, commit: state.commitPins![reference.sourceKey].identity.commit };
}

async function prepareCommit(source: CommitInput, options: ConfiguredUpdateOptions, state: UpdateState,
  recovery: RemoteOperation | undefined, fixed: string | undefined, save: () => Promise<void>) {
  const pins = state.commitPins ??= {};
  const fixedPin = recovery?.sourceKey ? pins[recovery.sourceKey]
    : fixed ? Object.values(pins).find(pin => pin.identity.commit === fixed && pin.identity.repository === source.repository
      && pin.identity.branch === source.branch && pin.identity.file.path === source.input.path && pin.source) : undefined;
  if ((fixed || recovery) && !fixedPin) throw new Error('CANDIDATE_UNAVAILABLE: fixed Git commit has no retained source');
  const network = { fetch: options.fetch, token: options.token };
  const identity = fixedPin?.identity ?? await resolveCommit(source, network);
  const sourceKey = commitSourceKey(identity);
  const pin = pins[sourceKey] ?? { identity };
  return { reference: { sourceKey }, pin, async build(selectedIds: string[]) {
    pins[sourceKey] = pin;
    await save();
    return buildConfiguredCommit({ configuration: options.configuration, selectedIds, binary: options.binary,
      github: withCommitCheckpoint(network, { identity, expectedSource: pin.source,
        onSource: async checked => { pin.source ??= checked; await save(); },
      }),
    });
  } };
}

async function prepareRelease(source: ReleaseInput, options: ConfiguredUpdateOptions, state: UpdateState,
  retryPin: UpdateState['pinned'][string] | undefined, save: () => Promise<void>) {
  const fixedTag = retryPin?.identity?.tag;
  const endpoint = retryPin ? String(retryPin.identity!.releaseId)
    : options.sampleTag ? `tags/${encodeURIComponent(options.sampleTag)}` : 'latest';
  const release = await lookupRelease(source, endpoint, options);
  if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || typeof release.tag_name !== 'string' ||
      (options.sampleTag && release.tag_name !== options.sampleTag) ||
      (fixedTag && (release.id !== retryPin!.identity!.releaseId || release.tag_name !== fixedTag))) {
    throw new Error('SOURCE_CHANGED: fixed Release identity changed');
  }
  const releaseId = Number(release.id), tag = release.tag_name;
  const previousTag = Object.values(state.pinned).find(entry => entry.identity?.tag === tag && entry.identity.releaseId !== releaseId);
  if (previousTag) throw new Error('SOURCE_CHANGED: fixed tag now identifies a different Release');
  const pin = state.pinned[String(releaseId)] ??= {};
  if (pin.identity && (pin.identity.tag !== tag || !Array.isArray(release.assets) || [pin.identity.yaml, pin.identity.checksum].some(asset => {
    const matches = (release.assets as Record<string, unknown>[]).filter(entry => entry.name === asset.name);
    return matches.length !== 1 || matches[0].id !== asset.id || matches[0].browser_download_url !== asset.url;
  }))) throw new Error('SOURCE_CHANGED: processed Release assets changed');
  return { reference: { releaseId, tag }, pin, build: (selectedIds: string[]) => buildConfiguredRelease({
    configuration: options.configuration, selectedIds, binary: options.binary,
    release: { tag, releaseMetadata: release, expectedSource: pin.source, fetch: options.fetch, token: options.token,
      onPinned: async identity => {
        if (pin.identity && canonicalPin(pin.identity) !== canonicalPin(identity)) throw new Error('SOURCE_CHANGED: pinned Release identity changed');
        pin.identity ??= identity; await save();
      },
      onSource: async checked => { pin.source ??= checked; await save(); },
    },
  }) };
}

export async function publishConfiguredCandidate(result: Extract<Awaited<ReturnType<typeof buildConfiguredRelease>>['results'][number], { status: 'built-validated' }>,
  candidate: Candidate, source: SourceRecord | CommitSourceRecord, tools: Record<string, string | number>, target: { repository: string; branch: string },
  publication: PublicationTransport, binary: string, save: () => Promise<void>) {
  const prefix = `candidates/${candidate.id}`;
  return publishCandidate({ candidate, native: result.native, buildId: result.buildId, binary, publication, save,
    records: filesCommit => {
      const artifactId = (file: string) => `${result.id}@${candidate.id}:${file}`;
      const manifest = { schemaVersion: 1, id: result.id, revision: candidate.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
        artifacts: result.native.artifacts.map(artifact => ({ id: artifactId(artifact.file), format: artifact.format,
          url: immutableUrl(filesCommit, `${prefix}/${artifact.file}`), sha256: artifact.sha256, byteLength: artifact.bytes,
          termCount: artifact.termCount, requiredCapabilities: artifact.requiredCapabilities })),
        projections: Object.fromEntries(Object.entries(result.native.usages).map(([usage, projection]) => [usage,
          'artifactFiles' in projection ? { artifactIds: projection.artifactFiles.map(artifactId) } : { unavailable: 'empty' }])),
      };
      const { artifacts: _artifacts, buildId: nativeBuildId, ...validation } = result.native;
      return {
        [`${prefix}/manifest.json`]: encode(manifest),
        [`${prefix}/source.json`]: encode(source),
        [`${prefix}/conversion-report.json`]: encode(result.report),
        [`${prefix}/build.json`]: encode({ id: result.id, definition: result.definition, target, buildId: result.buildId,
          candidateId: candidate.id, operation: candidate.operation, previousCandidateId: candidate.previousCandidateId,
          contracts: { artifactManifest: 1, sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD }, source, tools, nativeBuildId, ...validation,
          artifacts: result.native.artifacts.map(({ content: _content, ...metadata }) => metadata) }),
      };
    } });
}
