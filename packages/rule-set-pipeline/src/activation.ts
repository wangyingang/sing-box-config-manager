import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { saveActivationReceipt } from './activation-receipt.js';
import { configuredBuildIdentity, CONFIGURED_BUILD_RECORD } from './configured-build.js';
import { artifactSubscription, configuredUsages, isProjectedFormat, configuredProjections, nativeTargetForRule, parseProjectedConfiguration, parseStoredRuleDefinition, type RuleDefinition } from './configuration.js';
import { Ajv } from 'ajv';
import manifestSchema from '../contracts/artifact-manifest.schema.json' with { type: 'json' };
import singleArtifactManifestSchema from '../contracts/artifact-manifest-v3.schema.json' with { type: 'json' };
import subscriptionV2Schema from '../contracts/rule-subscription-v2.schema.json' with { type: 'json' };
import { validCommitSource } from './github-commit.js';
import { buildRuleArtifacts, nativeArtifactCommands, nativeBuildIdentity, NATIVE_VALIDATION_POLICY, type NativeBuildOptions } from './native.js';
import { ARTIFACT_MANIFEST_VERSION, SINGLE_ARTIFACT_MANIFEST_VERSION, CANDIDATE_READBACK_VERSION, LEGACY_BUILD_RECORD, RULE_READBACK_VERSION, candidateArtifactFiles, type RuleReadback } from './candidate-publication.js';
import { readCandidateRules } from './sing-box-source-json-adapter.js';
import { USAGES } from './projection.js';
import { sha256, V2FLY_RELEASE_INPUT } from './release.js';
import { validReleaseSource } from './release-source-fact.js';
import { ARTIFACT_REPOSITORY, immutableUrl } from './publication.js';
import { retainedCandidateDownload, type PublicationSnapshot } from './publication-repository.js';
import { activationDigest, effectiveControl, manualControl, openManualActivation, registerManualActivation, type ActivationWriteReservation, type ObservedActivation } from './manual-activation.js';
import { BASELINE_PATH, guardResultGeneration, type ActivationOperation } from './remote-state.js';
import type { RulesRepository } from './rules-repository.js';
import { validRuleSource, type RuleCandidate } from './rules-model.js';
import { activationRecord } from './remote-status.js';
import { ActivationWriteError, githubActivation, type ActivationTransport } from './activation-transport.js';

