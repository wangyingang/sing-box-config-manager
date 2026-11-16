import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyCandidateEvidence } from './activation.js';
import { buildConfigured, convertInput } from './configured-build.js';
import { publishConfiguredCandidate } from './configured-update.js';
import type { RuleDefinition } from './configuration.js';
import { readCommitInput, withCommitCheckpoint, type CommitSourceRecord } from './github-commit.js';
import { lookupRelease, readReleaseInput, sha256 } from './release.js';
import type { SourceRecord } from './types.js';
import { retainedCandidateDownload } from './publication-repository.js';
import { immutableUrl, type PublicationTransport } from './publication.js';
import { inputBindingRevision, parseRulesJournal, type ManagedRule, type RuleCandidate, type RuleDelivery } from './rules-model.js';
import { rulesBinary, type LoadedRules } from './rules-context.js';
import type { RulesSession } from './rules-session.js';

export type RuleBuild = Awaited<ReturnType<typeof buildRulesInput>>;
export type ValidRuleBuild = Extract<RuleBuild['results'][number], { status: 'built-validated' }>;

/** Acquisition and parsing are independent, so supported formats work with either mechanism. */
export async function buildRulesInput(loaded: LoadedRules, definitions: RuleDefinition[], fixed?: RuleCandidate) {
  const input = fixed?.sourceInput ?? loaded.configuration.sources[definitions[0].source];
  const network = { fetch: loaded.context.fetch, token: loaded.context.token };
  const acquired = input.version === 'git-branch'
    ? await readCommitInput(input, fixed ? withCommitCheckpoint(network, {
      identity: (({ inputSha256: _hash, inputBytes: _bytes, ...identity }) => identity)(fixed.source as CommitSourceRecord),
      expectedSource: fixed.source as CommitSourceRecord, onSource: async () => {},
    }) : network)
    : await (async () => {
      const metadata = await lookupRelease(input, fixed ? String((fixed.source as SourceRecord).releaseId) : 'latest', network);
      if (typeof metadata.tag_name !== 'string') throw new Error('Release metadata has no tag');
      return readReleaseInput({ ...network, tag: metadata.tag_name, releaseMetadata: metadata,
        expectedSource: fixed?.source as SourceRecord | undefined }, input);
    })();
  const file = input.version === 'git-branch' ? input.input.path : input.input.asset;
  const lists = convertInput(acquired.bytes, definitions, input.input.format, file);
  return buildConfigured(loaded.configuration, definitions, rulesBinary(loaded.context), acquired.source, lists, input.input.format, file);
}

export async function verifyRuleCandidate(session: RulesSession, candidate: RuleCandidate, binary?: string) {
  if (!candidate.evidenceUrl || candidate.status !== 'verified') throw new Error('CANDIDATE_UNAVAILABLE: version is incomplete');
  const download = retainedCandidateDownload(session.snapshot, candidate.id, session.loaded.context.repository.download);
  const verified = await verifyCandidateEvidence({ candidateEvidenceUrl: candidate.evidenceUrl, binary,
    evidenceSha256: candidate.evidenceSha256 }, { branch: session.loaded.context.targetBranch, download }, candidate.definition, 'rollback');
  if (verified.buildId !== candidate.buildId || !isDeepStrictEqual(verified.source, candidate.source)) throw new Error('CANDIDATE_UNAVAILABLE: stored source or build changed');
  return verified;
}

/** An immutable evidence stage survives a lost readback or process checkpoint.
 * Verify those exact retained bytes, without regenerating machine-local paths.
 */
export async function recoverPublishedRuleCandidate(session: RulesSession, candidate: RuleCandidate) {
  const path = `candidates/${candidate.id}/readback.json`;
  const bytes = await session.snapshot.read(path);
  if (!bytes) return undefined;
  const evidence = JSON.parse(bytes.toString());
  const evidenceCommit = candidate.evidenceCommit ?? await session.loaded.context.repository.lastChange(session.snapshot.head, path);
  const recovered: RuleCandidate = { ...candidate, status: 'verified', evidenceCommit,
    evidenceUrl: immutableUrl(evidenceCommit, path), evidenceSha256: sha256(bytes) };
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
  await session.save();
  return recovered;
}

export async function unchangedDelivery(session: RulesSession, built: RuleBuild, result: ValidRuleBuild, active: RuleDelivery | undefined, rule: ManagedRule) {
  if (!active) return false;
  const previous = session.journal.candidates[active.candidateId];
  if (!previous || previous.inputBindingRevision !== rule.inputBindingRevision) return false;
  const { source: _oldAlias, ...oldDefinition } = previous.definition;
  const { source: _newAlias, ...newDefinition } = result.definition;
  if (!isDeepStrictEqual(oldDefinition, newDefinition)) return false;
  const verified = await verifyRuleCandidate(session, previous);
  return isDeepStrictEqual(verified.build.tools, built.tools) && verified.build.tool.sha256 === result.native.tool.sha256
    && result.native.artifacts.every(artifact => artifact.content.equals(verified.bytesByFormat[artifact.format]));
}

export async function publishRuleBuild(session: RulesSession, built: RuleBuild, result: ValidRuleBuild, rule: ManagedRule, recovering?: RuleCandidate) {
  const input = session.loaded.configuration.sources[result.definition.source];
  const candidate: RuleCandidate = recovering ?? { id: randomUUID(), logicalId: result.id, definition: result.definition,
    sourceInput: input, inputBindingRevision: inputBindingRevision(input, result.definition), definitionGeneration: rule.generation,
    source: built.source, buildId: result.buildId, status: 'building', operation: 'sync', controlRevision: rule.control.revision };
  if (candidate.buildId !== result.buildId) throw new Error('RECOVERY_BUILD_CHANGED: cannot replace an incomplete candidate with a different build');
  if (recovering) {
    // A stage may exist before its returned commit was checkpointed. Restore
    // pointers first so the publisher preserves the original diagnostic path.
    const filesPath = `candidates/${candidate.id}/${result.native.artifacts[0].file}`;
    const metadataPath = `candidates/${candidate.id}/build.json`;
    if (!candidate.filesCommit && await session.snapshot.read(filesPath)) candidate.filesCommit = await session.loaded.context.repository.lastChange(session.snapshot.head, filesPath);
    if (!candidate.metadataCommit && await session.snapshot.read(metadataPath)) candidate.metadataCommit = await session.loaded.context.repository.lastChange(session.snapshot.head, metadataPath);
  }
  session.journal.candidates[candidate.id] = candidate;
  await session.save();
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
    publication, rulesBinary(session.loaded.context), async () => { await session.save(); }, () => {
      if (candidate.publishedAt) return;
      candidate.publishedAt = (session.loaded.context.now?.() ?? new Date()).toISOString();
      const identity = candidate.id.replaceAll('-', '');
      let length = 8;
      do { candidate.versionId = `${candidate.publishedAt}~${identity.slice(0, length)}`; length += 4; }
      while (Object.values(session.journal.candidates).some(other => other.id !== candidate.id && other.versionId === candidate.versionId) && length <= 36);
      if (Object.values(session.journal.candidates).some(other => other.id !== candidate.id && other.versionId === candidate.versionId)) throw new Error('Version identity collision');
    });
  candidate.status = 'verified'; delete candidate.error;
  const evidence = await session.snapshot.read(`candidates/${candidate.id}/readback.json`);
  if (!evidence) throw new Error('Candidate readback record missing');
  candidate.evidenceSha256 = sha256(evidence);
  await session.save();
  return candidate;
}
