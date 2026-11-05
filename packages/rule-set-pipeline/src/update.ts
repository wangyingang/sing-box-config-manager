import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRelease } from './index.js';
import { buildNative } from './native.js';
import { decodedTerms } from './projection.js';
import { sha256, type ReleaseOptions } from './release.js';
import type { SourceRecord } from './types.js';
import { githubPublication, immutableUrl, type PublicationTransport } from './publication.js';
import { processConfiguredUpdate, type ConfiguredUpdateOptions } from './configured-update.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
type Pin = Pick<SourceRecord, 'repository' | 'releaseId' | 'tag' | 'commit' | 'yaml' | 'checksum'>;
export interface Candidate {
  id: string; releaseId: number; tag: string;
  status: 'building' | 'publishing' | 'verified' | 'failed';
  operation?: 'update' | 'rebuild'; previousCandidateId?: string; buildId?: string;
  filesCommit?: string; metadataCommit?: string; evidenceCommit?: string;
  manifestUrl?: string; evidenceUrl?: string; error?: string;
  logicalId?: string;
}
export interface UpdateState {
  schemaVersion: 1;
  pinned: Record<string, { identity?: Pin; source?: SourceRecord }>;
  processed: Record<string, { candidateId: string; tag: string; evidenceUrl: string }>;
  configuredProcessed?: Record<string, Record<string, { candidateId: string; tag: string; evidenceUrl: string; definitionSha256: string }>>;
  candidates: Record<string, Candidate>;
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
  return { state, activeRuleVersion };
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

/** Rebuild only a previously pinned, successfully processed Release, never latest. */
export function rebuildRules(options: RebuildOptions) {
  if (!options.release || options.release.toLowerCase() === 'latest') throw new Error('rebuild requires a fixed Release tag');
  return processRelease(options, options.release);
}

/** Durable checkpoints and publication gates are shared by update and rebuild. */
async function processRelease(options: UpdateOptions, rebuildTag?: string) {
  await mkdir(options.stateDirectory, { recursive: true });
  const lock = join(options.stateDirectory, 'update.lock');
  await mkdir(lock); // Refuse concurrent calls rather than losing pins or success records.
  let candidate: Candidate | undefined;
  let state: UpdateState | undefined;
  let previousProcessed: UpdateState['processed'][string] | undefined;
  const save = async () => {
    const temporary = join(options.stateDirectory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, encode(state));
    await rename(temporary, join(options.stateDirectory, 'update-state.json'));
  };
  try {
    const restored = await readUpdateState(options.stateDirectory);
    state = restored.state;
    const fetcher = options.fetch ?? fetch;
    const pinnedRebuild = rebuildTag ? Object.values(state.pinned).find(entry => entry.identity?.tag === rebuildTag) : undefined;
    if (rebuildTag && (!pinnedRebuild?.identity || !pinnedRebuild.source || !state.processed[String(pinnedRebuild.identity.releaseId)])) {
      throw new Error('rebuild requires a previously pinned and successfully processed Release');
    }
    const endpoint = pinnedRebuild ? String(pinnedRebuild.identity!.releaseId) : options.sampleTag ? `tags/${encodeURIComponent(options.sampleTag)}` : 'latest';
    const response = await fetcher(`https://api.github.com/repos/v2fly/domain-list-community/releases/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Release lookup HTTP ${response.status}`);
    const release = await response.json() as Record<string, unknown>;
    if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || typeof release.tag_name !== 'string') throw new Error('Invalid Release identity');
    const key = String(release.id), tag = release.tag_name;
    if (pinnedRebuild && (release.id !== pinnedRebuild.identity!.releaseId || tag !== rebuildTag)) {
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
      return { status: 'skipped' as const, releaseId: release.id, ...state.processed[key], activeRuleVersion: restored.activeRuleVersion };
    }
    candidate = { id: randomUUID(), releaseId: Number(release.id), tag, status: 'building',
      operation: rebuildTag ? 'rebuild' : 'update', previousCandidateId: previousProcessed?.candidateId };
    state.candidates[candidate.id] = candidate;
    await save();
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
        await save();
      },
      onSource: async source => { pin.source ??= source; await save(); },
    };
    const built = await buildRelease(sourceOptions);
    if (!built.ok) throw new Error(JSON.stringify(built.report.diagnostics));
    const native = await buildNative(decodedTerms(JSON.parse(built.json)), options.binary);
    const contracts = { artifactManifest: 1, sourceFormat: 4, buildRecord: 1 };
    const buildId = candidate.buildId = sha256(JSON.stringify({ source: built.source, tools: built.tools, nativeBuildId: native.buildId, contracts }));
    const publication = options.publication ?? githubPublication();
    const prefix = `candidates/${candidate.id}`;
    const files = Object.fromEntries(native.artifacts.map(artifact => [`${prefix}/${artifact.file}`, artifact.content]));
    candidate.status = 'publishing';
    await save();
    const filesCommit = candidate.filesCommit = await publication.commit(files, `候选 ${candidate.id}：规则文件`);
    await save();
    const artifactId = (file: string) => `v2fly:category-ai-!cn@${candidate!.id}:${file}`;
    const manifest = {
      schemaVersion: 1, id: 'v2fly:category-ai-!cn', revision: candidate.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      artifacts: native.artifacts.map(artifact => ({ id: artifactId(artifact.file), format: artifact.format,
        url: immutableUrl(filesCommit, `${prefix}/${artifact.file}`), sha256: artifact.sha256,
        byteLength: artifact.bytes, termCount: artifact.termCount, requiredCapabilities: artifact.requiredCapabilities })),
      projections: Object.fromEntries(Object.entries(native.usages).map(([usage, projection]) => [usage,
        'artifactFiles' in projection ? { artifactIds: projection.artifactFiles.map(artifactId) } : { unavailable: 'empty' }])),
    };
    const { artifacts: _artifacts, buildId: nativeBuildId, ...validation } = native;
    const records = {
      [`${prefix}/manifest.json`]: encode(manifest),
      [`${prefix}/source.json`]: encode(built.source),
      [`${prefix}/conversion-report.json`]: encode(built.report),
      [`${prefix}/build.json`]: encode({ buildId, candidateId: candidate.id, operation: candidate.operation, previousCandidateId: candidate.previousCandidateId, contracts, source: built.source, tools: built.tools, nativeBuildId, ...validation,
        artifacts: native.artifacts.map(({ content: _content, ...metadata }) => metadata) }),
    };
    const metadataCommit = candidate.metadataCommit = await publication.commit(records, `候选 ${candidate.id}：Manifest 与构建记录`);
    candidate.manifestUrl = immutableUrl(metadataCommit, `${prefix}/manifest.json`);
    await save();
    const readback: { url: string; sha256: string; byteLength: number; exactBytes: true }[] = [];
    const verify = async (path: string, expected: Buffer, commit: string) => {
      const url = immutableUrl(commit, path);
      const actual = await publication.download(url);
      if (actual.length !== expected.length || sha256(actual) !== sha256(expected) || !actual.equals(expected)) throw new Error(`Readback content mismatch: ${url}`);
      readback.push({ url, sha256: sha256(actual), byteLength: actual.length, exactBytes: true });
      return actual;
    };
    const downloaded = new Map<string, Buffer>();
    for (const [path, bytes] of Object.entries(files)) downloaded.set(path, await verify(path, bytes, filesCommit));
    // Recompile, decompile and load actual HTTPS bytes, then compare downloaded SRS.
    const remoteNative = await buildNative(decodedTerms(JSON.parse(downloaded.get(`${prefix}/domains.json`)!.toString('utf8'))), options.binary);
    for (const artifact of remoteNative.artifacts) {
      if (!artifact.content.equals(downloaded.get(`${prefix}/${artifact.file}`)!)) throw new Error('Remote native content mismatch');
    }
    for (const [path, bytes] of Object.entries(records)) await verify(path, bytes, metadataCommit);
    const evidence = encode({ schemaVersion: 1, candidateId: candidate.id, status: 'remote-verified',
      filesCommit, metadataCommit, buildId, readback, native: remoteNative.validation, tool: remoteNative.tool });
    const evidencePath = `${prefix}/readback.json`;
    candidate.evidenceCommit = await publication.commit({ [evidencePath]: evidence }, `候选 ${candidate.id}：HTTPS 回读验证`);
    candidate.evidenceUrl = immutableUrl(candidate.evidenceCommit, evidencePath);
    await verify(evidencePath, evidence, candidate.evidenceCommit);
    candidate.status = 'verified';
    if (!rebuildTag) state.processed[key] = { candidateId: candidate.id, tag, evidenceUrl: candidate.evidenceUrl };
    await save();
    return { status: 'processed' as const, candidate, activeRuleVersion: restored.activeRuleVersion, readback };
  } catch (error) {
    if (candidate && state) {
      candidate.status = 'failed'; candidate.error = error instanceof Error ? error.message : String(error);
      // A failed final save must never leave an in-memory success persisted by catch.
      if (previousProcessed) state.processed[String(candidate.releaseId)] = previousProcessed;
      else delete state.processed[String(candidate.releaseId)];
      await save();
    }
    throw error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
