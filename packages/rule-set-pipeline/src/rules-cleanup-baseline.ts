import { isDeepStrictEqual } from 'node:util';
import { candidateStableFiles, verifyCandidateEvidence } from './activation.js';
import { candidateArtifactFiles, candidateFiles } from './candidate-publication.js';
import { filePaths, stageRef, type BaselineStage, type BaselineStages, type BaselineTransport, type PreparedBaseline } from './maintenance-baseline-transport.js';
import type { CleanupPlan } from './rules-cleanup-model.js';
import { inspectBinary } from './native.js';
import { retainedCandidateDownload, type PublicationSnapshot } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, immutableUrl } from './publication.js';
import { sha256 } from './release.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH, type RuleCandidate, type RulesJournal } from './rules-model.js';
import { readRuleDeliveries } from './rules-delivery.js';
import type { RulesRepository } from './rules-repository.js';

const markerPath = 'pipeline/baseline.json';
export interface RulesBaselineVerification {
  transport: BaselineTransport;
  repository: RulesRepository;
  binary: string;
  targetBranch: string;
  plan: CleanupPlan;
  runId: string;
  journal: RulesJournal;
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
  return journal;
}

async function verifyCandidate(snapshot: PublicationSnapshot, candidate: RuleCandidate, repository: RulesRepository,
  targetBranch: string, binary?: string) {
  if (!candidate.evidenceUrl || candidate.status !== 'verified' || !candidate.versionId || !candidate.publishedAt || candidate.migrationPending) {
    throw new Error(`RULE_CLEANUP_PENDING: retained candidate is incomplete: ${candidate.id}`);
  }
  const evidence = JSON.parse((await required(snapshot, `candidates/${candidate.id}/readback.json`)).toString());
  const evidenceVersion = typeof evidence.versionId === 'string' && evidence.versionId.startsWith(`${evidence.publishedAt}~`)
    ? evidence.versionId : candidate.operation === 'migration' ? `${evidence.publishedAt}~${candidate.id.replaceAll('-', '')}` : undefined;
  if (candidate.publishedAt !== evidence.publishedAt || candidate.versionId !== evidenceVersion) {
    throw new Error(`RULE_CLEANUP_PENDING: retained version identity differs from its evidence: ${candidate.id}`);
  }
  const verified = await verifyCandidateEvidence({ candidateEvidenceUrl: candidate.evidenceUrl,
    evidenceSha256: candidate.evidenceSha256, binary },
  { branch: targetBranch, download: retainedCandidateDownload(snapshot, candidate.id, repository.download) }, candidate.definition, 'rollback');
  if (verified.buildId !== candidate.buildId || !isDeepStrictEqual(verified.source, candidate.source)) {
    throw new Error(`RULE_CLEANUP_PENDING: candidate source or build changed: ${candidate.id}`);
  }
  return verified;
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
  const allowed = new Set(Object.values(stages).map(stage => stage.head));
  const restricted: RulesRepository = { ...repository, async download(url) {
    const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
    if (!url.startsWith(prefix) || !allowed.has(url.slice(prefix.length).split('/')[0])) {
      throw new Error(`Baseline depends on an address outside its new history: ${url}`);
    }
    return repository.download(url);
  } };
  const expectedCandidates: Record<string, RuleCandidate> = {};
  const verified = new Map<string, Awaited<ReturnType<typeof verifyCandidate>>>();
  for (const id of plan.retain.candidateIds) {
    const previous = original.candidates[id], candidate = journal.candidates[id];
    if (!previous || !candidate) throw new Error(`Missing retained candidate: ${id}`);
    const evidence = await required(snapshot, `candidates/${id}/readback.json`);
    expectedCandidates[id] = { ...previous, filesCommit: stages.files.head, metadataCommit: stages.metadata.head,
      evidenceCommit: stages.evidence.head, evidenceSha256: sha256(evidence),
      manifestUrl: immutableUrl(stages.metadata.head, `candidates/${id}/manifest.json`),
      evidenceUrl: immutableUrl(stages.evidence.head, `candidates/${id}/readback.json`) };
    verified.set(id, await verifyCandidate(snapshot, candidate, restricted, targetBranch, options.binary));
  }
  if (!isDeepStrictEqual(journal, retainedJournal(original, expectedCandidates))) {
    throw new Error('Baseline changed retained candidate identity, control or definition state');
  }
  const candidatePaths = new Set(plan.retain.candidateIds.flatMap(id => candidateFiles(journal.candidates[id].definition).map(file => `candidates/${id}/${file}`)));
  if (!isDeepStrictEqual(new Set(filePaths(snapshot.paths).filter(path => path.startsWith('candidates/'))), candidatePaths)) {
    throw new Error('Baseline retained candidate file set differs from plan');
  }
  const deliveries = await readRuleDeliveries(stable);
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
    const files = candidateStableFiles(verified.get(candidate.id)!, record.subscription, candidate.definition, targetBranch);
    if (!isDeepStrictEqual(new Set(Object.keys(files)), new Set(Object.keys(record.files)))) {
      throw new Error(`Baseline stable file set changed: ${recordPath}`);
    }
    for (const [path, bytes] of Object.entries(files)) {
      if (!(await required(stable, path)).equals(bytes)) throw new Error(`Baseline stable candidate bytes differ: ${path}`);
    }
    for (const path of [recordPath, ...Object.keys(record.files)]) {
      stablePaths.add(path);
      if (!(await restricted.download(immutableUrl(stable.head, path))).equals(await required(stable, path))) {
        throw new Error(`Baseline HTTPS content mismatch: ${path}`);
      }
    }
  }
  if (!isDeepStrictEqual(new Set(filePaths(stable.paths).filter(path => path.startsWith('stable/'))), stablePaths)) {
    throw new Error('Baseline stable paths differ from current delivery');
  }
}

