import { isDeepStrictEqual } from 'node:util';
import { activationSubscription, candidateStableFiles } from './activation.js';
import { candidateArtifactFiles, candidateTraceFiles, candidateCoreFiles, RULE_READBACK_VERSION, verifyRuleFile } from './candidate-publication.js';
import { filePaths, stageRef, type BaselineStage, type BaselineStages, type BaselineTransport, type PreparedBaseline } from './maintenance-baseline-transport.js';
import { verifyWithoutEvidenceCache, type VerifyEvidence } from './evidence-download.js';
import type { CleanupPlan } from './rules-cleanup-model.js';
import { candidateInputSnapshot } from './rule-source-adapters.js';
import { inspectBinary, type NativeBuildOptions } from './native.js';
import type { PublicationSnapshot } from './publication-repository.js';
import { immutableUrl } from './publication.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH, type RuleCandidate, type RulesJournal } from './rules-model.js';
import { verifyStableDeliveries } from './stable-deliveries.js';
import { verifyRuleCandidateInSnapshot } from './rules-build.js';
import type { RulesRepository } from './rules-repository.js';

const markerPath = 'pipeline/baseline.json';
export interface RulesBaselineVerification extends NativeBuildOptions {
  transport: BaselineTransport;
  repository: RulesRepository;
  verifyEvidence?: VerifyEvidence;
  targetBranch: string;
  plan: CleanupPlan;
  runId: string;
  journal: RulesJournal;
  source: PublicationSnapshot;
}

async function required(snapshot: PublicationSnapshot, path: string) {
  const bytes = await snapshot.read(path);
  if (!bytes) throw new Error(`Missing retained file: ${path}`);
  return bytes;
}

function retainedJournal(original: RulesJournal, candidates: Record<string, RuleCandidate>): RulesJournal {
  const journal = structuredClone(original);
  delete journal.cleanupRun;
  delete journal.cleanupCheckpoint;
  delete journal.lastCleanup;
  delete journal.writeId;
  if (journal.pendingDelivery || Object.keys(journal.quarantinedCandidates ?? {}).length) {
    throw new Error('RULE_CLEANUP_PENDING: baseline cannot discard unresolved operations or quarantine');
  }
  journal.maintenance = 'maintenance';
  journal.candidates = candidates;
  for (const rule of Object.values(journal.rules)) {
    if (rule.successfulInput && !Object.hasOwn(candidates, rule.successfulInput.candidateId)) delete rule.successfulInput;
  }
  return journal;
}

function tracePaths(snapshot: PublicationSnapshot, id: string) {
  return candidateTraceFiles.map(file => `candidates/${id}/${file}`).filter(path => snapshot.paths.includes(path));
}

async function verifyBaselineCandidate(snapshot: PublicationSnapshot, candidate: RuleCandidate, options: RulesBaselineVerification,
  verify: VerifyEvidence) {
  const result = await verifyRuleCandidateInSnapshot(snapshot, candidate, options.targetBranch, options.repository.lastChange, options);
  const files = candidateArtifactFiles(candidate.definition);
  for (const format of ['source', 'binary'] as const) {
    await verifyRuleFile(verify, immutableUrl(candidate.filesCommit!, `candidates/${candidate.id}/${files[format]}`),
      result.bytesByFormat[format]);
  }
  return result;
}

