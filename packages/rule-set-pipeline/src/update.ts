import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRelease } from './index.js';
import { buildNative } from './native.js';
import { decodedTerms } from './projection.js';
import { sha256, type ReleaseOptions } from './release.js';
import type { CommitIdentity, CommitSourceRecord } from './github-commit.js';
import type { SourceRecord } from './types.js';
import { githubPublication, immutableUrl, type PublicationTransport } from './publication.js';
import { processConfiguredUpdate, type ConfiguredRebuildOptions, type ConfiguredUpdateOptions } from './configured-update.js';
import { publishCandidate } from './candidate-publication.js';
import type { BuildConfiguration, RuleDefinition } from './configuration.js';
import { openRemoteSession, selectRemoteOperation, type RemoteOperation } from './remote-state.js';
import type { CheckRecord } from './check-rules.js';
import { verifyRetainedCandidate } from './candidate-recovery.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
type Pin = Pick<SourceRecord, 'repository' | 'releaseId' | 'tag' | 'commit' | 'yaml' | 'checksum'>;
export type ReleaseReference = { releaseId: number; tag: string; sourceKey?: never };
type CommitReference = { sourceKey: string; releaseId?: never; tag?: never };
export type SourceReference = ReleaseReference | CommitReference;
export const sourceReferenceKey = (reference: SourceReference) => reference.sourceKey ?? String(reference.releaseId);

export function ruleDefinitionSha256(definition: RuleDefinition, target: BuildConfiguration['target']) {
  return sha256(JSON.stringify({ definition, target }));
}

