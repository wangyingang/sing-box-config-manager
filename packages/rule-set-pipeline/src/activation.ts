import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import manifestSchema from '../contracts/artifact-manifest.schema.json' with { type: 'json' };
import subscriptionSchema from '../contracts/rule-subscription.schema.json' with { type: 'json' };
import { buildNative } from './native.js';
import { decodedTerms, USAGES } from './projection.js';
import { sha256 } from './release.js';
import { ARTIFACT_REPOSITORY, immutableUrl } from './publication.js';
import { ActivationWriteError, githubActivation, type ActivationTransport } from './activation-transport.js';

const ajv = new Ajv({ strict: true });
const validateManifest = ajv.compile(manifestSchema);
const validateSubscription = ajv.compile(subscriptionSchema);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const RECORD_PATH = 'stable/activation.json';
export interface ActivationOptions {
  candidateEvidenceUrl: string;
  /** Trusted host-owned contract, never a client-supplied URL override. */
  subscription: unknown;
  binary: string;
  expectedHead: string;
  transport?: ActivationTransport;
}
function candidateLocation(url: string, file: string) {
  const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
  requireThat(typeof url === 'string' && url.startsWith(prefix), 'Untrusted candidate URL');
  const match = /^([a-f0-9]{40})\/candidates\/([a-f0-9-]+)\/([a-z0-9.-]+)$/.exec(url.slice(prefix.length));
  requireThat(match && match[3] === file, 'Candidate URL must pin a full commit and expected file');
  return { commit: match[1], id: match[2] };
}

