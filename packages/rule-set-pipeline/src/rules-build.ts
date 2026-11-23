import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyCandidateEvidence } from './activation.js';
import { buildConfigured, convertInput } from './configured-build.js';
import { publishConfiguredCandidate } from './configured-update.js';
import { configuredRuleInput, type RuleDefinition, type SourceInput } from './configuration.js';
import { candidateInputSnapshot, ruleSourceAdapter } from './rule-source-adapters.js';
import type { RulesRepository } from './rules-repository.js';
import type { PublicationSnapshot } from './publication-repository.js';
import type { NativeBuildOptions } from './native.js';
import { immutableUrl, type PublicationTransport } from './publication.js';
import { inputBindingRevision, parseRulesJournal, type ManagedRule, type RuleCandidate, type RuleSource } from './rules-model.js';
import { rulesBinary, type LoadedRules } from './rules-context.js';
import type { RulesSession } from './rules-session.js';

export type RuleBuild = Awaited<ReturnType<typeof buildRulesInput>>;
export type ValidRuleBuild = Extract<RuleBuild['results'][number], { status: 'built-validated' }>;

interface FixedRuleInput {
  candidate: RuleCandidate;
  snapshot: PublicationSnapshot;
}

export interface PreparedRulesInput {
  source: RuleSource;
  conversionsByRuleId: ReturnType<typeof convertInput>;
  inputSnapshot?: Uint8Array;
  format: SourceInput['input']['format'];
  file: string;
}

/** Pin a shared source once, then read and convert only the lists that need its body. */
export async function resolveRulesInput(loaded: LoadedRules, definitions: RuleDefinition[], fixed?: FixedRuleInput) {
  const input = fixed?.candidate.sourceInput ?? configuredRuleInput(loaded.configuration, definitions[0]);
  const adapter = ruleSourceAdapter(input);
  const network = { fetch: loaded.context.fetch, token: loaded.context.token };
  const probe = fixed
    ? await adapter.openFixed(network, fixed.candidate, fixed.snapshot)
    : await adapter.probe(network, loaded.branchHeads);
  const format = input.input.format;
  const { file } = adapter;
  return {
    unchanged: probe.unchanged,
    async read(selected: RuleDefinition[]): Promise<PreparedRulesInput> {
      loaded.progress('source', selected.map(rule => rule.id).join(', '));
      const acquired = await probe.read();
      return { source: acquired.source, conversionsByRuleId: convertInput(acquired.bytes, selected, format, file), format, file,
        ...(adapter.snapshotRequirement && { inputSnapshot: acquired.bytes }) };
    },
  };
}

export async function buildPreparedRules(loaded: LoadedRules, definitions: RuleDefinition[], input: PreparedRulesInput) {
  loaded.progress('build', definitions.map(rule => rule.id).join(', '));
  const built = await buildConfigured(loaded.configuration, definitions, { binary: rulesBinary(loaded.context), nativeBuild: loaded.nativeBuild },
    input.source, input.conversionsByRuleId, input.format, input.file);
  return { ...built, inputSnapshot: input.inputSnapshot };
}

export async function buildRulesInput(loaded: LoadedRules, definitions: RuleDefinition[], fixed?: FixedRuleInput) {
  return buildPreparedRules(loaded, definitions, await (await resolveRulesInput(loaded, definitions, fixed)).read(definitions));
}

export function verifyRuleCandidateInSnapshot(snapshot: PublicationSnapshot, candidate: RuleCandidate, targetBranch: string,
  lastChange: RulesRepository['lastChange'], native?: Partial<NativeBuildOptions>) {
  if (!candidate.evidenceUrl || !candidate.versionId || !candidate.publishedAt || candidate.status !== 'verified' || candidate.migrationPending) {
    throw new Error('CANDIDATE_UNAVAILABLE: version is incomplete');
  }
  return verifyCandidateEvidence({ candidateEvidenceUrl: candidate.evidenceUrl, retained: { candidate, snapshot, lastChange }, ...native },
    { branch: targetBranch }, candidate.definition, 'rollback');
}

export function verifyRuleCandidate(session: RulesSession, candidate: RuleCandidate, binary?: string) {
  return verifyRuleCandidateInSnapshot(session.snapshot, candidate, session.loaded.context.targetBranch,
    session.loaded.context.repository.lastChange, { binary, nativeBuild: session.loaded.nativeBuild });
}

/** An immutable evidence stage survives a lost readback or process checkpoint.
 * Verify those exact retained bytes, without regenerating machine-local paths.
 */
export async function recoverPublishedRuleCandidate(session: RulesSession, candidate: RuleCandidate) {
  session.loaded.progress('evidence', candidate.logicalId);
  const path = `candidates/${candidate.id}/readback.json`;
  const bytes = await session.snapshot.read(path);
  if (!bytes) return undefined;
  await candidateInputSnapshot(candidate)?.read(session.snapshot);
  const evidence = JSON.parse(bytes.toString());
  const evidenceCommit = candidate.evidenceCommit ?? await session.loaded.context.repository.lastChange(session.snapshot.head, path);
  const recovered: RuleCandidate = { ...candidate, status: 'verified', evidenceCommit,
    evidenceUrl: immutableUrl(evidenceCommit, path) };
  if (recovered.publishedAt && recovered.publishedAt !== evidence.publishedAt
    || recovered.versionId && recovered.versionId !== evidence.versionId) {
    throw new Error('CANDIDATE_UNAVAILABLE: retained evidence does not match the registered version');
  }
  recovered.publishedAt ??= evidence.publishedAt;
  recovered.versionId ??= evidence.versionId;
  // Validate recovered identity before recording it, including its uniqueness.
  parseRulesJournal(Buffer.from(JSON.stringify({ ...session.journal,
    candidates: { ...session.journal.candidates, [candidate.id]: recovered } })));
  if (!recovered.publishedAt || !recovered.versionId) throw new Error('CANDIDATE_UNAVAILABLE: retained evidence has no reliable publication time');
  await verifyRuleCandidate(session, recovered, rulesBinary(session.loaded.context));
  delete recovered.error;
  session.journal.candidates[candidate.id] = recovered;
  // The caller either registers delivery in the same checkpoint, or saves this
  // qualified candidate separately before checking the latest upstream input.
  return recovered;
}