/** Verify every retained version through addresses reachable exclusively from the new roots. */
export async function verifyRulesBaseline(options: RulesBaselineVerification, stages: BaselineStages) {
  const { transport, repository, targetBranch, plan, journal: original } = options;
  const shared = repository.branch === targetBranch;
  if (Boolean(stages.stableRoot) === shared || shared && !isDeepStrictEqual(stages.stable, stages.journal)) {
    throw new Error('Baseline branch layout differs from configured target');
  }
  const readStage = async (stage: BaselineStage, parent?: string) => {
    const snapshot = await transport.snapshot(stage.ref);
    if (!snapshot || snapshot.head !== stage.head || !isDeepStrictEqual(snapshot.parents, parent ? [parent] : [])) {
      throw new Error(`Baseline commit or parent mismatch: ${stage.ref}`);
    }
    return snapshot;
  };
  await readStage(stages.files);
  await readStage(stages.metadata, stages.files.head);
  await readStage(stages.evidence, stages.metadata.head);
  const snapshot = await readStage(stages.journal, stages.evidence.head);
  if (stages.stableRoot) await readStage(stages.stableRoot);
  const stable = stages.stableRoot ? await readStage(stages.stable, stages.stableRoot.head) : snapshot;
  const journal = parseRulesJournal(await required(snapshot, RULE_STATE_PATH));
  if (!isDeepStrictEqual(JSON.parse((await required(snapshot, 'pipeline/identity.json')).toString()),
    { schemaVersion: 2, id: original.id })) throw new Error('Baseline pipeline identity changed');
  const marker = { schemaVersion: 2, maintenanceId: options.runId, generation: original.generation };
  if (!isDeepStrictEqual(JSON.parse((await required(snapshot, markerPath)).toString()), marker)
    || !isDeepStrictEqual(JSON.parse((await required(stable, markerPath)).toString()), marker)) {
    throw new Error('Baseline maintenance identity mismatch');
  }
  const verifyEvidence = options.verifyEvidence ?? verifyWithoutEvidenceCache(url => repository.download(url));
  const expectedCandidates: Record<string, RuleCandidate> = {};
  const verified = new Map<string, Awaited<ReturnType<typeof verifyBaselineCandidate>>>();
  for (const id of plan.retain.candidateIds) {
    const previous = original.candidates[id], candidate = journal.candidates[id];
    if (!previous || !candidate) throw new Error(`Missing retained candidate: ${id}`);
    expectedCandidates[id] = { ...previous, filesCommit: stages.files.head, metadataCommit: stages.metadata.head,
      evidenceCommit: stages.evidence.head,
      manifestUrl: immutableUrl(stages.metadata.head, `candidates/${id}/manifest.json`),
      evidenceUrl: immutableUrl(stages.evidence.head, `candidates/${id}/readback.json`) };
    delete expectedCandidates[id].evidenceSha256;
    if (!isDeepStrictEqual(expectedCandidates[id], candidate)) throw new Error(`Baseline candidate identity or addresses changed: ${id}`);
    await candidateInputSnapshot(candidate)?.read(snapshot);
    verified.set(id, await verifyBaselineCandidate(snapshot, candidate, options, verifyEvidence));
  }
  if (!isDeepStrictEqual(journal, retainedJournal(original, expectedCandidates))) {
    throw new Error('Baseline changed retained candidate identity, control or definition state');
  }
  const candidatePaths = new Set(plan.retain.candidateIds.flatMap(id => {
    const candidate = journal.candidates[id];
    const input = candidateInputSnapshot(candidate);
    return [...candidateCoreFiles(candidate.definition).map(file => `candidates/${id}/${file}`), ...tracePaths(options.source, id),
      ...(input ? [input.path] : [])];
  }));
  if (!isDeepStrictEqual(new Set(filePaths(snapshot.paths).filter(path => path.startsWith('candidates/'))), candidatePaths)) {
    throw new Error('Baseline retained candidate file set differs from plan');
  }
  for (const id of plan.retain.candidateIds) {
    for (const path of tracePaths(options.source, id)) {
      if (!(await required(snapshot, path)).equals(await required(options.source, path))) {
        throw new Error(`Baseline changed retained trace file: ${path}`);
      }
    }
  }
  const { records: deliveries } = await verifyStableDeliveries(stable);
  if (deliveries.size !== plan.retain.active.length) throw new Error('Baseline active entry count changed');
  const stablePaths = new Set<string>();
  for (const { recordPath, record } of plan.retain.active) {
    const candidate = journal.candidates[record.candidateId];
    if (!candidate) throw new Error(`Current version missing from retained candidates: ${record.logicalId}`);
    const expected = { ...record, candidateEvidenceUrl: candidate.evidenceUrl! };
    if (!isDeepStrictEqual(deliveries.get(record.logicalId), expected)
      || !isDeepStrictEqual(JSON.parse((await required(stable, recordPath)).toString()), expected)) {
      throw new Error(`Baseline changed current version: ${recordPath}`);
    }
    const subscription = activationSubscription(record.subscription, targetBranch, candidate.definition);
    const files = candidateStableFiles(verified.get(candidate.id)!, subscription, candidate.definition, targetBranch);
    if (!isDeepStrictEqual(new Set(Object.keys(files)), new Set(Object.keys(record.files)))) {
      throw new Error(`Baseline stable file set changed: ${recordPath}`);
    }
    for (const [path, bytes] of Object.entries(files)) {
      if (!(await required(stable, path)).equals(bytes)) throw new Error(`Baseline stable candidate bytes differ: ${path}`);
    }
    for (const path of [recordPath, ...Object.keys(record.files)]) stablePaths.add(path);
  }
  if (!isDeepStrictEqual(new Set(filePaths(stable.paths).filter(path => path.startsWith('stable/'))), stablePaths)) {
    throw new Error('Baseline stable paths differ from current delivery');
  }
}