/** Reads the complete trusted remote record chain and validates actual bytes afresh. */
export async function verifyActivationCandidate(options: Pick<ActivationOptions, 'candidateEvidenceUrl' | 'binary'>, transport: ActivationTransport) {
  const location = candidateLocation(options.candidateEvidenceUrl, 'readback.json');
  const evidence = JSON.parse((await transport.download(options.candidateEvidenceUrl)).toString('utf8'));
  requireThat(evidence.schemaVersion === 1 && evidence.status === 'remote-verified' && evidence.candidateId === location.id,
    'Missing complete remote candidate verification');
  for (const commit of [evidence.filesCommit, evidence.metadataCommit]) requireThat(/^[a-f0-9]{40}$/.test(commit), 'Invalid candidate commit');
  requireThat(Array.isArray(evidence.readback) && evidence.readback.length === 6, 'Missing complete readback records');
  const prefix = `candidates/${location.id}`;
  const remote = async (file: string, commit: string) => {
    const url = immutableUrl(commit, `${prefix}/${file}`);
    const records = evidence.readback.filter((record: any) => record.url === url);
    requireThat(records.length === 1 && records[0].exactBytes === true, `Missing readback: ${file}`);
    const bytes = await transport.download(url);
    requireThat(bytes.length > 0 && bytes.length === records[0].byteLength && sha256(bytes) === records[0].sha256, `Readback integrity mismatch: ${file}`);
    return bytes;
  };
  const manifest = JSON.parse((await remote('manifest.json', evidence.metadataCommit)).toString());
  requireThat(validateManifest(manifest) as boolean, 'Invalid Artifact Manifest');
  requireThat(manifest.id === 'v2fly:category-ai-!cn' && manifest.revision === location.id, 'Candidate identity mismatch');
  const source = JSON.parse((await remote('source.json', evidence.metadataCommit)).toString());
  const report = JSON.parse((await remote('conversion-report.json', evidence.metadataCommit)).toString());
  const build = JSON.parse((await remote('build.json', evidence.metadataCommit)).toString());
  if (source.kind === 'synthetic') {
    requireThat(typeof source.description === 'string' && source.description.length > 0 && typeof source.revision === 'string' && source.revision.length > 0,
      'Synthetic candidate must identify its controlled origin');
  } else {
    requireThat(source.repository === 'v2fly/domain-list-community' && Number.isSafeInteger(source.releaseId) && source.releaseId > 0
      && /^[a-f0-9]{40}$/.test(source.commit) && /^[0-9]{14}$/.test(source.tag)
      && /^[a-f0-9]{64}$/.test(source.inputSha256) && Number.isSafeInteger(source.inputBytes) && source.inputBytes > 0 && /^[a-f0-9]{64}$/.test(source.checksumSha256), 'Incomplete official source');
    for (const [key, name] of [['yaml', 'dlc.dat_plain.yml'], ['checksum', 'dlc.dat_plain.yml.sha256sum']] as const) {
      requireThat(source[key]?.name === name && Number.isSafeInteger(source[key].id) && source[key].id > 0
        && source[key].url === `https://github.com/v2fly/domain-list-community/releases/download/${source.tag}/${name}`, 'Incomplete source asset identity');
    }
  }
  requireThat(equal(build.source, source) && build.status === 'built-validated' && build.validation?.status === 'passed'
    && build.validation.semanticRoundTrip === true && Array.isArray(build.validation.steps) && build.validation.steps.length >= 4
    && build.tool?.version === '1.14.4' && /^[a-f0-9]{64}$/.test(build.tool.sha256)
    && evidence.native?.status === 'passed' && evidence.native.semanticRoundTrip === true
    && evidence.tool?.sha256 === build.tool.sha256, 'Incomplete native validation record');
  requireThat(build.buildId === evidence.buildId && build.buildId === sha256(JSON.stringify({ source, tools: build.tools, nativeBuildId: build.nativeBuildId })), 'Build identity mismatch');
  requireThat(['inputCount', 'convertedCount', 'invalidCount', 'unsupportedCount', 'duplicateCount', 'outputTermCount']
    .every(key => Number.isSafeInteger(report[key]) && report[key] >= 0), 'Invalid conversion counts');
  requireThat(report.status === 'converted' && report.inputCount > 0 && report.inputCount === report.convertedCount
    && report.invalidCount === 0 && report.unsupportedCount === 0 && report.diagnostics?.length === 0
    && report.outputTermCount === report.convertedCount - report.duplicateCount, 'Incomplete conversion record');
  // The initial production slice supports the official pure-domain list and matching controlled fixtures.
  requireThat(manifest.artifacts.length === 2 && manifest.projections['dns-response'].unavailable === 'empty', 'Unsupported candidate projections');
  const sourceBytes = await remote('domains.json', evidence.filesCommit);
  const srsBytes = await remote('domains.srs', evidence.filesCommit);
  const json = JSON.parse(sourceBytes.toString());
  requireThat(json.version === 4, 'Candidate Source Format mismatch');
  const terms = decodedTerms(json);
  requireThat(terms.length > 0 && terms.every(term => term.type !== 'ip_cidr'), 'Candidate has empty or incompatible usage content');
  requireThat(report.outputTermCount === terms.length, 'Conversion term count mismatch');
  const native = await buildNative(terms, options.binary);
  requireThat(build.nativeBuildId === sha256(JSON.stringify({ policy: 'native-projection-v2', sourceFormat: 4,
    tool: build.tool.sha256, terms })), 'Native build identity mismatch');
  const bytesByFormat = { source: sourceBytes, binary: srsBytes };
  for (const format of ['source', 'binary'] as const) {
    const artifact = manifest.artifacts.filter((entry: any) => entry.format === format);
    requireThat(artifact.length === 1, 'Duplicate or missing artifact format');
    const a = artifact[0], bytes = bytesByFormat[format], file = format === 'source' ? 'domains.json' : 'domains.srs';
    requireThat(a.url === immutableUrl(evidence.filesCommit, `${prefix}/${file}`)
      && a.byteLength === bytes.length && a.sha256 === sha256(bytes) && a.termCount === terms.length
      && a.requiredCapabilities.length === 0, `Artifact integrity or capability mismatch: ${file}`);
    const stored = build.artifacts?.filter((entry: any) => entry.file === file);
    requireThat(stored?.length === 1 && stored[0].sha256 === a.sha256 && stored[0].bytes === a.byteLength
      && stored[0].termCount === a.termCount && stored[0].format === format && equal(stored[0].requiredCapabilities, []), 'Build artifact mismatch');
    // buildNative recompiles, decodes and loads both formats; exact bytes prove downloaded SRS is that validated file.
    requireThat(native.artifacts.find(entry => entry.file === file)?.content.equals(bytes), `Native artifact mismatch: ${file}`);
  }
  for (const usage of ['route', 'dns-query'] as const) {
    const ids = manifest.projections[usage].artifactIds;
    requireThat(Array.isArray(ids) && ids.length === 2 && manifest.artifacts.every((entry: any) => ids.includes(entry.id)), 'Projection mapping mismatch');
  }
  return { candidateId: location.id, evidenceUrl: options.candidateEvidenceUrl, manifest, source, bytesByFormat,
    validation: { tool: native.tool, buildId: build.buildId, nativeBuildId: native.buildId } };
}

