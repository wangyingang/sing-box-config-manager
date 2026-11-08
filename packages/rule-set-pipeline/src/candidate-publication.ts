import type { RuleDefinition } from './configuration.js';
import { buildNative, type NativeBuild } from './native.js';
import { decodedTerms } from './projection.js';
import { immutableUrl, type PublicationTransport } from './publication.js';
import { sha256 } from './release.js';
import { isDeepStrictEqual } from 'node:util';

export function candidateFiles(definition?: RuleDefinition) {
  const route = definition?.usages.route;
  const stem = route && 'artifact' in route ? route.artifact : 'domains';
  return [`${stem}.json`, `${stem}.srs`, 'manifest.json', 'source.json', 'conversion-report.json', 'build.json', 'readback.json'];
}

export interface PublicationCandidate {
  id: string;
  status: 'building' | 'publishing' | 'verified' | 'failed';
  filesCommit?: string; metadataCommit?: string; evidenceCommit?: string;
  manifestUrl?: string; evidenceUrl?: string;
}

/** Common immutable publication gate for legacy and configured candidates. */
export async function publishCandidate(options: {
  candidate: PublicationCandidate; native: NativeBuild; buildId: string; binary: string;
  publication: PublicationTransport; save: () => Promise<void>;
  records: (filesCommit: string) => Record<string, Buffer>;
}) {
  const { candidate, native, buildId, binary, publication, save } = options;
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
  if (candidate.metadataCommit) {
    // The executable location is diagnostic, not part of the build identity.
    // Preserve the original immutable record when an identical tool is installed
    // at a different path on the recovery machine.
    const path = `${prefix}/build.json`;
    const original = await publication.download(immutableUrl(candidate.metadataCommit, path));
    const expectedBuild = JSON.parse(records[path].toString()), originalBuild = JSON.parse(original.toString());
    const withoutLocation = (record: Record<string, any>) => ({ ...record, tool: { ...record.tool, path: undefined } });
    if (!isDeepStrictEqual(withoutLocation(expectedBuild), withoutLocation(originalBuild))) throw new Error('Remote build record mismatch');
    records[path] = original;
    await verifyRetained(records);
  }
  const metadataCommit = candidate.metadataCommit ??= await publication.commit(records, `候选 ${candidate.id}：Manifest 与构建记录`);
  candidate.manifestUrl = immutableUrl(metadataCommit, `${prefix}/manifest.json`);
  await save();
  const readback: { url: string; sha256: string; byteLength: number; exactBytes: true }[] = [];
  const verify = async (path: string, expected: Buffer, commit: string) => {
    const url = immutableUrl(commit, path);
    const actual = await publication.download(url);
    if (actual.length !== expected.length || sha256(actual) !== sha256(expected) || !actual.equals(expected)) {
      throw new Error(`Readback content mismatch: ${url}`);
    }
    readback.push({ url, sha256: sha256(actual), byteLength: actual.length, exactBytes: true });
    return actual;
  };
  const downloaded = new Map<string, Buffer>();
  for (const [path, bytes] of Object.entries(files)) downloaded.set(path, await verify(path, bytes, filesCommit));
  // Recompile, decompile and load actual HTTPS JSON, then compare downloaded SRS.
  const route = native.usages.route;
  const json = 'artifactFiles' in route && downloaded.get(`${prefix}/${route.artifactFiles[0]}`);
  if (!json) throw new Error('Remote native JSON is missing');
  const remoteNative = await buildNative(decodedTerms(JSON.parse(json.toString('utf8'))), binary);
  if (remoteNative.artifacts.length !== native.artifacts.length || remoteNative.artifacts.some(artifact =>
    !downloaded.get(`${prefix}/${artifact.file}`)?.equals(artifact.content))) throw new Error('Remote native content mismatch');
  for (const [path, bytes] of Object.entries(records)) await verify(path, bytes, metadataCommit);
  const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, candidateId: candidate.id, status: 'remote-verified',
    filesCommit, metadataCommit, buildId, readback, native: remoteNative.validation, tool: remoteNative.tool }, null, 2) + '\n');
  const evidencePath = `${prefix}/readback.json`;
  candidate.evidenceCommit ??= await publication.commit({ [evidencePath]: evidence }, `候选 ${candidate.id}：HTTPS 回读验证`);
  candidate.evidenceUrl = immutableUrl(candidate.evidenceCommit, evidencePath);
  await verify(evidencePath, evidence, candidate.evidenceCommit);
  return readback;
}
