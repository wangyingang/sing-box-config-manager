import { verifyWithoutEvidenceCache, type VerifyEvidence } from './evidence-download.js';
import type { RuleDefinition } from './configuration.js';
import type { SourceReference } from './update.js';
import { buildRuleArtifacts, type NativeTarget, type ValidatedNativeBuild, type NativeBuildOptions } from './native.js';
import { readSourceTerms } from './projection.js';
import { immutableUrl, type PublicationTransport } from './publication.js';
import { sha256 } from './release.js';
import { isDeepStrictEqual } from 'node:util';

export const ARTIFACT_MANIFEST_VERSION = 2;
export const SINGLE_ARTIFACT_MANIFEST_VERSION = 3;
export const CANDIDATE_READBACK_VERSION = 2;
export const RULE_READBACK_VERSION = 3;
export const LEGACY_BUILD_RECORD = 2;

export function candidateArtifactFiles(definition?: RuleDefinition) {
  const stem = definition && 'artifact' in definition ? definition.artifact : definition?.usages.route.artifact ?? 'domains';
  return { source: `${stem}.json`, binary: `${stem}.srs` };
}

export const candidateTraceFiles = ['source.json', 'conversion-report.json'];

export function candidateCoreFiles(definition?: RuleDefinition) {
  const { source, binary } = candidateArtifactFiles(definition);
  return [source, binary, 'manifest.json', 'build.json', 'readback.json'];
}

export function candidateFiles(definition?: RuleDefinition) {
  return [...candidateCoreFiles(definition), ...candidateTraceFiles];
}

/** The journal binds Git candidates to the exact bytes of their readback record. */
export function candidateEvidenceSha256(candidate: SourceReference, evidence: Buffer | undefined) {
  return evidence && candidate.sourceKey !== undefined ? sha256(evidence) : undefined;
}

export interface PublicationCandidate {
  id: string;
  status: 'building' | 'publishing' | 'verified' | 'failed';
  filesCommit?: string; metadataCommit?: string; evidenceCommit?: string;
  manifestUrl?: string; evidenceUrl?: string;
  publishedAt?: string; versionId?: string;
}