export async function publishRuleBuild(session: RulesSession, built: RuleBuild, result: ValidRuleBuild, rule: ManagedRule, recovering?: RuleCandidate) {
  session.loaded.progress('candidate', result.id);
  const input = rule.source;
  const candidate: RuleCandidate = recovering ?? { id: randomUUID(), logicalId: result.id, definition: result.definition,
    sourceInput: input, inputBindingRevision: inputBindingRevision(input, result.definition), definitionGeneration: rule.generation,
    source: built.source, buildId: result.buildId, status: 'building', operation: 'sync', controlRevision: rule.control.revision };
  if (candidate.buildId !== result.buildId) throw new Error('RECOVERY_BUILD_CHANGED: cannot replace an incomplete candidate with a different build');
  if (recovering) {
    // A stage may exist before its returned commit was checkpointed. Restore
    // pointers first so the publisher preserves the original diagnostic path.
    const filesPath = `candidates/${candidate.id}/${result.native.artifacts[0].file}`;
    const metadataPath = `candidates/${candidate.id}/build.json`;
    if (!candidate.filesCommit && session.snapshot.paths.includes(filesPath)) candidate.filesCommit = await session.loaded.context.repository.lastChange(session.snapshot.head, filesPath);
    if (!candidate.metadataCommit && session.snapshot.paths.includes(metadataPath)) candidate.metadataCommit = await session.loaded.context.repository.lastChange(session.snapshot.head, metadataPath);
  }
  const checkpoint: Record<string, Buffer> = {};
  const inputSnapshot = !recovering && candidateInputSnapshot(candidate);
  if (inputSnapshot) checkpoint[inputSnapshot.path] = Buffer.from(inputSnapshot.verify(built.inputSnapshot));
  session.journal.candidates[candidate.id] = candidate;
  await session.save(checkpoint);
  // Immutable stage writes and their journal checkpoint share the same CAS.
  // If a response was lost before the stage pointer was saved, find that exact
  // retained stage rather than uploading another candidate.
  const publication: PublicationTransport = {
    repository: {
      branch: session.loaded.context.repository.branch,
      snapshot: async () => session.snapshot,
      commit: async () => { throw new Error('Use the registered candidate stage'); },
    },
    download: session.loaded.context.repository.download,
    async commit(files) {
      const paths = Object.keys(files);
      session.loaded.progress(paths.some(path => path.endsWith('/readback.json')) ? 'evidence'
        : paths.some(path => path.endsWith('/manifest.json')) ? 'metadata' : 'files', result.id);
      const retained = await Promise.all(paths.map(path => session.snapshot.read(path)));
      if (retained.some(Boolean)) {
        if (!retained.every((bytes, index) => bytes?.equals(files[paths[index]]))) throw new Error('CANDIDATE_UNAVAILABLE: partial or changed retained stage');
        const commits = await Promise.all(paths.map(path => session.loaded.context.repository.lastChange(session.snapshot.head, path)));
        if (!commits.every(commit => commit === commits[0])) throw new Error('CANDIDATE_UNAVAILABLE: inconsistent stage history');
        return commits[0];
      }
      return session.save(files);
    },
  };
  await publishConfiguredCandidate(result, candidate, built.source, built.tools, session.loaded.configuration.target,
    // Stage writes already include the journal. Save each returned commit
    // pointer with the next stage, recovering it by fixed path after a crash.
    publication, { binary: rulesBinary(session.loaded.context), nativeBuild: session.loaded.nativeBuild, verifyEvidence: session.loaded.verifyEvidence, ruleFilesOnly: true }, async () => {
      if (candidate.metadataCommit) session.loaded.progress('evidence', result.id);
    }, () => {
      if (candidate.publishedAt) return;
      candidate.publishedAt = (session.loaded.context.now?.() ?? new Date()).toISOString();
      const identity = candidate.id.replaceAll('-', '');
      let length = 8;
      do { candidate.versionId = `${candidate.publishedAt}~${identity.slice(0, length)}`; length += 4; }
      while (Object.values(session.journal.candidates).some(other => other.id !== candidate.id && other.versionId === candidate.versionId) && length <= 36);
      if (Object.values(session.journal.candidates).some(other => other.id !== candidate.id && other.versionId === candidate.versionId)) throw new Error('Version identity collision');
    });
  await verifyRuleCandidate(session, { ...candidate, status: 'verified' });
  candidate.status = 'verified'; delete candidate.error;
  // Delivery registration persists verified + evidence identity atomically.
  // A caller that does not select this candidate must checkpoint it separately.
  return candidate;
}