/** Rebase all retained candidates, preserving business identities and original evidence facts. */
export async function prepareRulesBaseline(options: RulesBaselineVerification & {
  stable: PublicationSnapshot; now: Date;
}): Promise<PreparedBaseline> {
  const { transport, repository, targetBranch, journal, source, stable, plan, runId } = options;
  const verifyEvidence = options.verifyEvidence ?? verifyWithoutEvidenceCache(url => repository.download(url));
  const tool = await inspectBinary(options.binary);
  const marker = encodeRecord({ schemaVersion: 2, maintenanceId: runId, generation: journal.generation });
  const stage = async (name: string, parent: BaselineStage | undefined, files: Record<string, Buffer>): Promise<BaselineStage> => {
    const ref = stageRef(runId, name);
    return { ref, head: await transport.stage(ref, parent?.head, files, `规则历史清理 ${runId}：${name}`) };
  };
  const assets: Record<string, Buffer> = { [markerPath]: marker }, metadata: Record<string, Buffer> = {};

  for (const id of plan.retain.candidateIds) {
    const candidate = journal.candidates[id];
    if (!candidate) throw new Error(`Missing retained candidate: ${id}`);
    const verified = await verifyRuleCandidateInSnapshot(source, candidate, targetBranch, repository.lastChange);
    const layout = candidateArtifactFiles(candidate.definition);
    const prefix = `candidates/${id}/`;
    assets[prefix + layout.source] = verified.bytesByFormat.source;
    assets[prefix + layout.binary] = verified.bytesByFormat.binary;
    const input = candidateInputSnapshot(candidate);
    if (input) metadata[input.path] = Buffer.from(await input.read(source));
    metadata[prefix + 'manifest.json'] = encodeRecord(verified.manifest);
    for (const path of [prefix + 'build.json', ...tracePaths(source, id)]) metadata[path] = await required(source, path);
  }
  const copyOtherFiles = async (snapshot: PublicationSnapshot, output: Record<string, Buffer>) => {
    for (const path of filePaths(snapshot.paths).filter(path => !/^(stable|pipeline|candidates)\//.test(path))) output[path] = await required(snapshot, path);
  };
  await copyOtherFiles(source, assets);
  const files = await stage('files', undefined, assets);
  for (const id of plan.retain.candidateIds) {
    const layout = candidateArtifactFiles(journal.candidates[id].definition);
    const path = `candidates/${id}/manifest.json`, manifest = JSON.parse(metadata[path].toString());
    for (const artifact of manifest.artifacts) artifact.url = immutableUrl(files.head, `candidates/${id}/${artifact.format === 'source' ? layout.source : layout.binary}`);
    metadata[path] = encodeRecord(manifest);
  }
  const metadataStage = await stage('metadata', files, metadata);
  const evidence: Record<string, Buffer> = {};
  const priorEvidence = await transport.snapshot(stageRef(runId, 'evidence'));
  for (const id of plan.retain.candidateIds) {
    const prefix = `candidates/${id}/`, readback = [];
    const candidate = journal.candidates[id];
    const layout = candidateArtifactFiles(candidate.definition);
    for (const file of [layout.source, layout.binary]) {
      const path = prefix + file;
      const { record } = await verifyRuleFile(verifyEvidence, immutableUrl(files.head, path), assets[path]);
      readback.push(record);
    }
    const record = { schemaVersion: RULE_READBACK_VERSION, status: 'remote-verified', candidateId: id,
      buildId: candidate.buildId, publishedAt: candidate.publishedAt, versionId: candidate.versionId,
      filesCommit: files.head, metadataCommit: metadataStage.head, readback };
    const path = `${prefix}readback.json`;
    if (priorEvidence) {
      // Another host may use a different platform build of the same version.
      // Revalidate locally below, but never regenerate committed evidence bytes.
      const bytes = await required(priorEvidence, path);
      const { revalidationTool, ...retained } = JSON.parse(bytes.toString());
      if (!isDeepStrictEqual(record, retained) || revalidationTool?.version !== '1.14.4'
        || !/^[a-f0-9]{64}$/.test(revalidationTool?.sha256)) throw new Error(`Invalid prior baseline evidence: ${path}`);
      evidence[path] = bytes;
    } else {
      evidence[path] = encodeRecord({ ...record, revalidationTool: { version: tool.version, sha256: tool.sha256 } });
    }
  }
  const evidenceStage = await stage('evidence', metadataStage, evidence);
  const candidates = Object.fromEntries(plan.retain.candidateIds.map(id => {
    const { evidenceSha256: _digest, ...candidate } = journal.candidates[id];
    return [id, { ...candidate, filesCommit: files.head, metadataCommit: metadataStage.head, evidenceCommit: evidenceStage.head,
      manifestUrl: immutableUrl(metadataStage.head, `candidates/${id}/manifest.json`),
      evidenceUrl: immutableUrl(evidenceStage.head, `candidates/${id}/readback.json`) }];
  }));
  const shared = repository.branch === targetBranch;
  let stableRoot: BaselineStage | undefined;
  if (!shared) {
    const root = { [markerPath]: marker }; await copyOtherFiles(stable, root);
    stableRoot = await stage('stable-root', undefined, root);
  }
  const stableFiles: Record<string, Buffer> = {};
  for (const { recordPath, record } of plan.retain.active) {
    const candidate = candidates[record.candidateId];
    if (!candidate) throw new Error(`Current version missing from retained candidates: ${record.logicalId}`);
    stableFiles[recordPath] = encodeRecord({ ...record, candidateEvidenceUrl: candidate.evidenceUrl });
    for (const path of Object.keys(record.files)) stableFiles[path] = await required(stable, path);
  }
  const journalStage = await stage('journal', evidenceStage, { ...(shared && stableFiles),
    'pipeline/identity.json': await required(source, 'pipeline/identity.json'),
    [RULE_STATE_PATH]: encodeRecord(retainedJournal(journal, candidates)) });
  const stableStage = stableRoot ? await stage('stable', stableRoot, stableFiles) : journalStage;
  const stages = { files, metadata: metadataStage, evidence: evidenceStage, journal: journalStage, stable: stableStage, ...(stableRoot && { stableRoot }) };
  await verifyRulesBaseline(options, stages);
  return { stages, verifiedAt: options.now.toISOString(), toolSha256: tool.sha256 };
}
