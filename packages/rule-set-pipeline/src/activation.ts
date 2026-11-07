import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { saveActivationReceipt } from './activation-receipt.js';
import { parseBuildConfiguration, type RuleDefinition } from './configured-build.js';
import { Ajv } from 'ajv';
import manifestSchema from '../contracts/artifact-manifest.schema.json' with { type: 'json' };
import subscriptionSchema from '../contracts/rule-subscription.schema.json' with { type: 'json' };
import subscriptionV2Schema from '../contracts/rule-subscription-v2.schema.json' with { type: 'json' };
import { buildNative } from './native.js';
import { decodedTerms, USAGES } from './projection.js';
import { sha256 } from './release.js';
import { ARTIFACT_REPOSITORY, immutableUrl } from './publication.js';
import { retainedCandidateDownload } from './publication-repository.js';
import { manualControl, openManualActivation, registerManualActivation } from './manual-activation.js';
import { ActivationWriteError, githubActivation, isConfiguredActivationPath, type ActivationTransport } from './activation-transport.js';

const ajv = new Ajv({ strict: true });
const validateManifest = ajv.compile(manifestSchema);
const validateSubscription = ajv.compile(subscriptionSchema);
const validateSubscriptionV2 = ajv.compile(subscriptionV2Schema);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const equal = isDeepStrictEqual;
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const RECORD_PATH = 'stable/activation.json';
export interface ActivationOptions {
  candidateEvidenceUrl: string;
  /** Trusted versioned configuration and exactly one selected logical ID. */
  configuration?: string;
  logicalId?: string;
  stateDirectory?: string;
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
export async function verifyActivationCandidate(options: Pick<ActivationOptions, 'candidateEvidenceUrl' | 'binary'>, transport: Pick<ActivationTransport, 'branch' | 'download'>,
  definition?: RuleDefinition, operation: 'activate' | 'rollback' = 'activate') {
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
  requireThat(manifest.id === (definition?.id ?? 'v2fly:category-ai-!cn') && manifest.revision === location.id, 'Candidate identity mismatch');
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
  // Historical candidates predate explicit contract versions in the build identity.
  const identity = { source, tools: build.tools, nativeBuildId: build.nativeBuildId };
  if (build.contracts !== undefined) {
    requireThat(build.contracts !== null && typeof build.contracts === 'object' && !Array.isArray(build.contracts)
      && Object.keys(build.contracts).length === 3 && build.contracts.artifactManifest === 1
      && build.contracts.sourceFormat === 4 && build.contracts.buildRecord === 1, 'Unsupported build contracts');
  }
  if (definition) {
    // A rollback retains its original source selection. Validate that definition
    // and build identity independently, while keeping today's delivery identity.
    const expectedDefinition = operation === 'rollback' ? parseBuildConfiguration(JSON.stringify({ schemaVersion: 1,
      source: 'v2fly/domain-list-community', target: build.target, ruleSets: [build.definition] })).ruleSets[0] : definition;
    requireThat(equal(build.definition, expectedDefinition) && expectedDefinition.id === definition.id
      && expectedDefinition.stablePath === definition.stablePath && build.id === definition.id && build.candidateId === location.id
      && build.target?.repository === ARTIFACT_REPOSITORY && build.target?.branch === transport.branch
      && build.contracts !== undefined, 'Configured build identity or target mismatch');
  }
  const configuredIdentity = { definition: build.definition, target: build.target, source, tools: build.tools, nativeBuildId: build.nativeBuildId,
    contracts: { sourceFormat: 4, buildRecord: 1 } };
  requireThat(build.buildId === evidence.buildId && build.buildId === sha256(JSON.stringify(
    definition ? configuredIdentity : build.contracts === undefined ? identity : { ...identity, contracts: build.contracts })), 'Build identity mismatch');
  requireThat(['inputCount', 'convertedCount', 'invalidCount', 'unsupportedCount', 'duplicateCount', 'outputTermCount']
    .every(key => Number.isSafeInteger(report[key]) && report[key] >= 0), 'Invalid conversion counts');
  requireThat(report.status === 'converted' && report.inputCount > 0 && report.inputCount === report.convertedCount
    && report.invalidCount === 0 && report.unsupportedCount === 0 && report.diagnostics?.length === 0
    && report.outputTermCount === report.convertedCount - report.duplicateCount, 'Incomplete conversion record');
  // The initial production slice supports the official pure-domain list and matching controlled fixtures.
  requireThat(manifest.artifacts.length === 2 && manifest.projections['dns-response'].unavailable === 'empty', 'Unsupported candidate projections');
  const artifactIds = manifest.artifacts.map((artifact: any) => artifact.id);
  requireThat(new Set(artifactIds).size === artifactIds.length, 'Duplicate artifact identity');
  requireThat(build.artifacts?.length === 2, 'Unexpected build artifact set');
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
    requireThat(Array.isArray(ids) && ids.length === 2 && new Set(ids).size === 2 && manifest.artifacts.every((entry: any) => ids.includes(entry.id)), 'Projection mapping mismatch');
  }
  return { candidateId: location.id, evidenceUrl: options.candidateEvidenceUrl, manifest, source, bytesByFormat,
    validation: { tool: native.tool, buildId: build.buildId, nativeBuildId: native.buildId } };
}

