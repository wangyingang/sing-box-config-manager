import { isDeepStrictEqual } from 'node:util';
import { activationSubscription } from './activation.js';
import type { RuleDefinition } from './configured-build.js';
import { filePaths, stageRef, type BaselineStage, type BaselineStages, type BaselineTransport, type PreparedBaseline } from './maintenance-baseline-transport.js';
import type { MaintenancePlan } from './maintenance.js';
import { buildNative, type NativeTool } from './native.js';
import { decodedTerms } from './projection.js';
import type { PublicationRepository, PublicationSnapshot } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, immutableUrl, type PublicationTransport } from './publication.js';
import { BASELINE_PATH, IDENTITY_PATH, STATE_PATH, type RemoteJournal } from './remote-state.js';
import { activationRecord, candidateEvidenceFiles, readRemoteStatus } from './remote-status.js';
import { sha256 } from './release.js';
import type { Candidate, UpdateState } from './update.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
interface Verification {
  transport: BaselineTransport;
  publication: PublicationTransport;
  repository: PublicationRepository;
  binary: string;
  targetBranch: string;
  plan: MaintenancePlan;
  runId: string;
}

async function required(snapshot: PublicationSnapshot, path: string) {
  const bytes = await snapshot.read(path);
  if (!bytes) throw new Error(`Missing retained file: ${path}`);
  return bytes;
}

async function readback(publication: PublicationTransport, url: string, bytes: Buffer) {
  const actual = await publication.download(url);
  if (!actual.equals(bytes)) throw new Error(`Baseline HTTPS content mismatch: ${url}`);
  return { url, sha256: sha256(actual), byteLength: actual.length, exactBytes: true };
}

function rebaseProgress(state: UpdateState, candidates: Record<string, Candidate>, evidenceUrls: Map<string, string>): UpdateState {
  const rebase = <T extends { candidateId: string; evidenceUrl?: string }>(records: Record<string, T>) => Object.fromEntries(
    Object.entries(records).map(([id, { evidenceUrl: _oldUrl, ...progress }]) => {
      const evidenceUrl = evidenceUrls.get(progress.candidateId);
      return [id, { ...progress, ...(evidenceUrl && { evidenceUrl }) }];
    }),
  );
  return { schemaVersion: 1, pinned: state.pinned, candidates, processed: rebase(state.processed),
    configuredProcessed: Object.fromEntries(Object.entries(state.configuredProcessed ?? {}).map(([id, records]) => [id, rebase(records)])),
    ...(state.commitPins && { commitPins: state.commitPins }),
    ...(state.latestChecks && { latestChecks: state.latestChecks }) };
}

function rebaseActivation(record: MaintenancePlan['retain']['active'][number]['record'], expectedHead: string, evidenceUrl: string) {
  const { history, historicalActivationCommit, expectedHead: originalExpectedHead, ...facts } = record;
  // Keep the first activation's provenance across successive cleanups. Only the
  // live history cursor and candidate address are used for resolution.
  const origin = record.baselineOrigin ?? { expectedHead: originalExpectedHead,
    ...(historicalActivationCommit && { historicalActivationCommit }) };
  return { ...facts, baselineOrigin: origin, expectedHead, candidateEvidenceUrl: evidenceUrl,
    ...(history && { history: [] }) };
}