const ajv = new Ajv({ strict: true });
ajv.addSchema(manifestSchema, 'artifact-manifest.schema.json');
const validateManifest = ajv.getSchema('artifact-manifest.schema.json')!;
const validateSingleArtifactManifest = ajv.compile(singleArtifactManifestSchema);
const validateSubscriptionV2 = ajv.compile(subscriptionV2Schema);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const equal = isDeepStrictEqual;
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export interface ActivationOptions {
  candidateEvidenceUrl: string;
  /** Trusted versioned configuration and exactly one selected logical ID. */
  configuration: string;
  logicalId: string;
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

interface RetainedRuleCandidate {
  candidate: RuleCandidate;
  snapshot: PublicationSnapshot;
  lastChange: RulesRepository['lastChange'];
}

/** Managed candidates use a retained Git snapshot. Historical tooling uses its original transport. */
export async function verifyCandidateEvidence(options: Partial<NativeBuildOptions> & {
  candidateEvidenceUrl: string; evidenceSha256?: string; retained?: RetainedRuleCandidate;
}, transport: { branch: string; download?: ActivationTransport['download'] }, definition?: RuleDefinition,
  operation: 'activate' | 'rollback' = 'activate') {
  const location = candidateLocation(options.candidateEvidenceUrl, 'readback.json');
  const prefix = `candidates/${location.id}`;
  const retained = options.retained;
  const candidate = retained?.candidate;
  const read = async (file: string, url: string) => {
    if (!retained) {
      requireThat(transport.download, 'Candidate read transport unavailable');
      return transport.download(url);
    }
    const bytes = await retained.snapshot.read(`${prefix}/${file}`);
    requireThat(bytes, `Missing retained file: ${file}`);
    return bytes;
  };
  const evidenceBytes = await read('readback.json', options.candidateEvidenceUrl);
  requireThat(options.evidenceSha256 === undefined || options.evidenceSha256 === sha256(evidenceBytes),
    'CANDIDATE_UNAVAILABLE: remote readback differs from registered evidence');
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const rulesOnly = evidence.schemaVersion === RULE_READBACK_VERSION;
  const legacyAudit = !retained && !rulesOnly;
  requireThat((rulesOnly || evidence.schemaVersion === CANDIDATE_READBACK_VERSION)
    && evidence.status === 'remote-verified' && evidence.candidateId === location.id,
    'Missing complete remote candidate verification');
  for (const commit of [evidence.filesCommit, evidence.metadataCommit]) requireThat(/^[a-f0-9]{40}$/.test(commit), 'Invalid candidate commit');
  if (candidate) {
    const version = evidence.versionId ?? (candidate.operation === 'migration' && `${evidence.publishedAt}~${candidate.id.replaceAll('-', '')}`);
    requireThat(candidate.id === location.id && candidate.evidenceCommit === location.commit
      && candidate.filesCommit === evidence.filesCommit && candidate.metadataCommit === evidence.metadataCommit
      && candidate.manifestUrl === immutableUrl(evidence.metadataCommit, `${prefix}/manifest.json`)
      && candidate.versionId === version && candidate.publishedAt === evidence.publishedAt
      && candidate.buildId === evidence.buildId, 'CANDIDATE_UNAVAILABLE: registered candidate identity, stage or version differs');
  }
  requireThat(Array.isArray(evidence.readback) && evidence.readback.length === (rulesOnly ? 2 : 6), 'Missing complete readback records');
  const remote = async (file: string, commit: string, checkReadback = true) => {
    const url = immutableUrl(commit, `${prefix}/${file}`);
    const bytes = await read(file, url);
    if (checkReadback) {
      const records = evidence.readback.filter((record: RuleReadback) => record?.url === url);
      requireThat(records.length === 1 && records[0].exactBytes === true, `Missing readback: ${file}`);
      requireThat(bytes.length > 0 && bytes.length === records[0].byteLength && sha256(bytes) === records[0].sha256, `Readback integrity mismatch: ${file}`);
    }
    return bytes;
  };
  const singleArtifact = definition !== undefined && 'artifact' in definition;
  const manifestVersion = singleArtifact ? SINGLE_ARTIFACT_MANIFEST_VERSION : ARTIFACT_MANIFEST_VERSION;
  const manifest = JSON.parse((await remote('manifest.json', evidence.metadataCommit, legacyAudit)).toString());
  requireThat((singleArtifact ? validateSingleArtifactManifest : validateManifest)(manifest) as boolean, 'Invalid Artifact Manifest');
  requireThat(manifest.id === (definition?.id ?? 'v2fly:category-ai-!cn') && manifest.revision === location.id, 'Candidate identity mismatch');
  const build = JSON.parse((await remote('build.json', evidence.metadataCommit, legacyAudit)).toString());
  const source = candidate?.source ?? (rulesOnly ? build.source : JSON.parse((await remote('source.json', evidence.metadataCommit)).toString()));
  const report = legacyAudit ? JSON.parse((await remote('conversion-report.json', evidence.metadataCommit)).toString()) : undefined;
  if (legacyAudit) requireThat(report && typeof report === 'object', 'Invalid conversion report');
  // Managed evidence binds the expected rule type to its registered source.
  // Older evidence has only a recorded definition, so use its DNS usage.
  const projectedFormat = singleArtifact ? undefined : candidate?.sourceInput.input.format
    ?? (build.definition?.usages?.['dns-response']?.artifact ? 'cidr-text' : 'plain-yaml');
  const layout = projectedFormat !== undefined && isProjectedFormat(projectedFormat) ? configuredUsages(projectedFormat) : undefined;
  if (candidate) {
    requireThat(validRuleSource(candidate.source, candidate.sourceInput), 'Candidate source binding mismatch');
  } else if (source.kind === 'github-commit') {
    requireThat(definition && validCommitSource(source) && source.inputBytes > 0, 'Incomplete official Git source');
  } else if (source.kind === 'synthetic') {
    requireThat(typeof source.description === 'string' && source.description.length > 0 && typeof source.revision === 'string' && source.revision.length > 0,
      'Synthetic candidate must identify its controlled origin');
  } else {
    requireThat(validReleaseSource(source), 'Incomplete official Release source or asset identity');
  }
  const recordedDefinition = candidate?.definition ?? (definition && operation === 'rollback'
    ? parseStoredRuleDefinition(build.definition, projectedFormat ?? (definition.list === undefined ? 'sing-box-source-json' : 'v2fly-dlc-yaml')) : definition);
  const files = candidateArtifactFiles(recordedDefinition);
  const expectedSteps = nativeArtifactCommands(files.source, files.binary);
  const completedNativeSteps = (record: any) => record?.status === 'passed' && record.policy === NATIVE_VALIDATION_POLICY
    && Array.isArray(record.steps) && record.steps.length === expectedSteps.length
    && expectedSteps.every((args, index) => equal(record.steps[index]?.args, args)
      && typeof record.steps[index]?.stdout === 'string' && typeof record.steps[index]?.stderr === 'string');
  const buildPassed = build.status === 'built-validated' && build.validation?.status === 'passed'
    && build.validation.policy === NATIVE_VALIDATION_POLICY && build.tool?.version === '1.14.4' && /^[a-f0-9]{64}$/.test(build.tool.sha256);
  requireThat(buildPassed && (!singleArtifact || equal(build.source, source) && completedNativeSteps(build.validation))
    && (!legacyAudit || equal(build.source, source) && completedNativeSteps(build.validation) && completedNativeSteps(evidence.native)
      && evidence.tool?.version === build.tool.version && evidence.tool.sha256 === build.tool.sha256), 'Incomplete native validation record');
  requireThat(equal(build.contracts, { artifactManifest: manifestVersion, sourceFormat: 4,
    buildRecord: definition ? CONFIGURED_BUILD_RECORD : LEGACY_BUILD_RECORD }), 'Unsupported build contracts');
  const identity = { source, tools: build.tools, nativeBuildId: build.nativeBuildId, contracts: build.contracts };
  if (definition) {
    // A rollback retains its original source selection. Validate that definition
    // and build identity independently, while keeping today's delivery identity.
    requireThat(recordedDefinition && equal(build.definition, recordedDefinition) && recordedDefinition.id === definition.id
      && recordedDefinition.stablePath === definition.stablePath && build.id === definition.id && build.candidateId === location.id
      && build.target?.repository === ARTIFACT_REPOSITORY && build.target?.branch === transport.branch, 'Configured build identity or target mismatch');
  }
  const configuredIdentity = { definition: build.definition, target: build.target, source, tools: build.tools, nativeBuildId: build.nativeBuildId,
    contracts: { sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD } };
  requireThat(build.buildId === evidence.buildId && (definition && build.buildId === configuredBuildIdentity(configuredIdentity)
    || build.buildId === sha256(JSON.stringify(definition ? configuredIdentity : identity))), 'Build identity mismatch');
  if (report) {
    requireThat(['inputCount', 'convertedCount', 'invalidCount', 'unsupportedCount', 'duplicateCount', 'outputTermCount']
      .every(key => Number.isSafeInteger(report[key]) && report[key] >= 0), 'Invalid conversion counts');
    const filtered = report.filteredRules === undefined ? [] : report.filteredRules;
    requireThat(Array.isArray(filtered) && (filtered.length === 0
      || (build.tools?.conversionPolicy === 'typed-domain-text-v1' && filtered.every(rule =>
        rule?.type === 'PROCESS-NAME' && typeof rule.value === 'string' && rule.value.length > 0
        && Number.isSafeInteger(rule.line) && rule.line > 0))), 'Invalid filtered conversion entries');
    requireThat(report.status === 'converted' && report.convertedCount > 0 && report.inputCount === report.convertedCount + filtered.length
      && report.invalidCount === 0 && report.unsupportedCount === 0 && report.diagnostics?.length === 0
      && report.outputTermCount === report.convertedCount - report.duplicateCount, 'Incomplete conversion record');
  }
  if (!singleArtifact) requireThat(manifest.artifacts.length === 2, 'Unsupported candidate projections');
  const artifactIds = manifest.artifacts.map((artifact: any) => artifact.id);
  requireThat(new Set(artifactIds).size === artifactIds.length, 'Duplicate artifact identity');
  const verifyBuildFiles = legacyAudit || singleArtifact;
  if (verifyBuildFiles) requireThat(Array.isArray(build.artifacts) && build.artifacts.length === 2, 'Unexpected build artifact set');
  const sourceBytes = await remote(files.source, evidence.filesCommit);
  const srsBytes = await remote(files.binary, evidence.filesCommit);
  if (retained) {
    for (const [commit, file] of [[evidence.filesCommit, files.source], [evidence.filesCommit, files.binary],
      [evidence.metadataCommit, 'manifest.json'], [location.commit, 'readback.json']]) {
      const changed = await retained.lastChange(commit, `${prefix}/${file}`).catch(error => {
        throw new Error(`CANDIDATE_UNAVAILABLE: Git publication stage missing: ${file}`, { cause: error });
      });
      requireThat(changed === commit, `CANDIDATE_UNAVAILABLE: Git publication stage differs: ${file}`);
    }
  }
  const json = JSON.parse(sourceBytes.toString());
  requireThat(json.version === 4, 'Candidate Source Format mismatch');
  const terms = readCandidateRules(json, singleArtifact, build.tools?.conversionPolicy);
  if (layout) requireThat(terms.every(term => (term.type === 'ip_cidr') === (layout.dns === 'dns-response')),
    'Candidate has incompatible usage content');
  requireThat(!report || report.outputTermCount === terms.length, 'Conversion term count mismatch');
  requireThat(build.nativeBuildId === nativeBuildIdentity(build.tool.sha256, terms), 'Native build identity mismatch');
  const bytesByFormat = { source: sourceBytes, binary: srsBytes };
  for (const format of ['source', 'binary'] as const) {
    const artifact = manifest.artifacts.filter((entry: any) => entry.format === format);
    requireThat(artifact.length === 1, 'Duplicate or missing artifact format');
    const a = artifact[0], bytes = bytesByFormat[format], file = files[format];
    requireThat(a.url === immutableUrl(evidence.filesCommit, `${prefix}/${file}`)
      && a.byteLength === bytes.length && a.sha256 === sha256(bytes)
      && (format === 'binary' || a.termCount === terms.length)
      && a.requiredCapabilities.length === 0, `Artifact integrity or capability mismatch: ${file}`);
    if (verifyBuildFiles) {
      const stored = build.artifacts?.filter((entry: any) => entry.file === file);
      requireThat(stored?.length === 1 && stored[0].sha256 === a.sha256 && stored[0].bytes === a.byteLength
        && (format === 'source' ? stored[0].termCount === a.termCount : !Object.hasOwn(stored[0], 'termCount'))
        && stored[0].format === format && equal(stored[0].requiredCapabilities, []), `Build artifact mismatch: ${file}`);
    }
  }
  if (layout) for (const usage of USAGES) {
    if (usage === layout.unavailable) {
      requireThat(equal(manifest.projections[usage], { unavailable: 'empty' }), 'Projection availability mismatch');
      continue;
    }
    const ids = manifest.projections[usage].artifactIds;
    requireThat(Array.isArray(ids) && ids.length === 2 && new Set(ids).size === 2 && manifest.artifacts.every((entry: any) => ids.includes(entry.id)), 'Projection mapping mismatch');
  }
  const native = options.binary === undefined ? undefined : await (options.nativeBuild ?? buildRuleArtifacts)(
    terms, options.binary, recordedDefinition && nativeTargetForRule(recordedDefinition));
  if (native) for (const format of ['source', 'binary'] as const) {
    const file = files[format];
    const reproduced = native.artifacts.find(entry => entry.file === file);
    requireThat(reproduced?.content.equals(bytesByFormat[format]), `Native artifact mismatch: ${file}`);
  }
  return { candidateId: location.id, buildId: build.buildId, evidenceUrl: options.candidateEvidenceUrl, manifest, source, bytesByFormat,
    versionId: candidate?.versionId ?? evidence.versionId, publishedAt: evidence.publishedAt,
    build: { definition: build.definition, tools: build.tools, tool: build.tool, nativeBuildId: build.nativeBuildId },
    validation: native && { tool: native.tool, buildId: build.buildId, nativeBuildId: native.buildId } };
}

export async function verifyActivationCandidate(options: Pick<ActivationOptions, 'candidateEvidenceUrl' | 'binary'> & { evidenceSha256?: string },
  transport: Pick<ActivationTransport, 'branch' | 'download'>, definition?: RuleDefinition, operation: 'activate' | 'rollback' = 'activate') {
  const candidate = await verifyCandidateEvidence(options, transport, definition, operation);
  requireThat(candidate.validation, 'Missing native validation');
  return { ...candidate, validation: candidate.validation };
}

export interface RollbackOptions extends Omit<ActivationOptions, 'candidateEvidenceUrl'> {
  /** Full artifact-repository commit of a retained successful activation. */
  historicalActivationCommit: string;
}

function activationContext(options: Pick<ActivationOptions, 'configuration' | 'logicalId'>, transport: ActivationTransport) {
  requireThat(options.configuration && options.logicalId, 'Activation requires a configuration and a logical ID (Rule Subscription v2)');
  const configuration = parseProjectedConfiguration(options.configuration);
  const definition = configuration.ruleSets.find(rule => rule.id === options.logicalId);
  requireThat(definition && configuration.target.branch === transport.branch, 'Unknown logical ID or activation target mismatch');
  const git = configuration.sources[definition.source].version === 'git-branch';
  return { definition, git, recordPath: `${definition.stablePath}/activation.json` };
}

/** Revalidate a retained activation against today's contract, without rewriting history. */
export async function rollbackRules(options: RollbackOptions) {
  return performActivation(options);
}

/** Explicit, retryable activation; never mutates Release processing state. */
export async function activateRules(options: ActivationOptions) {
  return performActivation(options);
}

export function activationSubscription(input: unknown, branch: string, definition: RuleDefinition) {
  if ('artifact' in definition) {
    const expected = artifactSubscription(definition, branch);
    requireThat(equal(input, expected), 'Subscription stable files or version mismatch');
    return expected;
  }
  requireThat(validateSubscriptionV2(input) as boolean, 'Invalid Rule Subscription');
  const subscription = input as any;
  requireThat(subscription.systemRuleSetId === definition.id, 'System rule set identity mismatch');
  const expected = configuredProjections(definition, branch);
  for (const usage of USAGES) {
    const projection = subscription.projections[usage], declared = expected[usage];
    if ('unavailable' in declared) {
      requireThat(equal(projection, declared), 'Subscription usage availability mismatch');
    } else {
      requireThat(projection.formats, 'Subscription usage availability mismatch');
      for (const format of ['binary', 'source'] as const) {
        if (projection.formats[format] === undefined) continue;
        requireThat(equal(projection.formats[format], declared.formats[format]), 'Subscription stable path or capability mismatch');
      }
    }
  }
  const sharedUsage = 'artifact' in definition.usages['dns-response'] ? 'dns-response' : 'dns-query';
  requireThat(equal(subscription.projections.route.formats, subscription.projections[sharedUsage].formats), 'Subscription file reuse mismatch');
  if (sharedUsage === 'dns-response') requireThat(subscription.projections.route.formats.source, 'Subscription source format is required');
  return subscription;
}

export function candidateStableFiles(candidate: Awaited<ReturnType<typeof verifyCandidateEvidence>>, subscription: any, definition: RuleDefinition, branch: string) {
  if ('artifact' in definition) {
    const checked = artifactSubscription(definition, branch);
    requireThat(equal(subscription, checked) && candidate.manifest.schemaVersion === SINGLE_ARTIFACT_MANIFEST_VERSION,
      'Candidate or subscription does not describe a single artifact');
    const path = `${definition.stablePath}/${definition.artifact}`;
    return { [`${path}.json`]: candidate.bytesByFormat.source, [`${path}.srs`]: candidate.bytesByFormat.binary };
  }
  const recordPath = `${definition.stablePath}/activation.json`;
  const files: Record<string, Buffer> = {};
  const endpointSignatures = new Map<string, string>();
  const urlPrefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/`;
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
      const signature = JSON.stringify([format, [...endpoint.requiredCapabilities].sort()]);
      requireThat(!endpointSignatures.has(path) || endpointSignatures.get(path) === signature, 'Conflicting stable endpoint declarations');
      endpointSignatures.set(path, signature);
      files[path] = candidate.bytesByFormat[format];
    }
  }
  return files;
}

interface AutomaticActivation {
  journalHead: string;
  register(operation: ActivationOperation): Promise<{
    expectedHead: string; write: ActivationWriteReservation; markNotCommitted(): Promise<void>;
  }>;
  applied(parent: string, commit: string, activation: ObservedActivation & Record<string, unknown>): void;
}

export function activateAutomatically(options: ActivationOptions, coordination: AutomaticActivation) {
  return performActivation(options, coordination);
}

/** Require a reachable activation, not just a Git object with rule bytes. */
async function requireRetainedRollback(transport: ActivationTransport, path: string, head: string, target: string,
  currentCommit?: () => Promise<string | undefined>) {
  if (target === head) return;
  const url = immutableUrl(head, path);
  const unavailable = 'ROLLBACK_UNAVAILABLE: activation is outside retained history';
  let bytes: Buffer;
  try { bytes = await transport.download(url); }
  catch (error) {
    if (error instanceof Error && error.message === `Readback HTTP 404: ${url}`) throw new Error(unavailable);
    throw error;
  }
  const { history } = activationRecord(JSON.parse(bytes.toString()), path, transport.branch);
  requireThat(history.some(entry => entry.commit === target) || await currentCommit?.() === target, unavailable);
}

async function performActivation(options: ActivationOptions | RollbackOptions, automatic?: AutomaticActivation) {
  const transport = options.transport ?? githubActivation();
  requireThat(/^[a-f0-9]{40}$/.test(options.expectedHead), 'Expected full old remote head is required');
  const { definition, git, recordPath } = activationContext(options, transport);
  const subscription = activationSubscription(options.subscription, transport.branch, definition);
  const session = await openManualActivation(transport, options.expectedHead);
  requireThat(await transport.head() === options.expectedHead, 'ACTIVATION_CONFLICT: remote head changed');
  requireThat(!automatic || session.snapshot.head === automatic.journalHead, 'PUBLICATION_CONFLICT: coordination head changed');
  let historical: { commit: string; record: any } | undefined;
  let candidateEvidenceUrl: string;
  if ('historicalActivationCommit' in options) {
    const commit = options.historicalActivationCommit;
    requireThat(/^[a-f0-9]{40}$/.test(commit), 'Expected full historical activation commit');
    if (git || session.snapshot.paths.includes(BASELINE_PATH)) {
      await requireRetainedRollback(transport, recordPath, options.expectedHead, commit,
        git ? async () => session.repository.lastChange?.(options.expectedHead, recordPath) : undefined);
    }
    const value = JSON.parse((await transport.download(immutableUrl(commit, recordPath))).toString());
    const record = git ? activationRecord(value, recordPath, transport.branch).record : value;
    requireThat(record.schemaVersion === 1 && typeof record.id === 'string' && record.id.length > 0
      && typeof record.candidateId === 'string' && typeof record.candidateEvidenceUrl === 'string'
      && record.files && equal(record.subscription, options.subscription)
      && record.logicalId === definition.id && Array.isArray(record.history), 'Invalid or incompatible historical activation');
    historical = { commit, record };
    candidateEvidenceUrl = record.candidateEvidenceUrl;
  } else candidateEvidenceUrl = options.candidateEvidenceUrl;
  const location = candidateLocation(candidateEvidenceUrl, 'readback.json');
  const retained = session.journal.state.candidates[location.id];
  requireThat(!retained || retained.retained && retained.phase === 'complete', 'CANDIDATE_UNAVAILABLE: candidate publication is incomplete or no longer retained');
  const download = retainedCandidateDownload(session.snapshot, location.id, url => transport.download(url));
  if (git) requireThat(retained?.sourceKey && retained.logicalId === definition.id,
    'CANDIDATE_UNAVAILABLE: no registered Git candidate for this rule set');
  const candidate = await verifyActivationCandidate({ candidateEvidenceUrl, binary: options.binary,
    evidenceSha256: retained?.evidenceSha256 }, { branch: transport.branch, download }, definition, historical ? 'rollback' : 'activate');
  requireThat((candidate.source.kind === 'github-commit') === Boolean(git), 'Candidate source type does not match the configuration');
  if (git && retained?.sourceKey) {
    const pin = session.journal.state.commitPins?.[retained.sourceKey];
    requireThat(equal(candidate.source, pin?.source) && candidate.buildId === retained.buildId,
      'CANDIDATE_UNAVAILABLE: candidate source or build identity mismatch');
  }
  // Synthetic origins can never enter the production main branch.
  requireThat(candidate.source.kind !== 'synthetic' || transport.branch.startsWith('acceptance-'), 'Synthetic candidate requires an acceptance branch');
  const files = candidateStableFiles(candidate, subscription, definition, transport.branch);
  if (historical) {
    requireThat(candidate.candidateId === historical.record.candidateId && (!git || equal(candidate.source, historical.record.source)),
      'Historical candidate identity mismatch');
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
      && previous.files && previous.logicalId === definition.id && Array.isArray(previous.history), 'Invalid previous activation record');
    requireThat(!automatic || !effectiveControl(session.journal, definition.id, previous)?.pauseAutomaticActivation, 'Automatic activation is paused');
    requireThat(equal(previous.subscription, subscription), 'Existing subscription contract cannot change during activation');
    requireThat(equal(Object.keys(previous.files).sort(), Object.keys(files).sort()), 'Previous stable file set mismatch');
    for (const [path, metadata] of Object.entries(previous.files) as [string, any][]) {
      const bytes = await transport.download(root + path);
      requireThat(bytes.length === metadata.byteLength && sha256(bytes) === metadata.sha256, 'Previous stable file integrity mismatch');
    }
  }
  let previousCommit = options.expectedHead;
  if (previous && (previous.control || previous.operation === 'automatic') && session.repository.lastChange) {
    previousCommit = await session.repository.lastChange(options.expectedHead, recordPath);
  }
  const id = randomUUID();
  const kind = historical ? 'rollback' as const : 'activate' as const;
  const control = automatic ? undefined : manualControl({ id, kind });
  const activation = { schemaVersion: 1, id,
    ...control && { control },
    ...(automatic ? { operation: 'automatic' as const } : {}),
    logicalId: definition.id, history: previous ? [...previous.history,
      { commit: previousCommit, id: previous.id, candidateId: previous.candidateId }] : [],
    ...(historical ? { operation: 'rollback' as const, historicalActivationCommit: historical.commit, historicalActivationId: historical.record.id } : {}), candidateId: candidate.candidateId,
    candidateEvidenceUrl: candidate.evidenceUrl, source: candidate.source, validation: candidate.validation,
    expectedHead: options.expectedHead, subscription,
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { sha256: sha256(bytes), byteLength: bytes.length }])) };
  const operation = {
    id, kind, logicalId: definition.id, recordPath, generation: session.journal.generation,
    expectedHead: options.expectedHead, ...(previous ? { previousActivationId: previous.id } : {}),
    candidateId: candidate.candidateId, candidateEvidenceUrl: candidate.evidenceUrl,
    activationDigest: activationDigest(activation),
    ...(historical ? { historicalActivationCommit: historical.commit } : {}),
  };
  const reservation = automatic ? await automatic.register({ ...operation, kind: 'automatic' })
    : await registerManualActivation(session, operation);
  const expectedHead = reservation.expectedHead;
  activation.expectedHead = expectedHead;
  files[recordPath] = encode(activation);
  let commit: string;
  try {
    commit = await transport.commit(expectedHead, files,
      `${historical ? '回滚到历史规则候选' : '激活规则候选'} ${candidate.candidateId}`, reservation.write);
  }
  catch (error) {
    // No second write. Resolve a lost PATCH reply using its known immutable identity.
    if (!(error instanceof ActivationWriteError)) {
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
      throw new Error(`ACTIVATION_UNKNOWN: attempted ${error.attemptedCommit}, remote still at expected old state (operation ${id})`, { cause: error });
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
  automatic?.applied(expectedHead, commit, activation);
  // Confirm committed bytes via immutable HTTPS; branch CDN caches may still lag.
  try {
    for (const [path, bytes] of Object.entries(files)) {
      const actual = await transport.download(immutableUrl(commit, path));
      requireThat(actual.equals(bytes), `Committed activation mismatch: ${path}`);
    }
  } catch (error) { throw new Error(`ACTIVATION_APPLIED_READBACK_PENDING: commit ${commit} (operation ${id})`, { cause: error }); }
  if (!automatic) await guardResultGeneration(session.repository, session.journal);
  const result = { status: 'activated' as const, commit, activation };
  if (options.stateDirectory) {
    await saveActivationReceipt(options.stateDirectory, result, definition.id);
  }
  return result;
}