/** Rebase all retained candidates, preserving business identities and original evidence facts. */
export async function prepareRulesBaseline(options: RulesBaselineVerification & {
  source: PublicationSnapshot; stable: PublicationSnapshot; now: Date;
}): Promise<PreparedBaseline> {
  const { transport, repository, targetBranch, journal, source, stable, plan, runId } = options;
  const tool = await inspectBinary(options.binary);
  const marker = encodeRecord({ schemaVersion: 2, maintenanceId: runId, generation: journal.generation });
  const stage = async (name: string, parent: BaselineStage | undefined, files: Record<string, Buffer>): Promise<BaselineStage> => {
    const ref = stageRef(runId, name);
    return { ref, head: await transport.stage(ref, parent?.head, files, `规则历史清理 ${runId}：${name}`) };
  };
  const assets: Record<string, Buffer> = { [markerPath]: marker }, metadata: Record<string, Buffer> = {};
  const originals = new Map<string, Record<string, any>>();
  for (const id of plan.retain.candidateIds) {
    const candidate = journal.candidates[id];
    if (!candidate) throw new Error(`Missing retained candidate: ${id}`);
    await verifyCandidate(source, candidate, repository, targetBranch);
    originals.set(id, JSON.parse((await required(source, `candidates/${id}/readback.json`)).toString()));
    const layout = candidateArtifactFiles(candidate.definition);
    for (const file of candidateFiles(candidate.definition).filter(file => file !== 'readback.json')) {
      const path = `candidates/${id}/${file}`;
      (file === layout.source || file === layout.binary ? assets : metadata)[path] = await required(source, path);
    }
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
  for (const id of plan.retain.candidateIds) {
    const prefix = `candidates/${id}/`, readback = [];
    for (const [contents, head] of [[assets, files.head], [metadata, metadataStage.head]] as const) {
      for (const [path, bytes] of Object.entries(contents).filter(([path]) => path.startsWith(prefix))) {
        const url = immutableUrl(head, path), actual = await repository.download(url);
        if (!actual.equals(bytes)) throw new Error(`Baseline HTTPS content mismatch: ${path}`);
        readback.push({ url, sha256: sha256(actual), byteLength: actual.length, exactBytes: true });
      }
    }
    // Preserve the original publication time, tool location and native evidence;
    // only physical addresses and new-host revalidation metadata change.
    evidence[`${prefix}readback.json`] = encodeRecord({ ...originals.get(id),
      publishedAt: journal.candidates[id].publishedAt, versionId: journal.candidates[id].versionId, filesCommit: files.head,
      metadataCommit: metadataStage.head, readback, revalidationTool: { version: tool.version, sha256: tool.sha256 } });
  }
  const evidenceStage = await stage('evidence', metadataStage, evidence);
  const candidates = Object.fromEntries(plan.retain.candidateIds.map(id => [id, { ...journal.candidates[id],
    filesCommit: files.head, metadataCommit: metadataStage.head, evidenceCommit: evidenceStage.head,
    evidenceSha256: sha256(evidence[`candidates/${id}/readback.json`]),
    manifestUrl: immutableUrl(metadataStage.head, `candidates/${id}/manifest.json`),
    evidenceUrl: immutableUrl(evidenceStage.head, `candidates/${id}/readback.json`) }]));
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