/** Explicit, retryable activation; never mutates Release processing state. */
export async function activateRules(options: ActivationOptions) {
  const transport = options.transport ?? githubActivation();
  requireThat(/^[a-f0-9]{40}$/.test(options.expectedHead), 'Expected full old remote head is required');
  requireThat(validateSubscription(options.subscription) as boolean, 'Invalid Rule Subscription');
  const subscription = options.subscription as any;
  requireThat(subscription.systemRuleSetId === 'v2fly:domain-list-community:category-ai-!cn', 'System rule set identity mismatch');
  requireThat(await transport.head() === options.expectedHead, 'ACTIVATION_CONFLICT: remote head changed');
  const candidate = await verifyActivationCandidate(options, transport);
  // Synthetic origins can never enter the production main branch.
  requireThat(candidate.source.kind !== 'synthetic' || transport.branch.startsWith('acceptance-'), 'Synthetic candidate requires an acceptance branch');
  const files: Record<string, Buffer> = {};
  const endpointSignatures = new Map<string, string>();
  const urlPrefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${transport.branch}/`;
  for (const usage of USAGES) {
    const expected = subscription.projections[usage], actual = candidate.manifest.projections[usage];
    if ('unavailable' in expected) {
      requireThat(actual.unavailable === expected.unavailable, 'Subscription usage availability mismatch');
      continue;
    }
    requireThat(Array.isArray(actual.artifactIds), 'Subscription usage unavailable');
    for (const [format, endpoint] of Object.entries(expected.formats) as [keyof typeof candidate.bytesByFormat, any][]) {
      const artifact = candidate.manifest.artifacts.find((entry: any) => entry.format === format && actual.artifactIds.includes(entry.id));
      requireThat(artifact && artifact.requiredCapabilities.every((capability: string) => endpoint.requiredCapabilities.includes(capability)), 'Subscription format or capability mismatch');
      requireThat(endpoint.url.startsWith(urlPrefix), 'Unapproved stable subscription host or branch');
      const path = endpoint.url.slice(urlPrefix.length);
      requireThat(/^stable\/[a-z0-9/-]+\.(srs|json)$/.test(path) && !path.split('/').includes('..') && path !== RECORD_PATH, 'Invalid stable rule path');
      const signature = JSON.stringify([format, [...endpoint.requiredCapabilities].sort()]);
      requireThat(!endpointSignatures.has(path) || endpointSignatures.get(path) === signature, 'Conflicting stable endpoint declarations');
      endpointSignatures.set(path, signature);
      files[path] = candidate.bytesByFormat[format];
    }
  }
  // Existing contract is part of the remote old state, not a mutable local status file.
  const root = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${options.expectedHead}/`;
  // Transport must distinguish an absent record (404) from an unavailable server.
  try {
    const previous = JSON.parse((await transport.download(root + RECORD_PATH)).toString());
    requireThat(equal(previous.subscription, subscription), 'Existing subscription contract cannot change during activation');
  } catch (error) {
    if (!(error instanceof Error) || !/Readback HTTP 404:/.test(error.message)) throw error;
  }
  const activation = { schemaVersion: 1, id: randomUUID(), candidateId: candidate.candidateId,
    candidateEvidenceUrl: candidate.evidenceUrl, source: candidate.source, validation: candidate.validation,
    expectedHead: options.expectedHead, subscription,
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { sha256: sha256(bytes), byteLength: bytes.length }])) };
  files[RECORD_PATH] = encode(activation);
  let commit: string;
  try { commit = await transport.commit(options.expectedHead, files, `激活规则候选 ${candidate.candidateId}`); }
  catch (error) {
    // No second write. Resolve a lost PATCH reply using its known immutable identity.
    if (!(error instanceof ActivationWriteError)) throw error;
    let head: string;
    try { head = await transport.head(); }
    catch { throw new Error(`ACTIVATION_UNKNOWN: cannot reconcile ${error.attemptedCommit}`, { cause: error }); }
    if (head === error.attemptedCommit) commit = head;
    else if (head === options.expectedHead) throw new Error('ACTIVATION_NOT_APPLIED: remote still at expected old state', { cause: error });
    else throw new Error(`ACTIVATION_CONFLICT_OR_SUPERSEDED: remote ${head}, attempted ${error.attemptedCommit}`, { cause: error });
  }
  // Confirm committed bytes via immutable HTTPS; branch CDN caches may still lag.
  try {
    for (const [path, bytes] of Object.entries(files)) {
      const actual = await transport.download(immutableUrl(commit, path));
      requireThat(actual.equals(bytes), `Committed activation mismatch: ${path}`);
    }
  } catch (error) { throw new Error(`ACTIVATION_APPLIED_READBACK_PENDING: commit ${commit}`, { cause: error }); }
  return { status: 'activated' as const, commit, activation };
}