/** Common immutable publication gate for legacy and configured candidates. */
export async function publishCandidate(options: NativeBuildOptions & {
  candidate: PublicationCandidate; native: ValidatedNativeBuild; buildId: string; target?: NativeTarget;
  publication: PublicationTransport; save: () => Promise<void>;
  records: (filesCommit: string) => Record<string, Buffer>;
  beforeEvidence?: () => void;
  ruleFilesOnly?: boolean;
  verifyEvidence?: VerifyEvidence;
}) {
  const { candidate, native, buildId, binary, publication, save, nativeBuild = buildRuleArtifacts } = options;
  const verifyEvidence = options.verifyEvidence ?? verifyWithoutEvidenceCache(url => publication.download(url));
  const prefix = `candidates/${candidate.id}`;
  const files = Object.fromEntries(native.artifacts.map(artifact => [`${prefix}/${artifact.file}`, artifact.content]));
  // A previously committed stage must still have the same bytes in the
  // retained tree. An old immutable URL can remain readable after tampering.
  const retained = candidate.filesCommit ? await publication.repository?.snapshot() : undefined;
  const verifyRetained = async (expected: Record<string, Buffer>) => {
    if (!retained) return;
    for (const [path, bytes] of Object.entries(expected)) {
      if (!(await retained.read(path))?.equals(bytes)) throw new Error(`CANDIDATE_UNAVAILABLE: retained bytes differ at ${path}`);
    }
  };
  await verifyRetained(files);
  candidate.status = 'publishing'; await save();
  const filesCommit = candidate.filesCommit ??= await publication.commit(files, `候选 ${candidate.id}：规则文件`);
  await save();
  const records = options.records(filesCommit);
  if (candidate.metadataCommit && options.ruleFilesOnly) {
    const manifest = `${prefix}/manifest.json`, build = `${prefix}/build.json`;
    const originalManifest = await retained?.read(manifest), originalBuild = await retained?.read(build);
    if (!originalManifest || !originalBuild
      || !isDeepStrictEqual(JSON.parse(originalManifest.toString()), JSON.parse(records[manifest].toString()))
      || !isDeepStrictEqual(candidateBuildFacts(originalBuild), candidateBuildFacts(records[build]))) {
      throw new Error('CANDIDATE_UNAVAILABLE: missing or changed retained metadata');
    }
  }
  if (candidate.metadataCommit && !options.ruleFilesOnly) {
    // The executable location is diagnostic, not part of the build identity.
    // Preserve the original immutable record when an identical tool is installed
    // at a different path on the recovery machine.
    const path = `${prefix}/build.json`;
    const url = immutableUrl(candidate.metadataCommit, path);
    await verifyEvidence(async download => {
      const original = await download(url);
      const expectedBuild = JSON.parse(records[path].toString()), originalBuild = JSON.parse(original.toString());
      const withoutLocation = (record: Record<string, any>) => ({ ...record, tool: { ...record.tool, path: undefined } });
      if (!isDeepStrictEqual(withoutLocation(expectedBuild), withoutLocation(originalBuild))) throw new Error('Remote build record mismatch');
      records[path] = original;
      await verifyRetained(records);
    });
  }
  const metadataCommit = candidate.metadataCommit ??= await publication.commit(records, `候选 ${candidate.id}：Manifest 与构建记录`);
  candidate.manifestUrl = immutableUrl(metadataCommit, `${prefix}/manifest.json`);
  await save();
  const readback: RuleReadback[] = [];
  const verify = async (path: string, expected: Buffer, commit: string) => {
    const { bytes, record } = await verifyRuleFile(verifyEvidence, immutableUrl(commit, path), expected);
    readback.push(record);
    return bytes;
  };
  const downloaded = new Map<string, Buffer>();
  for (const [path, bytes] of Object.entries(files)) downloaded.set(path, await verify(path, bytes, filesCommit));
  // Bind the HTTPS bytes to the compiled and loaded output for this tool.
  const source = native.artifacts.find(artifact => artifact.format === 'source');
  const json = source && downloaded.get(`${prefix}/${source.file}`);
  if (!json) throw new Error('Remote native JSON is missing');
  const terms = readSourceTerms(JSON.parse(json.toString('utf8')), { allowEmpty: typeof options.target === 'object' });
  const remoteNative = await nativeBuild(terms, binary, options.target);
  if (remoteNative.tool.sha256 !== native.tool.sha256) throw new Error('Binary changed between build and readback');
  if (remoteNative.artifacts.length !== native.artifacts.length || remoteNative.artifacts.some(artifact =>
    !downloaded.get(`${prefix}/${artifact.file}`)?.equals(artifact.content))) throw new Error('Remote native content mismatch');
  if (!options.ruleFilesOnly) {
    for (const [path, bytes] of Object.entries(records)) await verify(path, bytes, metadataCommit);
  }
  options.beforeEvidence?.();
  const evidence = Buffer.from(JSON.stringify({ schemaVersion: options.ruleFilesOnly ? RULE_READBACK_VERSION : CANDIDATE_READBACK_VERSION,
    candidateId: candidate.id, status: 'remote-verified',
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt, versionId: candidate.versionId } : {}),
    filesCommit, metadataCommit, buildId, readback,
    ...(!options.ruleFilesOnly && { native: remoteNative.validation, tool: remoteNative.tool }) }, null, 2) + '\n');
  const evidencePath = `${prefix}/readback.json`;
  candidate.evidenceCommit ??= await publication.commit({ [evidencePath]: evidence }, `候选 ${candidate.id}：HTTPS 回读验证`);
  candidate.evidenceUrl = immutableUrl(candidate.evidenceCommit, evidencePath);
  if (!options.ruleFilesOnly) await verify(evidencePath, evidence, candidate.evidenceCommit);
  return readback;
}

function candidateBuildFacts(bytes: Buffer) {
  const build = JSON.parse(bytes.toString());
  const { id, candidateId, buildId, definition, target, contracts, tools, nativeBuildId, status } = build;
  return { id, candidateId, buildId, definition, target, contracts, tools, nativeBuildId, status,
    tool: { version: build.tool?.version, sha256: build.tool?.sha256 },
    validation: { status: build.validation?.status, policy: build.validation?.policy } };
}

export interface RuleReadback { url: string; sha256: string; byteLength: number; exactBytes: true }

export async function verifyRuleFile(verify: VerifyEvidence, url: string, expected: Buffer) {
  return verify(async download => {
    const bytes = await download(url);
    if (!bytes.equals(expected)) throw new Error(`Readback content mismatch: ${url}`);
    const record: RuleReadback = { url, sha256: sha256(bytes), byteLength: bytes.length, exactBytes: true };
    return { bytes, record };
  });
}
