import { randomUUID } from 'node:crypto';
import { CONFIGURED_BUILD_RECORD, type RuleDefinition } from '../../src/configured-build.js';
import { buildNative } from '../../src/native.js';
import { immutableUrl } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Synthetic source is explicit; these records never claim an official Release. */
export async function syntheticCandidate(binary: string, revision: string, domain: string,
  publish: (files: Record<string, Buffer>) => Promise<string>,
  configured?: { definition: RuleDefinition; target: { repository: string; branch: string } }) {
  const id = randomUUID(), prefix = `candidates/${id}`;
  const native = await buildNative([{ type: 'domain', value: domain }], binary);
  const source = { kind: 'synthetic', description: `Controlled synthetic origin ${revision}`, revision };
  const tools = { conversionPolicy: 'synthetic-issue-19' };
  const contracts = { artifactManifest: 1, sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD };
  const buildId = sha256(JSON.stringify(configured ? { ...configured, source, tools, nativeBuildId: native.buildId,
    contracts: { sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD } } : { source, tools, nativeBuildId: native.buildId }));
  const logicalId = configured?.definition.id ?? 'v2fly:category-ai-!cn';
  const files = Object.fromEntries(native.artifacts.map(a => [`${prefix}/${a.file}`, a.content]));
  const filesCommit = await publish(files);
  const artifactId = (file: string) => `${logicalId}@${id}:${file}`;
  const manifest = { schemaVersion: 1, id: logicalId, revision: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    artifacts: native.artifacts.map(a => ({ id: artifactId(a.file), format: a.format,
      url: immutableUrl(filesCommit, `${prefix}/${a.file}`), sha256: a.sha256, byteLength: a.bytes,
      termCount: a.termCount, requiredCapabilities: a.requiredCapabilities })),
    projections: { route: { artifactIds: native.artifacts.map(a => artifactId(a.file)) },
      'dns-query': { artifactIds: native.artifacts.map(a => artifactId(a.file)) }, 'dns-response': { unavailable: 'empty' } } };
  const records = {
    [`${prefix}/manifest.json`]: encode(manifest), [`${prefix}/source.json`]: encode(source),
    [`${prefix}/conversion-report.json`]: encode({ status: 'converted', inputCount: 1, convertedCount: 1,
      outputTermCount: 1, duplicateCount: 0, invalidCount: 0, unsupportedCount: 0, diagnostics: [] }),
    [`${prefix}/build.json`]: encode({ ...(configured ? { ...configured, id: logicalId, candidateId: id, contracts } : {}), source, tools, buildId, nativeBuildId: native.buildId, status: native.status,
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
