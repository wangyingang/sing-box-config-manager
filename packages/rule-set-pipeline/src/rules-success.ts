import { isDeepStrictEqual } from 'node:util';
import { candidateStableFiles } from './activation.js';
import { matchesRuleDelivery } from './rules-delivery.js';
import { configuredBuildIdentity, configuredBuildTools } from './configured-build.js';
import { inspectBinary, nativeBuildIdentity, NATIVE_VALIDATION_POLICY, type NativeTool } from './native.js';
import { normalizeTerms } from './projection.js';
import type { PublicationSnapshot } from './publication-repository.js';
import { verifyRuleCandidate, type PreparedRulesInput, type RuleBuild, type ValidRuleBuild } from './rules-build.js';
import { rulesBinary } from './rules-context.js';
import { definitionRevision, type ManagedRule, type QualifiedRuleCandidate, type RuleCandidate, type RuleDelivery, type RuleSource, type SuccessfulRuleInput } from './rules-model.js';
import type { RulesSession } from './rules-session.js';

type VerifiedCandidate = Awaited<ReturnType<typeof verifyRuleCandidate>>;
interface BuildIdentity {
  tool: NativeTool;
  tools: object;
  nativeBuildId: string;
}
const digestTools = (tools: object) => configuredBuildIdentity(tools);

export function successfulRuleInput(rule: ManagedRule, source: RuleSource, qualification: QualifiedRuleCandidate): SuccessfulRuleInput {
  return { ...qualification, source, inputBindingRevision: rule.inputBindingRevision, definitionRevision: rule.definitionRevision,
    definitionGeneration: rule.generation };
}

function candidateQualification(candidate: RuleCandidate, build: BuildIdentity): QualifiedRuleCandidate {
  return { toolSha256: build.tool.sha256, buildToolsSha256: digestTools(build.tools), validationPolicy: NATIVE_VALIDATION_POLICY,
    nativeBuildId: build.nativeBuildId, candidateId: candidate.id, buildId: candidate.buildId };
}

function matchesRule(candidate: RuleCandidate, rule: ManagedRule) {
  return candidate.logicalId === rule.definition.id && candidate.status === 'verified' && !candidate.migrationPending
    && candidate.inputBindingRevision === rule.inputBindingRevision && candidate.definitionGeneration === rule.generation
    && definitionRevision(candidate.sourceInput, candidate.definition) === rule.definitionRevision
    && Boolean(candidate.evidenceUrl && candidate.versionId && candidate.publishedAt);
}

export function qualifiedRuleCandidate(rule: ManagedRule, candidate: RuleCandidate, verified: VerifiedCandidate) {
  if (matchesRule(candidate, rule) && verified.candidateId === candidate.id && verified.versionId === candidate.versionId
    && verified.publishedAt === candidate.publishedAt && definitionRevision(candidate.sourceInput, verified.build.definition) === rule.definitionRevision) {
    return candidateQualification(candidate, verified.build);
  }
}

async function currentCandidate(session: RulesSession, rule: ManagedRule, current: RuleDelivery | undefined, stableSnapshot?: PublicationSnapshot) {
  const candidate = current && session.journal.candidates[current.candidateId];
  if (!current || !candidate || !matchesRule(candidate, rule)) return;
  const verified = await verifyRuleCandidate(session, candidate);
  const qualification = qualifiedRuleCandidate(rule, candidate, verified);
  if (!qualification) return;
  const files = candidateStableFiles(verified, current.subscription, rule.definition, session.loaded.context.targetBranch);
  const stable = stableSnapshot ?? await session.stable();
  const record = await stable.read(`${rule.definition.stablePath}/activation.json`);
  if (!record || !isDeepStrictEqual(JSON.parse(record.toString()), current) || !matchesRuleDelivery(current, candidate, files)) return;
  for (const [path, bytes] of Object.entries(files)) {
    if (!(await stable.read(path))?.equals(bytes)) return;
  }
  return { qualification, verified };
}

export async function verifiedDeliveryInput(session: RulesSession, rule: ManagedRule, current: RuleDelivery, stable: PublicationSnapshot) {
  const retained = await currentCandidate(session, rule, current, stable).catch(() => undefined);
  if (retained) return successfulRuleInput(rule, current.source, retained.qualification);
}

export function reusableInputBaseline(rule: ManagedRule, current: RuleDelivery | undefined) {
  const baseline = rule.successfulInput;
  if (baseline && !rule.lastFailure && baseline.candidateId === current?.candidateId
    && baseline.validationPolicy === NATIVE_VALIDATION_POLICY) return baseline;
}

export async function reuseVerifiedInput(session: RulesSession, rule: ManagedRule, current: RuleDelivery | undefined,
  baseline: SuccessfulRuleInput, source: RuleSource) {
  // Missing or unreadable evidence makes the current delivery ineligible for reuse.
  const retained = await currentCandidate(session, rule, current).catch(() => undefined);
  if (!retained || !isDeepStrictEqual(successfulRuleInput(rule, baseline.source, retained.qualification), baseline)) return;
  const [tool, tools] = await Promise.all([inspectBinary(rulesBinary(session.loaded.context)), configuredBuildTools(rule.source.input.format)]);
  if (tool.sha256 !== baseline.toolSha256 || digestTools(tools) !== baseline.buildToolsSha256) return;
  return { ...baseline, source };
}

export async function reuseSuccessfulInput(session: RulesSession, rule: ManagedRule, current: RuleDelivery | undefined,
  input: PreparedRulesInput) {
  const baseline = reusableInputBaseline(rule, current);
  const converted = input.conversionsByRuleId.get(rule.definition.id);
  if (!baseline || !converted?.ok) return;
  const terms = normalizeTerms(converted.terms);
  if (nativeBuildIdentity(baseline.toolSha256, terms) !== baseline.nativeBuildId) return;
  return reuseVerifiedInput(session, rule, current, baseline, input.source);
}

function matchesBuild(verified: VerifiedCandidate, built: RuleBuild, result: ValidRuleBuild) {
  return verified.build.tool.sha256 === result.native.tool.sha256 && isDeepStrictEqual(verified.build.tools, built.tools)
    && verified.build.nativeBuildId === result.native.buildId
    && result.native.artifacts.every(artifact => artifact.content.equals(verified.bytesByFormat[artifact.format]));
}

export async function unchangedBuiltInput(session: RulesSession, rule: ManagedRule, current: RuleDelivery | undefined,
  built: RuleBuild, result: ValidRuleBuild) {
  const retained = await currentCandidate(session, rule, current).catch(() => undefined);
  if (retained && matchesBuild(retained.verified, built, result)) {
    return successfulRuleInput(rule, built.source, retained.qualification);
  }
}

export async function findReusableBuild(session: RulesSession, rule: ManagedRule, built: RuleBuild, result: ValidRuleBuild) {
  for (const candidate of Object.values(session.journal.candidates)) {
    if (candidate.buildId !== result.buildId || !matchesRule(candidate, rule)) continue;
    try {
      const verified = await verifyRuleCandidate(session, candidate);
      if (qualifiedRuleCandidate(rule, candidate, verified) && matchesBuild(verified, built, result)) return candidate;
    } catch {
      // Incomplete evidence cannot qualify this candidate for a new delivery.
    }
  }
}