export interface RollbackOptions extends Omit<ActivationOptions, 'candidateEvidenceUrl'> {
  /** Full artifact-repository commit of a retained successful activation. */
  historicalActivationCommit: string;
}

function activationContext(options: Pick<ActivationOptions, 'configuration' | 'logicalId'>, transport: ActivationTransport) {
  const configured = options.configuration !== undefined || options.logicalId !== undefined;
  const configuration = configured ? parseBuildConfiguration(options.configuration ?? '') : undefined;
  const definition = configuration?.ruleSets.find(rule => rule.id === options.logicalId);
  if (configured) requireThat(definition && configuration?.target.branch === transport.branch, 'Unknown logical ID or activation target mismatch');
  return { configured, definition, recordPath: definition ? `${definition.stablePath}/activation.json` : RECORD_PATH };
}

/** Revalidate a retained activation against today's contract, without rewriting history. */
export async function rollbackRules(options: RollbackOptions) {
  return performActivation(options);
}

/** Explicit, retryable activation; never mutates Release processing state. */
export async function activateRules(options: ActivationOptions) {
  return performActivation(options);
}

async function performActivation(options: ActivationOptions | RollbackOptions) {
  const transport = options.transport ?? githubActivation();
  requireThat(/^[a-f0-9]{40}$/.test(options.expectedHead), 'Expected full old remote head is required');
  const { configured, definition, recordPath } = activationContext(options, transport);
  requireThat((configured ? validateSubscriptionV2 : validateSubscription)(options.subscription) as boolean, 'Invalid Rule Subscription');
  const subscription = options.subscription as any;
  requireThat(subscription.systemRuleSetId === (definition?.id ?? 'v2fly:domain-list-community:category-ai-!cn'), 'System rule set identity mismatch');
  if (definition) {
    requireThat(subscription.projections['dns-response'].unavailable === 'empty', 'Subscription usage availability mismatch');
    const expectedFormats = subscription.projections.route.formats;
    requireThat(expectedFormats && equal(expectedFormats, subscription.projections['dns-query'].formats), 'Subscription file reuse mismatch');
    for (const [format, endpoint] of Object.entries(expectedFormats) as [string, any][]) {
      const file = format === 'binary' ? 'domains.srs' : 'domains.json';
      requireThat(endpoint.url === `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${transport.branch}/${definition.stablePath}/${file}`
        && equal(endpoint.requiredCapabilities, []), 'Subscription stable path or capability mismatch');
    }
  }
  requireThat(await transport.head() === options.expectedHead, 'ACTIVATION_CONFLICT: remote head changed');
  const session = definition ? await openManualActivation(transport, options.expectedHead) : undefined;
  let historical: { commit: string; record: any } | undefined;
  let candidateEvidenceUrl: string;
  if ('historicalActivationCommit' in options) {
    const commit = options.historicalActivationCommit;
    requireThat(/^[a-f0-9]{40}$/.test(commit), 'Expected full historical activation commit');
    const record = JSON.parse((await transport.download(immutableUrl(commit, recordPath))).toString());
    requireThat(record.schemaVersion === 1 && typeof record.id === 'string' && record.id.length > 0
      && typeof record.candidateId === 'string' && typeof record.candidateEvidenceUrl === 'string'
      && record.files && equal(record.subscription, options.subscription)
      && (!definition || (record.logicalId === definition.id && Array.isArray(record.history))), 'Invalid or incompatible historical activation');
    historical = { commit, record };
    candidateEvidenceUrl = record.candidateEvidenceUrl;
  } else candidateEvidenceUrl = options.candidateEvidenceUrl;
  const location = candidateLocation(candidateEvidenceUrl, 'readback.json');
  const retained = session?.journal.state.candidates[location.id];
  requireThat(!retained || retained.retained && retained.phase === 'complete', 'CANDIDATE_UNAVAILABLE: candidate publication is incomplete or no longer retained');
  const download = session
    ? retainedCandidateDownload(session.snapshot, location.id, url => transport.download(url))
    : (url: string) => transport.download(url);
  const candidate = await verifyActivationCandidate({ candidateEvidenceUrl, binary: options.binary }, { branch: transport.branch, download },
    definition, historical ? 'rollback' : 'activate');
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
      requireThat(/^stable\/[a-z0-9/_.-]+\.(srs|json)$/.test(path) && !path.split('/').includes('..') && path !== recordPath, 'Invalid stable rule path');
      requireThat(configured || !isConfiguredActivationPath(path), 'Legacy subscription cannot write a configured rule endpoint');
      const signature = JSON.stringify([format, [...endpoint.requiredCapabilities].sort()]);
      requireThat(!endpointSignatures.has(path) || endpointSignatures.get(path) === signature, 'Conflicting stable endpoint declarations');
      endpointSignatures.set(path, signature);
      files[path] = candidate.bytesByFormat[format];
    }
  }
  if (historical) {
    requireThat(candidate.candidateId === historical.record.candidateId, 'Historical candidate identity mismatch');
    const entries = Object.entries(files);
    requireThat(Object.keys(historical.record.files).length === entries.length, 'Historical stable file set mismatch');
    for (const [path, bytes] of entries) {
      const recorded = historical.record.files[path];
      requireThat(recorded?.sha256 === sha256(bytes) && recorded?.byteLength === bytes.length, 'Historical stable file metadata mismatch');
      const retained = await transport.download(immutableUrl(historical.commit, path));
      requireThat(retained.equals(bytes), 'Historical stable file integrity mismatch');
    }
  }
  // Existing contract is part of the remote old state, not a mutable local status file.
  const root = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${options.expectedHead}/`;
  // Transport must distinguish an absent record (404) from an unavailable server.
  let previousBytes: Buffer | undefined;
  let previous: any;
  try { previousBytes = await transport.download(root + recordPath); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Readback HTTP 404: ')) throw error;
  }
  if (previousBytes) {
    previous = JSON.parse(previousBytes.toString());
    requireThat(previous.schemaVersion === 1 && typeof previous.id === 'string' && typeof previous.candidateId === 'string'
      && previous.files && (!definition || (previous.logicalId === definition.id && Array.isArray(previous.history))), 'Invalid previous activation record');
    requireThat(equal(previous.subscription, subscription), 'Existing subscription contract cannot change during activation');
    requireThat(equal(Object.keys(previous.files).sort(), Object.keys(files).sort()), 'Previous stable file set mismatch');
    for (const [path, metadata] of Object.entries(previous.files) as [string, any][]) {
      const bytes = await transport.download(root + path);
      requireThat(bytes.length === metadata.byteLength && sha256(bytes) === metadata.sha256, 'Previous stable file integrity mismatch');
    }
  }
  const id = randomUUID();
  const kind = historical ? 'rollback' as const : 'activate' as const;
  const reservation = session && definition ? await registerManualActivation(session, {
    id, kind, logicalId: definition.id, recordPath, generation: session.journal.generation,
    expectedHead: options.expectedHead, ...(previous ? { previousActivationId: previous.id } : {}),
    candidateId: candidate.candidateId, candidateEvidenceUrl: candidate.evidenceUrl,
    ...(historical ? { historicalActivationCommit: historical.commit } : {}),
  }) : undefined;
  const expectedHead = reservation?.expectedHead ?? options.expectedHead;
  const activation = { schemaVersion: 1, id,
    ...(reservation ? { control: manualControl({ id, kind }) } : {}),
    ...(definition ? { logicalId: definition.id, history: previous ? [...previous.history,
      { commit: options.expectedHead, id: previous.id, candidateId: previous.candidateId }] : [] } : {}),
    ...(historical ? { operation: 'rollback' as const, historicalActivationCommit: historical.commit, historicalActivationId: historical.record.id } : {}), candidateId: candidate.candidateId,
    candidateEvidenceUrl: candidate.evidenceUrl, source: candidate.source, validation: candidate.validation,
    expectedHead, subscription,
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { sha256: sha256(bytes), byteLength: bytes.length }])) };
  files[recordPath] = encode(activation);
  let commit: string;
  try {
    await reservation?.guard();
    commit = await transport.commit(expectedHead, files,
      `${historical ? '回滚到历史规则候选' : '激活规则候选'} ${candidate.candidateId}`, reservation?.guard);
  }
  catch (error) {
    // No second write. Resolve a lost PATCH reply using its known immutable identity.
    if (!(error instanceof ActivationWriteError)) {
      if (!reservation) throw error;
      try { await reservation.markNotCommitted(); }
      catch (checkpointError) {
        throw new Error(`ACTIVATION_NOT_APPLIED: operation ${id}; ${String(error)}; outcome checkpoint failed: ${String(checkpointError)}`, { cause: error });
      }
      throw new Error(`ACTIVATION_NOT_APPLIED: operation ${id}; ${String(error)}`, { cause: error });
    }
    let head: string;
    try { head = await transport.head(); }
    catch { throw new Error(`ACTIVATION_UNKNOWN: cannot reconcile ${error.attemptedCommit} (operation ${id})`, { cause: error }); }
    if (head === error.attemptedCommit) commit = head;
    else if (head === expectedHead) {
      const code = reservation ? 'ACTIVATION_UNKNOWN' : 'ACTIVATION_NOT_APPLIED';
      throw new Error(`${code}: attempted ${error.attemptedCommit}, remote still at expected old state (operation ${id})`, { cause: error });
    }
    else {
      // A later commit may retain this set unchanged. Its unique record proves application.
      try {
        const current = await transport.download(immutableUrl(head, recordPath));
        requireThat(current.equals(files[recordPath]), 'Activation was superseded or not applied');
        commit = error.attemptedCommit;
      } catch { throw new Error(`ACTIVATION_CONFLICT_OR_SUPERSEDED: remote ${head}, attempted ${error.attemptedCommit} (operation ${id})`, { cause: error }); }
    }
  }
  // Confirm committed bytes via immutable HTTPS; branch CDN caches may still lag.
  try {
    for (const [path, bytes] of Object.entries(files)) {
      const actual = await transport.download(immutableUrl(commit, path));
      requireThat(actual.equals(bytes), `Committed activation mismatch: ${path}`);
    }
  } catch (error) { throw new Error(`ACTIVATION_APPLIED_READBACK_PENDING: commit ${commit} (operation ${id})`, { cause: error }); }
  const result = { status: 'activated' as const, commit, activation };
  if (definition && options.stateDirectory) {
    await saveActivationReceipt(options.stateDirectory, result, definition.id);
  }
  return result;
}
