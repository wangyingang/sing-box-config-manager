import { buildNative, type NativeBuild } from './native.js';
import { decodedTerms } from './projection.js';
import { immutableUrl, type PublicationTransport } from './publication.js';
import { sha256 } from './release.js';

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
  candidate.status = 'publishing'; await save();
  const filesCommit = candidate.filesCommit = await publication.commit(files, `候选 ${candidate.id}：规则文件`);
  await save();
  const records = options.records(filesCommit);
  const metadataCommit = candidate.metadataCommit = await publication.commit(records, `候选 ${candidate.id}：Manifest 与构建记录`);
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
  const json = downloaded.get(`${prefix}/domains.json`);
  if (!json) throw new Error('Remote native JSON is missing');
  const remoteNative = await buildNative(decodedTerms(JSON.parse(json.toString('utf8'))), binary);
  if (remoteNative.artifacts.length !== native.artifacts.length || remoteNative.artifacts.some(artifact =>
    !downloaded.get(`${prefix}/${artifact.file}`)?.equals(artifact.content))) throw new Error('Remote native content mismatch');
  for (const [path, bytes] of Object.entries(records)) await verify(path, bytes, metadataCommit);
  const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, candidateId: candidate.id, status: 'remote-verified',
    filesCommit, metadataCommit, buildId, readback, native: remoteNative.validation, tool: remoteNative.tool }, null, 2) + '\n');
  const evidencePath = `${prefix}/readback.json`;
  candidate.evidenceCommit = await publication.commit({ [evidencePath]: evidence }, `候选 ${candidate.id}：HTTPS 回读验证`);
  candidate.evidenceUrl = immutableUrl(candidate.evidenceCommit, evidencePath);
  await verify(evidencePath, evidence, candidate.evidenceCommit);
  return readback;
}
