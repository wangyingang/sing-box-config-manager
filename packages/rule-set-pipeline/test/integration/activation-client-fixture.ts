import { randomUUID } from 'node:crypto';
import { buildNative } from '../../src/native.js';
import { immutableUrl } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Synthetic source is explicit; these records never claim an official Release. */
export async function syntheticCandidate(binary: string, revision: string, domain: string,
  publish: (files: Record<string, Buffer>) => Promise<string>) {
  const id = randomUUID(), prefix = `candidates/${id}`;
  const native = await buildNative([{ type: 'domain', value: domain }], binary);
  const source = { kind: 'synthetic', description: 'issue-19 A/B controlled fixture', revision };
  const tools = { conversionPolicy: 'synthetic-issue-19' };
  const buildId = sha256(JSON.stringify({ source, tools, nativeBuildId: native.buildId }));
  const files = Object.fromEntries(native.artifacts.map(a => [`${prefix}/${a.file}`, a.content]));
  const filesCommit = await publish(files);
  const artifactId = (file: string) => `v2fly:category-ai-!cn@${id}:${file}`;
  const manifest = { schemaVersion: 1, id: 'v2fly:category-ai-!cn', revision: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    artifacts: native.artifacts.map(a => ({ id: artifactId(a.file), format: a.format,
      url: immutableUrl(filesCommit, `${prefix}/${a.file}`), sha256: a.sha256, byteLength: a.bytes,
      termCount: a.termCount, requiredCapabilities: a.requiredCapabilities })),
    projections: { route: { artifactIds: native.artifacts.map(a => artifactId(a.file)) },
      'dns-query': { artifactIds: native.artifacts.map(a => artifactId(a.file)) }, 'dns-response': { unavailable: 'empty' } } };
  const records = {
    [`${prefix}/manifest.json`]: encode(manifest), [`${prefix}/source.json`]: encode(source),
    [`${prefix}/conversion-report.json`]: encode({ status: 'converted', inputCount: 1, convertedCount: 1,
      outputTermCount: 1, duplicateCount: 0, invalidCount: 0, unsupportedCount: 0, diagnostics: [] }),
    [`${prefix}/build.json`]: encode({ source, tools, buildId, nativeBuildId: native.buildId, status: native.status,
      tool: native.tool, validation: native.validation, usages: native.usages,
      artifacts: native.artifacts.map(({ content: _content, ...a }) => a) }),
  };
  const metadataCommit = await publish(records);
  const readback = [...Object.entries(files).map(([path, content]) => [immutableUrl(filesCommit, path), content] as const),
    ...Object.entries(records).map(([path, content]) => [immutableUrl(metadataCommit, path), content] as const)]
    .map(([url, content]) => ({ url, sha256: sha256(content), byteLength: content.length, exactBytes: true }));
  const evidencePath = `${prefix}/readback.json`;
  const evidenceCommit = await publish({ [evidencePath]: encode({ schemaVersion: 1, candidateId: id,
    status: 'remote-verified', filesCommit, metadataCommit, buildId, readback, native: native.validation, tool: native.tool }) });
  return { id, candidateEvidenceUrl: immutableUrl(evidenceCommit, evidencePath), source, buildId, filesCommit, metadataCommit, evidenceCommit };
}