/** Verify through normal remote status, with Git and HTTPS restricted to this graph. */
export async function verifyPreparedBaseline(options: Verification, stages: BaselineStages) {
  const { transport, publication, repository, targetBranch, plan, binary } = options;
  const readStage = async (stage: BaselineStage, parent?: string) => {
    const snapshot = await transport.snapshot(stage.ref);
    if (!snapshot || snapshot.head !== stage.head || !isDeepStrictEqual(snapshot.parents, parent ? [parent] : [])) {
      throw new Error(`Baseline commit or parent mismatch: ${stage.ref}`);
    }
    return snapshot;
  };
  await readStage(stages.files);
  await readStage(stages.metadata, stages.files.head);
  const evidence = await readStage(stages.evidence, stages.metadata.head);
  const journal = await readStage(stages.journal, stages.evidence.head);
  const stableParent = stages.stableRoot ? await readStage(stages.stableRoot) : evidence;
  const stable = stages.stableRoot ? await readStage(stages.stable, stages.stableRoot.head) : journal;
  const allowed = new Set(Object.values(stages).map(({ head }) => head));
  const download = async (url: string) => {
    const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
    if (!url.startsWith(prefix) || !allowed.has(url.slice(prefix.length).split('/')[0])) {
      throw new Error(`Baseline depends on an address outside its new history: ${url}`);
    }
    return publication.download(url);
  };
  const status = await readRemoteStatus({ binary, publication: { ...publication, download }, activation: { download },
    repository: { ...repository, async snapshot(branch = repository.branch) {
      if (branch === repository.branch) return journal;
      if (branch === targetBranch) return stable;
      throw new Error('Unexpected baseline branch');
    } },
  });
  if (status.pendingOperations.length) throw new Error(`Baseline verification pending: ${JSON.stringify(status.pendingOperations)}`);
  const activeCount = Number(!!status.activeRuleVersion) + Object.keys(status.activeRuleVersions).length;
  if (activeCount !== plan.retain.active.length) throw new Error('Baseline active entry count changed');
  for (const { recordPath, record, control } of plan.retain.active) {
    const active = record.logicalId ? status.activeRuleVersions[record.logicalId] : status.activeRuleVersion;
    const candidateUrl = immutableUrl(stages.evidence.head, `candidates/${record.candidateId}/readback.json`);
    const expected = rebaseActivation(record, (stages.stableRoot ?? stages.evidence).head, candidateUrl);
    if (stableParent.paths.includes(recordPath)) throw new Error(`Baseline parent contains prior activation: ${recordPath}`);
    if (active?.candidate.verification !== 'native' || !isDeepStrictEqual(active.activation, JSON.parse(encode(expected).toString()))
      || !isDeepStrictEqual(active.control, control)) throw new Error(`Baseline activation or control changed: ${recordPath}`);
    for (const path of [recordPath, ...Object.keys(record.files)]) {
      await readback({ ...publication, download }, immutableUrl(stable.head, path), await required(stable, path));
    }
  }
}

