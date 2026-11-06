import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildConfiguredRelease, parseBuildConfiguration } from './configured-build.js';
import { publishCandidate } from './candidate-publication.js';
import { githubPublication, immutableUrl, type PublicationTransport } from './publication.js';
import { sha256 } from './release.js';
import type { SourceRecord } from './types.js';
import { readUpdateState, type Candidate, type UpdateState } from './update.js';
import { openRemoteSession } from './remote-state.js';
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
export interface ConfiguredRebuildOptions extends Omit<ConfiguredUpdateOptions, 'sampleTag' | 'retryRelease'> {
  release: string;
  selectedIds: string[];
}
type BatchEntry = { id: string; status: 'skipped'; candidateId: string; evidenceUrl: string }
  | { id: string; status: 'processed'; candidate: Candidate; readback: { url: string; sha256: string; byteLength: number; exactBytes: true }[] }
  | { id: string; status: 'failed'; candidateId: string; candidate?: Candidate; error: string };

export async function processConfiguredUpdate(options: ConfiguredUpdateOptions, rebuildTag?: string) {
  const configuration = parseBuildConfiguration(options.configuration);
  const selected = options.selectedIds;
  if (selected && (selected.length === 0 || new Set(selected).size !== selected.length ||
      selected.some(id => !configuration.ruleSets.some(rule => rule.id === id)))) {
    throw new Error('Selected logical ID is duplicate or unknown');
  }
  if (options.retryRelease && (!selected || options.retryRelease.toLowerCase() === 'latest' || options.sampleTag)) {
    throw new Error('Fixed Release retry requires selected logical IDs and a prior pin');
  }
  if (rebuildTag && (!selected?.length || options.retryRelease || options.sampleTag)) {
    throw new Error('Configured rebuild requires selected logical IDs and a fixed Release');
  }
  const definitions = selected ? configuration.ruleSets.filter(rule => selected.includes(rule.id)) : configuration.ruleSets;
  await mkdir(options.stateDirectory, { recursive: true });
  const lock = join(options.stateDirectory, 'update.lock');
  await mkdir(lock);
  try {
    const transport = options.publication ?? githubPublication(undefined,
      configuration.target.branch === 'main' ? 'candidates' : configuration.target.branch);
    const session = transport.repository ? await openRemoteSession(transport, options.stateDirectory, configuration.target.branch) : undefined;
    const publication = session?.publication ?? transport;
    const restored = session ? { state: session.state, activeRuleVersion: undefined } : await readUpdateState(options.stateDirectory);
    const state: UpdateState = restored.state;
    const recovery = session && state.pendingOperation?.status === 'pending' ? state.pendingOperation : undefined;
    if (recovery && (recovery.kind !== (rebuildTag ? 'rebuild' : 'update') || !recovery.configuration
      || JSON.stringify(parseBuildConfiguration(recovery.configuration)) !== JSON.stringify(configuration)
      || definitions.some(rule => recovery.selectedIds && !recovery.selectedIds.includes(rule.id))
      || (rebuildTag ?? options.retryRelease) && (rebuildTag ?? options.retryRelease) !== recovery.tag)) {
      throw new Error('RECOVERY_REQUEST_MISMATCH: resume the registered operation with its original configuration and selection');
    }
    state.configuredProcessed ??= {};
    const processedFor = (id: string) => Object.hasOwn(state.configuredProcessed!, id) ? state.configuredProcessed![id] : undefined;
    const fixedTag = recovery?.tag ?? rebuildTag ?? options.retryRelease;
    const retryPin = fixedTag
      ? Object.values(state.pinned).find(entry => entry.identity?.tag === fixedTag && (recovery || entry.source))
      : undefined;
    if (fixedTag && !retryPin?.identity) throw new Error('Fixed Release requires a previously pinned source');
    const definitionHash = (definition: typeof definitions[number]) => sha256(JSON.stringify({ definition, target: configuration.target }));
    const operationFinished = () => {
      const operation = state.pendingOperation!;
      return configuration.ruleSets.filter(rule => !operation.selectedIds || operation.selectedIds.includes(rule.id)).every(rule => {
        const completed = Object.values(state.candidates).some(candidate => candidate.operationId === operation.id
          && candidate.logicalId === rule.id && candidate.retained && candidate.phase === 'complete' && candidate.status === 'verified');
        const previous = processedFor(rule.id)?.[String(operation.releaseId)];
        return completed || operation.kind === 'update' && previous?.definitionSha256 === definitionHash(rule)
          && state.candidates[previous.candidateId]?.retained === true && state.candidates[previous.candidateId]?.phase === 'complete';
      });
    };
    if (rebuildTag && definitions.some(definition => {
      const previous = processedFor(definition.id)?.[String(retryPin!.identity!.releaseId)];
      return !previous || previous.definitionSha256 !== definitionHash(definition);
    })) throw new Error('Configured rebuild requires a successfully processed rule definition at the fixed Release');
    const save = session?.save ?? (async () => {
      const temporary = join(options.stateDirectory, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, encode(state));
      await rename(temporary, join(options.stateDirectory, 'update-state.json'));
    });
    const recoveredResults: BatchEntry[] = [];
    const verify = (candidate: Candidate, definition: typeof definitions[number], allowEvidence = false) =>
      verifyRetainedCandidate({ candidate, source: state.pinned[String(candidate.releaseId)]?.source, snapshot: session!.snapshot,
        publication, binary: options.binary, targetBranch: configuration.target.branch, definition, allowEvidence });
    if (session && rebuildTag && !recovery) {
      for (const definition of definitions) {
        const previous = processedFor(definition.id)![String(retryPin!.identity!.releaseId)];
        const candidate = state.candidates[previous.candidateId];
        if (!candidate || candidate.phase !== 'complete') throw new Error('CANDIDATE_UNAVAILABLE: rebuild history is no longer retained');
        await verify(candidate, definition);
      }
    }
    if (session && recovery) {
      for (const definition of definitions) {
        const candidate = Object.values(state.candidates).find(value => value.operationId === recovery.id && value.logicalId === definition.id);
        if (!candidate || !['evidence', 'complete'].includes(candidate.phase!)) continue;
        const { readback } = await verify(candidate, definition, true);
        candidate.status = 'verified'; candidate.phase = 'complete'; delete candidate.error;
        if (!rebuildTag) {
          if (!processedFor(definition.id)) state.configuredProcessed[definition.id] = {};
          state.configuredProcessed[definition.id][String(recovery.releaseId)] = { candidateId: candidate.id, tag: recovery.tag,
            evidenceUrl: candidate.evidenceUrl!, definitionSha256: definitionHash(definition) };
        }
        recoveredResults.push({ id: definition.id, status: 'processed', candidate, readback });
      }
      if (recoveredResults.length) {
        if (operationFinished()) recovery.status = 'complete';
        await save();
        if (recoveredResults.length === definitions.length) return { status: 'processed', releaseId: recovery.releaseId, tag: recovery.tag,
          results: recoveredResults, activeRuleVersion: undefined, ...(session.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
      }
    }
    const fetcher = options.fetch ?? fetch;
    const endpoint = retryPin ? String(retryPin.identity!.releaseId)
      : options.sampleTag ? `tags/${encodeURIComponent(options.sampleTag)}` : 'latest';
    const response = await fetcher(`https://api.github.com/repos/v2fly/domain-list-community/releases/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Release lookup HTTP ${response.status}`);
    const release = await response.json() as Record<string, unknown>;
    if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || typeof release.tag_name !== 'string' ||
        (options.sampleTag && release.tag_name !== options.sampleTag) ||
        (fixedTag && (release.id !== retryPin!.identity!.releaseId || release.tag_name !== fixedTag))) {
      throw new Error('SOURCE_CHANGED: fixed Release identity changed');
    }
    const releaseId = Number(release.id), tag = release.tag_name;
    const key = String(releaseId);
    const previousTag = Object.values(state.pinned).find(entry => entry.identity?.tag === tag && entry.identity.releaseId !== releaseId);
    if (previousTag) throw new Error('SOURCE_CHANGED: fixed tag now identifies a different Release');
    const pin = state.pinned[key] ??= {};
    if (pin.identity && (pin.identity.tag !== tag || !Array.isArray(release.assets) || [pin.identity.yaml, pin.identity.checksum].some(asset => {
      const matches = (release.assets as Record<string, unknown>[]).filter(entry => entry.name === asset.name);
      return matches.length !== 1 || matches[0].id !== asset.id || matches[0].browser_download_url !== asset.url;
    }))) throw new Error('SOURCE_CHANGED: processed Release assets changed');
    if (session && !recovery) state.pendingOperation = { id: randomUUID(), kind: rebuildTag ? 'rebuild' : 'update',
      generation: session.generation, expectedHead: session.snapshot.head, candidateIds: [], releaseId, tag, status: 'pending', configuration: options.configuration, selectedIds: selected };
    const results: BatchEntry[] = [...recoveredResults];
    const pending = [] as typeof definitions;
    for (const definition of definitions) {
      if (recoveredResults.some(result => result.id === definition.id)) continue;
      if (rebuildTag) { pending.push(definition); continue; }
      const existing = processedFor(definition.id)?.[key];
      const definitionSha256 = definitionHash(definition);
      if (!existing || existing.definitionSha256 !== definitionSha256 || !pin.source) { pending.push(definition); continue; }
      if (session) {
        const candidate = state.candidates[existing.candidateId];
        if (!candidate || candidate.phase !== 'complete') throw new Error('CANDIDATE_UNAVAILABLE: processed candidate is incomplete');
        await verify(candidate, definition);
      }
      results.push({ id: definition.id, status: 'skipped', candidateId: existing.candidateId, evidenceUrl: existing.evidenceUrl });
    }
    if (pending.length) {
      const built = await buildConfiguredRelease({ configuration: options.configuration,
        selectedIds: pending.map(rule => rule.id), binary: options.binary,
        release: { tag, releaseMetadata: release, expectedSource: pin.source, fetch: fetcher, token: options.token,
          onPinned: async identity => {
            if (pin.identity && canonicalPin(pin.identity) !== canonicalPin(identity)) throw new Error('SOURCE_CHANGED: pinned Release identity changed');
            pin.identity ??= identity; await save();
          },
          onSource: async source => { pin.source ??= source; await save(); },
        } });
      for (const result of built.results) {
        const previousProcessed = processedFor(result.id)?.[key];
        const recovering = session && Object.values(state.candidates).find(candidate => candidate.operationId === state.pendingOperation!.id && candidate.logicalId === result.id);
        const candidate: Candidate = recovering || { id: randomUUID(), logicalId: result.id, releaseId, tag,
          status: 'building', operation: rebuildTag ? 'rebuild' : 'update', previousCandidateId: previousProcessed?.candidateId,
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
          const readback = await publish(result, candidate, built.source, built.tools, configuration.target, publication, options.binary, save);
          candidate.status = 'verified'; delete candidate.error;
          if (session) candidate.phase = 'complete';
          if (!rebuildTag) {
            if (!processedFor(result.id)) state.configuredProcessed[result.id] = {};
            state.configuredProcessed[result.id][key] = { candidateId: candidate.id, tag,
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
    return { status: failed ? (failed === results.length ? 'failed' : 'partial') : pending.length ? 'processed' : 'skipped',
      releaseId, tag, results, activeRuleVersion: restored.activeRuleVersion, ...(session?.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function publish(result: Extract<Awaited<ReturnType<typeof buildConfiguredRelease>>['results'][number], { status: 'built-validated' }>,
  candidate: Candidate, source: SourceRecord, tools: Record<string, string | number>, target: { repository: string; branch: string },
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
          contracts: { artifactManifest: 1, sourceFormat: 4, buildRecord: 1 }, source, tools, nativeBuildId, ...validation,
          artifacts: result.native.artifacts.map(({ content: _content, ...metadata }) => metadata) }),
      };
    } });
}