export type Candidate = SourceReference & {
  id: string;
  status: 'building' | 'publishing' | 'verified' | 'failed';
  operation?: 'update' | 'rebuild'; previousCandidateId?: string; buildId?: string;
  filesCommit?: string; metadataCommit?: string; evidenceCommit?: string;
  manifestUrl?: string; evidenceUrl?: string; evidenceSha256?: string; error?: string;
  logicalId?: string;
  generation?: number; retained?: boolean; phase?: 'registered' | 'files' | 'metadata' | 'evidence' | 'complete';
  definition?: RuleDefinition; targetBranch?: string; operationId?: string;
}
export interface UpdateState {
  schemaVersion: 1;
  pinned: Record<string, { identity?: Pin; source?: SourceRecord }>;
  commitPins?: Record<string, { identity: CommitIdentity; source?: CommitSourceRecord }>;
  processed: Record<string, { candidateId: string; tag: string; evidenceUrl?: string }>;
  configuredProcessed?: Record<string, Record<string, { candidateId: string; tag?: string; evidenceUrl?: string; definitionSha256: string }>>;
  candidates: Record<string, Candidate>;
  latestChecks?: Record<string, CheckRecord>;
  pendingOperation?: (SourceReference & { kind: 'update' | 'rebuild' | 'check'; sourcePins?: never }
    | { kind: 'check'; sourcePins: Record<string, SourceReference>; releaseId?: never; tag?: never; sourceKey?: never }) & { id: string; generation: number;
    status: 'pending' | 'complete'; expectedHead: string; candidateIds: string[]; configuration?: string; selectedIds?: string[]; controlRevisions?: Record<string, string | null>; subscriptionHashes?: Record<string, string> };
}
async function readJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function readUpdateState(directory: string) {
  const state: UpdateState = await readJson(join(directory, 'update-state.json')) ?? {
    schemaVersion: 1, pinned: {}, processed: {}, candidates: {},
  };
  if (state.schemaVersion !== 1 || !state.pinned || !state.processed || !state.candidates) throw new Error('Invalid update state');
  // Owned by explicit activation (#19), never written by update.
  const activeRuleVersion = await readJson(join(directory, 'active-version.json')) ?? null;
  const activeRuleVersions: Record<string, any> = {};
  let receipts: string[];
  try { receipts = await readdir(join(directory, 'active-rule-versions')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; receipts = []; }
  for (const file of receipts.filter(file => /^[a-z][a-z0-9-]*\.json$/.test(file))) {
    const receipt = await readJson(join(directory, 'active-rule-versions', file));
    if (receipt?.status !== 'activated' || receipt.activation?.logicalId !== file.slice(0, -5)) throw new Error('Invalid activation receipt');
    activeRuleVersions[file.slice(0, -5)] = receipt;
  }
  return { state, activeRuleVersion, activeRuleVersions };
}
export interface UpdateOptions {
  stateDirectory: string; binary: string; token?: string; fetch?: typeof fetch;
  publication?: PublicationTransport;
  /** Fixed official sample acceptance; normal CLI update never accepts a tag. */
  sampleTag?: string;
}

export interface RebuildOptions extends Omit<UpdateOptions, 'sampleTag'> { release: string }

export function updateRules(options: ConfiguredUpdateOptions): ReturnType<typeof processConfiguredUpdate>;
export function updateRules(options: UpdateOptions): ReturnType<typeof processRelease>;
export function updateRules(options: UpdateOptions | ConfiguredUpdateOptions) {
  return 'configuration' in options ? processConfiguredUpdate(options) : processRelease(options);
}

/** Rebuild a previously pinned, successfully processed version. */
export function rebuildRules(options: ConfiguredRebuildOptions): ReturnType<typeof processConfiguredUpdate>;
export function rebuildRules(options: RebuildOptions): ReturnType<typeof processRelease>;
export function rebuildRules(options: RebuildOptions | ConfiguredRebuildOptions) {
  const version = options.release ?? ('commit' in options ? options.commit : undefined);
  if (!version || version.toLowerCase() === 'latest') throw new Error('rebuild requires a fixed Release tag or Git commit');
  return 'configuration' in options
    ? processConfiguredUpdate(options, options.commit === undefined ? { release: version } : { commit: version })
    : processRelease(options, version);
}

/** Durable checkpoints and publication gates are shared by update and rebuild. */
async function processRelease(options: UpdateOptions, rebuildTag?: string) {
  await mkdir(options.stateDirectory, { recursive: true });
  const lock = join(options.stateDirectory, 'update.lock');
  await mkdir(lock); // Refuse concurrent calls rather than losing pins or success records.
  let candidate: Candidate | undefined;
  let state: UpdateState | undefined;
  let session: Awaited<ReturnType<typeof openRemoteSession>> | undefined;
  let previousProcessed: UpdateState['processed'][string] | undefined;
  const save = async () => {
    if (session) { await session.save(); return; }
    const temporary = join(options.stateDirectory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, encode(state));
    await rename(temporary, join(options.stateDirectory, 'update-state.json'));
  };
  try {
    const transport = options.publication ?? githubPublication();
    const targetBranch = transport.repository?.branch === 'candidates' ? 'main' : transport.repository?.branch ?? 'main';
    session = transport.repository ? await openRemoteSession(transport, options.stateDirectory, targetBranch) : undefined;
    const publication = session?.publication ?? transport;
    const restored = session ? { state: session.state, activeRuleVersion: undefined } : await readUpdateState(options.stateDirectory);
    state = restored.state;
    const matches = (entry: RemoteOperation) => entry.kind === (rebuildTag ? 'rebuild' : 'update') && entry.sourceKey === undefined && entry.configuration === undefined
      && entry.selectedIds === undefined && (!rebuildTag || rebuildTag === entry.tag) && (!options.sampleTag || options.sampleTag === entry.tag);
    const recovery = session && selectRemoteOperation(session.journal, matches);
    if (recovery && !matches(recovery) || !recovery && session?.journal.parkedOperations?.length) {
      throw new Error('RECOVERY_REQUEST_MISMATCH: resume the registered operation with its original command and Release');
    }
    const verifyRetained = async (id: string, allowEvidence = false) => {
      if (!session) return;
      const retained = state!.candidates[id];
      return verifyRetainedCandidate({ candidate: retained, source: retained && state!.pinned[String(retained.releaseId)]?.source,
        snapshot: session.snapshot, publication, binary: options.binary, targetBranch, allowEvidence });
    };
    const recoverable = recovery && Object.values(state.candidates).find(entry => entry.operationId === recovery.id
      && (entry.phase === 'evidence' || entry.phase === 'complete'));
    if (session && recovery && recoverable) {
      const { readback } = (await verifyRetained(recoverable.id, true))!;
      recoverable.status = 'verified'; recoverable.phase = 'complete'; delete recoverable.error;
      if (!rebuildTag) state.processed[String(recovery.releaseId)] = {
        candidateId: recoverable.id, tag: recovery.tag!, evidenceUrl: recoverable.evidenceUrl!,
      };
      recovery.status = 'complete'; await save();
      await session.confirmGeneration();
      return { status: 'processed' as const, candidate: recoverable, activeRuleVersion: restored.activeRuleVersion, readback,
        ...(session.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
    }
    const fetcher = options.fetch ?? fetch;
    const pinnedRebuild = rebuildTag ? Object.values(state.pinned).find(entry => entry.identity?.tag === rebuildTag) : undefined;
    if (rebuildTag && (!pinnedRebuild?.identity || !pinnedRebuild.source || !state.processed[String(pinnedRebuild.identity.releaseId)])) {
      throw new Error('rebuild requires a previously pinned and successfully processed Release');
    }
    if (pinnedRebuild) await verifyRetained(state.processed[String(pinnedRebuild.identity!.releaseId)].candidateId);
    const endpoint = recovery ? String(recovery.releaseId) : pinnedRebuild ? String(pinnedRebuild.identity!.releaseId)
      : options.sampleTag ? `tags/${encodeURIComponent(options.sampleTag)}` : 'latest';
    const response = await fetcher(`https://api.github.com/repos/v2fly/domain-list-community/releases/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Release lookup HTTP ${response.status}`);
    const release = await response.json() as Record<string, unknown>;
    if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || typeof release.tag_name !== 'string') throw new Error('Invalid Release identity');
    const key = String(release.id), tag = release.tag_name;
    if ((pinnedRebuild && (release.id !== pinnedRebuild.identity!.releaseId || tag !== rebuildTag))
      || (recovery && (release.id !== recovery.releaseId || tag !== recovery.tag))) {
      throw new Error('SOURCE_CHANGED: rebuild Release identity changed');
    }
    previousProcessed = state.processed[key];
    if (!rebuildTag && previousProcessed) {
      if (state.processed[key].tag !== tag) throw new Error('SOURCE_CHANGED: processed Release identity changed');
      const pinned = state.pinned[key]?.identity;
      if (pinned && (!Array.isArray(release.assets) || [pinned.yaml, pinned.checksum].some(asset => {
        const matches = (release.assets as Record<string, unknown>[]).filter(entry => entry.name === asset.name);
        return matches.length !== 1 || matches[0].id !== asset.id || matches[0].browser_download_url !== asset.url;
      }))) throw new Error('SOURCE_CHANGED: processed Release assets changed');
      await verifyRetained(previousProcessed.candidateId);
      if (!previousProcessed.evidenceUrl) throw new Error('CANDIDATE_UNAVAILABLE: processed candidate has no retained address');
      if (session && recovery) { recovery.status = 'complete'; await save(); }
      await session?.confirmGeneration();
      return { status: 'skipped' as const, releaseId: release.id, ...previousProcessed, evidenceUrl: previousProcessed.evidenceUrl, activeRuleVersion: restored.activeRuleVersion,
        ...(session?.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
    }
    if (session && !recovery) state.pendingOperation = { id: randomUUID(), kind: rebuildTag ? 'rebuild' : 'update',
      generation: session.generation, expectedHead: session.snapshot.head, candidateIds: [], releaseId: Number(release.id), tag, status: 'pending' };
    const recovering = session && Object.values(state.candidates).find(entry => entry.operationId === state!.pendingOperation!.id);
    candidate = recovering || { id: randomUUID(), releaseId: Number(release.id), tag, status: 'building',
      operation: rebuildTag ? 'rebuild' : 'update', previousCandidateId: previousProcessed?.candidateId,
      ...(session ? { generation: session.generation, retained: true, phase: 'registered' as const,
        targetBranch, operationId: state.pendingOperation!.id } : {}) };
    if (session && !candidate.retained) throw new Error('CANDIDATE_UNAVAILABLE: registered candidate has been removed');
    if (!session) { state.candidates[candidate.id] = candidate; await save(); }
    const previousTag = Object.values(state.pinned).find(entry => entry.identity?.tag === tag && entry.identity.releaseId !== Number(release.id));
    if (previousTag) throw new Error('SOURCE_CHANGED: fixed tag now identifies a different Release');
    const pin = state.pinned[key] ??= {};
    const canonicalPin = (value: Pin) => JSON.stringify([value.repository, value.releaseId, value.tag, value.commit,
      value.yaml.id, value.yaml.name, value.yaml.url, value.checksum.id, value.checksum.name, value.checksum.url]);
    const sourceOptions: ReleaseOptions = {
      tag, releaseMetadata: release, expectedSource: pin.source, fetch: fetcher, token: options.token,
      onPinned: async identity => {
        if (pin.identity && canonicalPin(pin.identity) !== canonicalPin(identity)) throw new Error('SOURCE_CHANGED: pinned Release identity changed');
        pin.identity ??= identity;
        if (session) {
          state!.candidates[candidate!.id] = candidate!;
          if (!state!.pendingOperation!.candidateIds.includes(candidate!.id)) state!.pendingOperation!.candidateIds.push(candidate!.id);
        }
        await save();
      },
      onSource: async source => { pin.source ??= source; await save(); },
    };
    const built = await buildRelease(sourceOptions);
    if (!built.ok) throw new Error(JSON.stringify(built.report.diagnostics));
    const native = await buildNative(decodedTerms(JSON.parse(built.json)), options.binary);
    const contracts = { artifactManifest: 1, sourceFormat: 4, buildRecord: 1 };
    const buildId = sha256(JSON.stringify({ source: built.source, tools: built.tools, nativeBuildId: native.buildId, contracts }));
    if (candidate.buildId && candidate.buildId !== buildId) throw new Error('RECOVERY_BUILD_CHANGED: original tool and build identity required');
    candidate.buildId = buildId;
    const prefix = `candidates/${candidate.id}`;
    const readback = await publishCandidate({ candidate, native, buildId, binary: options.binary, publication, save,
      records: filesCommit => {
        const artifactId = (file: string) => `v2fly:category-ai-!cn@${candidate!.id}:${file}`;
        const manifest = {
          schemaVersion: 1, id: 'v2fly:category-ai-!cn', revision: candidate!.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
          artifacts: native.artifacts.map(artifact => ({ id: artifactId(artifact.file), format: artifact.format,
            url: immutableUrl(filesCommit, `${prefix}/${artifact.file}`), sha256: artifact.sha256,
            byteLength: artifact.bytes, termCount: artifact.termCount, requiredCapabilities: artifact.requiredCapabilities })),
          projections: Object.fromEntries(Object.entries(native.usages).map(([usage, projection]) => [usage,
            'artifactFiles' in projection ? { artifactIds: projection.artifactFiles.map(artifactId) } : { unavailable: 'empty' }])),
        };
        const { artifacts: _artifacts, buildId: nativeBuildId, ...validation } = native;
        return {
          [`${prefix}/manifest.json`]: encode(manifest),
          [`${prefix}/source.json`]: encode(built.source),
          [`${prefix}/conversion-report.json`]: encode(built.report),
          [`${prefix}/build.json`]: encode({ buildId, candidateId: candidate!.id, operation: candidate!.operation,
            previousCandidateId: candidate!.previousCandidateId, contracts, source: built.source, tools: built.tools,
            nativeBuildId, ...validation, artifacts: native.artifacts.map(({ content: _content, ...metadata }) => metadata) }),
        };
      } });
    candidate.status = 'verified'; delete candidate.error;
    if (session) { candidate.phase = 'complete'; state.pendingOperation!.status = 'complete'; }
    if (!rebuildTag) state.processed[key] = { candidateId: candidate.id, tag, evidenceUrl: candidate.evidenceUrl! };
    await save();
    await session?.confirmGeneration();
    return { status: 'processed' as const, candidate, activeRuleVersion: restored.activeRuleVersion, readback,
      ...(session?.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
  } catch (error) {
    if (session && /PUBLICATION_(CONFLICT|PENDING)/.test(String(error))) throw error;
    if (candidate && state && state.candidates[candidate.id]) {
      candidate.status = 'failed'; candidate.error = error instanceof Error ? error.message : String(error);
      if (session) {
        if (candidate.phase === 'complete') candidate.phase = 'evidence';
        state.pendingOperation!.status = 'pending';
      }
      // A failed final save must never leave an in-memory success persisted by catch.
      if (previousProcessed) state.processed[String(candidate.releaseId)] = previousProcessed;
      else delete state.processed[String(candidate.releaseId)];
      await save();
    }
    throw error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