export async function prepareBaseline(options: Verification & {
  journal: RemoteJournal; source: PublicationSnapshot; stable: PublicationSnapshot; now: Date; tool: NativeTool;
}): Promise<PreparedBaseline> {
  const { transport, publication, plan, repository, targetBranch, journal, source, stable, binary, runId, tool } = options;
  const marker = encode({ schemaVersion: 1, maintenanceId: runId, generation: journal.generation });
  const stage = async (name: string, parent: BaselineStage | undefined, files: Record<string, Buffer>): Promise<BaselineStage> => {
    const ref = stageRef(runId, name);
    return { ref, head: await transport.stage(ref, parent?.head, files, `规则产物维护 ${runId}：${name}`) };
  };
  const assets: Record<string, Buffer> = { [BASELINE_PATH]: marker };
  const metadata: Record<string, Buffer> = {};
  const ids = new Set(plan.retain.active.map(({ record }) => record.candidateId));
  for (const id of ids) {
    for (const file of candidateEvidenceFiles) {
      if (file === 'readback.json') continue;
      const path = `candidates/${id}/${file}`;
      (file.startsWith('domains.') ? assets : metadata)[path] = await required(source, path);
    }
  }
  const copyOtherFiles = async (snapshot: PublicationSnapshot, output: Record<string, Buffer>) => {
    for (const path of filePaths(snapshot.paths)) {
      if (!/^(stable|pipeline|candidates)\//.test(path)) output[path] = await required(snapshot, path);
    }
  };
  await copyOtherFiles(source, assets);
  const files = await stage('files', undefined, assets);
  for (const id of ids) {
    const path = `candidates/${id}/manifest.json`;
    const manifest = JSON.parse(metadata[path].toString());
    for (const artifact of manifest.artifacts) {
      artifact.url = immutableUrl(files.head, `candidates/${id}/domains.${artifact.format === 'source' ? 'json' : 'srs'}`);
    }
    metadata[path] = encode(manifest);
  }
  // A cleanup can discard candidates even when no stable version exists.
  const metadataStage = await stage('metadata', files, metadata);
  const evidence: Record<string, Buffer> = {};
  const priorEvidence = await transport.snapshot(stageRef(runId, 'evidence'));
  for (const id of ids) {
    const prefix = `candidates/${id}/`;
    const readbacks = [];
    for (const [path, bytes] of Object.entries(assets).filter(([path]) => path.startsWith(prefix))) {
      readbacks.push(await readback(publication, immutableUrl(files.head, path), bytes));
    }
    for (const [path, bytes] of Object.entries(metadata).filter(([path]) => path.startsWith(prefix))) {
      readbacks.push(await readback(publication, immutableUrl(metadataStage.head, path), bytes));
    }
    const native = await buildNative(decodedTerms(JSON.parse(assets[prefix + 'domains.json'].toString())), binary);
    if (native.tool.sha256 !== tool.sha256 || native.artifacts.length !== 2
      || native.artifacts.some(artifact => !assets[prefix + artifact.file]?.equals(artifact.content))) {
      throw new Error(`Baseline native bytes or tool changed: ${id}`);
    }
    const build = JSON.parse(metadata[prefix + 'build.json'].toString());
    const record = { schemaVersion: 1, candidateId: id, status: 'remote-verified',
      filesCommit: files.head, metadataCommit: metadataStage.head, buildId: build.buildId, readback: readbacks,
      native: { status: native.validation.status, semanticRoundTrip: native.validation.semanticRoundTrip }, tool: build.tool };
    const path = prefix + 'readback.json';
    if (priorEvidence) {
      const bytes = await required(priorEvidence, path);
      const { revalidationTool, ...prior } = JSON.parse(bytes.toString());
      if (!isDeepStrictEqual(record, prior) || revalidationTool?.version !== '1.14.4'
        || !/^[a-f0-9]{64}$/.test(revalidationTool.sha256)) throw new Error(`Invalid prior baseline readback: ${path}`);
      evidence[path] = bytes;
    } else {
      // The original tool is part of build identity. Record the tool that
      // actually checked these new addresses separately, including after a move to another host.
      evidence[path] = encode({ ...record, revalidationTool: { version: native.tool.version, sha256: native.tool.sha256 } });
    }
  }
  const evidenceStage = await stage('evidence', metadataStage, evidence);
  const evidenceUrls = new Map([...ids].map(id => [id, immutableUrl(evidenceStage.head, `candidates/${id}/readback.json`)]));
  const candidates = Object.fromEntries(Object.entries(journal.state.candidates).filter(([id]) => ids.has(id)).map(([id, original]) => {
    const { previousCandidateId: _previous, error: _error, ...candidate } = original;
    return [id, { ...candidate, filesCommit: files.head, metadataCommit: metadataStage.head, evidenceCommit: evidenceStage.head,
      manifestUrl: immutableUrl(metadataStage.head, `candidates/${id}/manifest.json`), evidenceUrl: evidenceUrls.get(id)! }];
  }));
  const shared = repository.branch === targetBranch;
  let stableRoot: BaselineStage | undefined;
  if (!shared) {
    const root = { [BASELINE_PATH]: marker };
    await copyOtherFiles(stable, root);
    stableRoot = await stage('stable-root', undefined, root);
  }
  const stableFiles: Record<string, Buffer> = {};
  for (const { record, recordPath } of plan.retain.active) {
    const build = JSON.parse(metadata[`candidates/${record.candidateId}/build.json`].toString());
    const definition: RuleDefinition | undefined = build.definition;
    activationSubscription(record.subscription, targetBranch, definition);
    if (definition && recordPath !== `${definition.stablePath}/activation.json`) throw new Error(`Baseline stable path differs from original definition: ${recordPath}`);
    const rebased = rebaseActivation(record, (stableRoot ?? evidenceStage).head, evidenceUrls.get(record.candidateId)!);
    stableFiles[recordPath] = encode(rebased);
    for (const [path, file] of Object.entries(activationRecord(rebased, recordPath, targetBranch).candidateFiles)) {
      const bytes = await required(stable, path);
      if (!bytes.equals(assets[`candidates/${record.candidateId}/${file}`])) throw new Error(`Baseline stable bytes differ from candidate: ${path}`);
      stableFiles[path] = bytes;
    }
  }
  const rebasedJournal: RemoteJournal = { schemaVersion: 1, id: journal.id, generation: journal.generation,
    maintenance: 'maintenance', targetBranch, state: rebaseProgress(journal.state, candidates, evidenceUrls),
    ...(journal.lastCleanupAt && { lastCleanupAt: journal.lastCleanupAt }), ...(journal.resumes && { resumes: journal.resumes }) };
  const journalStage = await stage('journal', evidenceStage, {
    ...(shared && stableFiles), [IDENTITY_PATH]: await required(source, IDENTITY_PATH), [STATE_PATH]: encode(rebasedJournal),
  });
  const stableStage = stableRoot ? await stage('stable', stableRoot, stableFiles) : journalStage;
  const stages = { files, metadata: metadataStage, evidence: evidenceStage, journal: journalStage, stable: stableStage, ...(stableRoot && { stableRoot }) };
  await verifyPreparedBaseline(options, stages);
  return { stages, verifiedAt: options.now.toISOString(), toolSha256: tool.sha256 };
}
