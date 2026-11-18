import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyCandidateEvidence } from './activation.js';
import { buildConfigured, convertInput } from './configured-build.js';
import { publishConfiguredCandidate } from './configured-update.js';
import type { RuleDefinition, SourceInput } from './configuration.js';
import type { CommitSourceRecord } from './github-commit.js';
import { probeCommitInput, readPinnedCommitInput } from './git-input-probe.js';
import { lookupRelease, readReleaseInput, sha256, type ReleaseOptions } from './release.js';
import { probeReleaseInput } from './release-input-probe.js';
import type { SourceRecord } from './types.js';
import { retainedCandidateDownload } from './publication-repository.js';
import { immutableUrl, type PublicationTransport } from './publication.js';
import { inputBindingRevision, parseRulesJournal, type ManagedRule, type RuleCandidate, type RuleSource } from './rules-model.js';
import { rulesBinary, type LoadedRules } from './rules-context.js';
import type { RulesSession } from './rules-session.js';

export type RuleBuild = Awaited<ReturnType<typeof buildRulesInput>>;
export type ValidRuleBuild = Extract<RuleBuild['results'][number], { status: 'built-validated' }>;

// The proof adapters leave the fixed-input readers and their build-tool fingerprints intact.
interface RuleSourceProbe {
  read(): Promise<{ bytes: Uint8Array; source: RuleSource }>;
  unchanged?(previous: RuleSource): Promise<RuleSource | undefined>;
}

async function pinRulesSource(input: SourceInput, network: Pick<ReleaseOptions, 'fetch' | 'token'>, fixed?: RuleCandidate): Promise<RuleSourceProbe> {
  if (input.version === 'git-branch') {
    if (fixed) {
      const expectedSource = fixed.source as CommitSourceRecord;
      const { inputSha256: _hash, inputBytes: _bytes, ...identity } = expectedSource;
      return { read: () => readPinnedCommitInput(input, network, identity, expectedSource) };
    }
    const probe = await probeCommitInput(input, network);
    return { read: probe.read, unchanged: async previous => 'kind' in previous ? probe.unchanged(previous) : undefined };
  }
  const expectedSource = fixed?.source as SourceRecord | undefined;
  const metadata = await lookupRelease(input, expectedSource ? String(expectedSource.releaseId) : 'latest', network);
  if (typeof metadata.tag_name !== 'string') throw new Error('Release metadata has no tag');
  const options = { ...network, tag: metadata.tag_name, releaseMetadata: metadata, expectedSource };
  if (expectedSource) return { read: () => readReleaseInput(options, input) };
  const probe = probeReleaseInput(input, options);
  return { read: probe.read, unchanged: async previous => 'kind' in previous ? undefined : probe.unchanged(previous) };
}

export interface PreparedRulesInput {
  source: RuleSource;
  lists: ReturnType<typeof convertInput>;
  format: SourceInput['input']['format'];
  file: string;
}

/** Pin a shared source once, then read and convert only the lists that need its body. */
export async function resolveRulesInput(loaded: LoadedRules, definitions: RuleDefinition[], fixed?: RuleCandidate) {
  const input = fixed?.sourceInput ?? loaded.configuration.sources[definitions[0].source];
  const probe = await pinRulesSource(input, { fetch: loaded.context.fetch, token: loaded.context.token }, fixed);
  const format = input.input.format;
  const file = input.version === 'git-branch' ? input.input.path : input.input.asset;
  return {
    unchanged: probe.unchanged,
    async read(selected: RuleDefinition[]): Promise<PreparedRulesInput> {
      loaded.progress('source', selected.map(rule => rule.id).join(', '));
      const acquired = await probe.read();
      return { source: acquired.source, lists: convertInput(acquired.bytes, selected, format, file), format, file };
    },
  };
}

export async function buildPreparedRules(loaded: LoadedRules, definitions: RuleDefinition[], input: PreparedRulesInput) {
  loaded.progress('build', definitions.map(rule => rule.id).join(', '));
  return buildConfigured(loaded.configuration, definitions, { binary: rulesBinary(loaded.context), nativeBuild: loaded.nativeBuild },
    input.source, input.lists, input.format, input.file);
}

export async function buildRulesInput(loaded: LoadedRules, definitions: RuleDefinition[], fixed?: RuleCandidate) {
  return buildPreparedRules(loaded, definitions, await (await resolveRulesInput(loaded, definitions, fixed)).read(definitions));
}

export async function verifyRuleCandidate(session: RulesSession, candidate: RuleCandidate, binary?: string) {
  if (!candidate.evidenceUrl || candidate.status !== 'verified') throw new Error('CANDIDATE_UNAVAILABLE: version is incomplete');
  const { evidenceUrl } = candidate;
  return session.loaded.verifyEvidence(async download => {
    const retained = retainedCandidateDownload(session.snapshot, candidate.id, download);
    const verified = await verifyCandidateEvidence({ candidateEvidenceUrl: evidenceUrl, binary, nativeBuild: session.loaded.nativeBuild,
      evidenceSha256: candidate.evidenceSha256 }, { branch: session.loaded.context.targetBranch, download: retained }, candidate.definition, 'rollback');
    if (verified.buildId !== candidate.buildId || !isDeepStrictEqual(verified.source, candidate.source)) throw new Error('CANDIDATE_UNAVAILABLE: stored source or build changed');
    return verified;
  });
}

/** An immutable evidence stage survives a lost readback or process checkpoint.
 * Verify those exact retained bytes, without regenerating machine-local paths.
 */
export async function recoverPublishedRuleCandidate(session: RulesSession, candidate: RuleCandidate) {
  session.loaded.progress('evidence', candidate.logicalId);
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
  // The caller either registers delivery in the same checkpoint, or saves this
  // qualified candidate separately before checking the latest upstream input.
  return recovered;
}

export async function publishRuleBuild(session: RulesSession, built: RuleBuild, result: ValidRuleBuild, rule: ManagedRule, recovering?: RuleCandidate) {
  session.loaded.progress('candidate', result.id);
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
    publication, { binary: rulesBinary(session.loaded.context), nativeBuild: session.loaded.nativeBuild, verifyEvidence: session.loaded.verifyEvidence }, async () => {
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
  candidate.status = 'verified'; delete candidate.error;
  const evidence = await session.snapshot.read(`candidates/${candidate.id}/readback.json`);
  if (!evidence) throw new Error('Candidate readback record missing');
  candidate.evidenceSha256 = sha256(evidence);
  // Delivery registration persists verified + evidence identity atomically.
  // A caller that does not select this candidate must checkpoint it separately.
  return candidate;
}
