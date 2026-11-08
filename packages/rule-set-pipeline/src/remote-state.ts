import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { immutableUrl, type PublicationTransport } from './publication.js';
import type { PublicationRepository } from './publication-repository.js';
import { PublicationWriteError } from './publication-repository.js';
import type { UpdateState } from './update.js';
import { validBaseline } from './maintenance-baseline-transport.js';
import { cleanupRefNames } from './maintenance-refs.js';
import type { MaintenanceCleanup, MaintenanceRun } from './maintenance.js';
import { parseBuildConfiguration, parseRuleDefinition } from './configuration.js';
import { commitSourceKey, validCommitIdentity, validCommitSource } from './github-commit.js';
import { sha256, validReleaseAssetIdentities, V2FLY_RELEASE_INPUT } from './release.js';

export const STATE_PATH = 'pipeline/state.json';
export const BASELINE_PATH = 'pipeline/baseline.json';
export const IDENTITY_PATH = 'pipeline/identity.json';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export interface RemoteJournal {
  schemaVersion: 1; id: string; generation: number; maintenance: 'open' | 'maintenance'; targetBranch: string;
  state: UpdateState;
  maintenanceRun?: MaintenanceRun;
  maintenanceCleanup?: MaintenanceCleanup;
  lastCleanupAt?: string;
  manualOperations?: Record<string, ManualOperation>;
  automaticOperations?: Record<string, ActivationOperation>;
  resumes?: Record<string, ResumeDecision>;
  parkedOperations?: RemoteOperation[];
}

export type RemoteOperation = NonNullable<UpdateState['pendingOperation']>;

export interface ResumeDecision {
  revision: string;
  activationId: string;
  checkPending: boolean;
}

export interface ManualOperation extends ActivationOperation {
  kind: 'activate' | 'rollback';
}

export interface ActivationOperation {
  id: string;
  kind: 'activate' | 'rollback' | 'automatic';
  logicalId?: string;
  recordPath: string;
  generation: number;
  expectedHead: string;
  previousActivationId?: string;
  candidateId: string;
  candidateEvidenceUrl: string;
  activationDigest: string;
  historicalActivationCommit?: string;
  notCommitted?: true;
  checkOperationId?: string;
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const operationId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const branch = (value: unknown) => typeof value === 'string' && (value === 'main' || /^acceptance-[a-zA-Z0-9._-]+$/.test(value));
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validatePin(pin: unknown, id: string) {
  if (!object(pin) || !object(pin.identity)) throw new Error('REMOTE_STATE_CORRUPT: source pin');
  const identity = pin.identity;
  if (!Number.isSafeInteger(identity.releaseId) || identity.releaseId <= 0 || String(identity.releaseId) !== id
    || !/^[0-9]{14}$/.test(identity.tag) || !sha(identity.commit) || identity.repository !== V2FLY_RELEASE_INPUT.repository) {
    throw new Error('REMOTE_STATE_CORRUPT: source identity');
  }
  if (!validReleaseAssetIdentities(identity)) throw new Error('REMOTE_STATE_CORRUPT: source asset identity');
  if (pin.source !== undefined) {
    const source = pin.source;
    if (!object(source) || !digest(source.inputSha256) || !digest(source.checksumSha256)
      || !Number.isSafeInteger(source.inputBytes) || source.inputBytes <= 0
      || ['repository', 'releaseId', 'tag', 'commit'].some(key => source[key] !== identity[key])
      || ['yaml', 'checksum'].some(key => !object(source[key]) || ['id', 'name', 'url'].some(field => source[key][field] !== identity[key][field]))) {
      throw new Error('REMOTE_STATE_CORRUPT: checked source');
    }
  }
}

function validMaintenancePlan(value: unknown) {
  if (!object(value) || !object(value.retain) || !object(value.retain.progress) || !object(value.discard)) return false;
  const { retain, discard, otherRefs } = value;
  const strings = (entries: unknown) => Array.isArray(entries) && entries.every(entry => typeof entry === 'string');
  return strings(retain.journalPaths) && Array.isArray(retain.active) && retain.active.every(entry =>
    object(entry) && typeof entry.recordPath === 'string' && object(entry.record) && strings(entry.candidatePaths))
    && strings(retain.progress.pinnedReleaseIds) && strings(retain.progress.processedReleaseIds)
    && object(retain.progress.configuredProcessedReleaseIds) && Object.values(retain.progress.configuredProcessedReleaseIds).every(strings)
    && object(retain.progress.latestChecks) && object(retain.progress.resumes) && strings(discard.candidateIds) && strings(discard.completedOperationIds)
    && object(discard.activations) && Object.values(discard.activations).every(entries => Array.isArray(entries) && entries.every(entry =>
      object(entry) && typeof entry.id === 'string' && typeof entry.candidateId === 'string' && sha(entry.commit)))
    && Array.isArray(otherRefs) && otherRefs.every(ref => object(ref) && typeof ref.ref === 'string' && ref.ref.startsWith('refs/') && sha(ref.head));
}

function validate(value: unknown): asserts value is RemoteJournal {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !['open', 'maintenance'].includes(value.maintenance)
    || !branch(value.targetBranch) || !object(value.state)) throw new Error('REMOTE_STATE_CORRUPT');
  const run = value.maintenanceRun;
  if (run !== undefined && (!object(run) || value.maintenance !== 'maintenance' || !operationId(run.id)
    || run.generation !== value.generation || !object(run.oldHeads) || !sha(run.oldHeads.journal) || !sha(run.oldHeads.stable)
    || (run.phase === 'isolated' ? run.isolatedHead !== undefined || run.plan !== undefined
      : !sha(run.isolatedHead) || !validMaintenancePlan(run.plan)
        || (run.phase === 'prepared' ? !sha(run.readyHead) || !validBaseline(run.baseline, run.id, value.targetBranch !== 'main')
          : run.phase !== 'ready' || run.baseline !== undefined || run.readyHead !== undefined)))) {
    throw new Error('REMOTE_STATE_CORRUPT: maintenance run');
  }
  const cleanup = value.maintenanceCleanup;
  if (cleanup !== undefined && (!object(cleanup) || run !== undefined || value.maintenance !== 'maintenance'
    || !operationId(cleanup.id) || !sha(cleanup.stableHead) || typeof cleanup.verifiedAt !== 'string'
    || !Number.isFinite(Date.parse(cleanup.verifiedAt)) || !object(cleanup.refs)
    || !isDeepStrictEqual(Object.keys(cleanup.refs).sort(), cleanupRefNames(cleanup.id, value.targetBranch !== 'main').sort())
    || !Object.values(cleanup.refs).every(sha))) {
    throw new Error('REMOTE_STATE_CORRUPT: maintenance cleanup');
  }
  if (value.lastCleanupAt !== undefined && (typeof value.lastCleanupAt !== 'string' || !Number.isFinite(Date.parse(value.lastCleanupAt)))) {
    throw new Error('REMOTE_STATE_CORRUPT: last cleanup date');
  }
  for (const [operations, kinds] of [[value.manualOperations, ['activate', 'rollback']], [value.automaticOperations, ['automatic']]] as const) {
    if (operations === undefined) continue;
    if (!object(operations)) throw new Error('REMOTE_STATE_CORRUPT: activation operations');
    for (const [id, op] of Object.entries(operations)) {
      if (!object(op) || !/^[a-f0-9-]{36}$/.test(id) || op.id !== id || !kinds.some(kind => kind === op.kind)
        || (op.recordPath === 'stable/activation.json'
          ? op.logicalId !== undefined || op.kind === 'automatic'
          : typeof op.logicalId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(op.logicalId)
            || typeof op.recordPath !== 'string' || !/^stable\/(?:[a-z0-9][a-z0-9._-]*\/)+activation\.json$/.test(op.recordPath))
        || !Number.isSafeInteger(op.generation) || op.generation < 1 || op.generation > value.generation
        || !sha(op.expectedHead) || op.previousActivationId !== undefined && typeof op.previousActivationId !== 'string'
        || typeof op.candidateId !== 'string' || !/^[a-f0-9-]+$/.test(op.candidateId)
        || !digest(op.activationDigest) || typeof op.candidateEvidenceUrl !== 'string'
        || !sha(op.candidateEvidenceUrl.split('/')[5])
        || op.candidateEvidenceUrl !== immutableUrl(op.candidateEvidenceUrl.split('/')[5], `candidates/${op.candidateId}/readback.json`)
        || (op.kind === 'rollback' ? !sha(op.historicalActivationCommit) : op.historicalActivationCommit !== undefined)
        || (op.kind === 'automatic' ? !operationId(op.checkOperationId) : op.checkOperationId !== undefined)
        || op.notCommitted !== undefined && op.notCommitted !== true) throw new Error('REMOTE_STATE_CORRUPT: activation operation');
    }
  }
  if (value.resumes !== undefined) {
    if (!object(value.resumes)) throw new Error('REMOTE_STATE_CORRUPT: resume decisions');
    for (const [id, decision] of Object.entries(value.resumes)) {
      if (!/^[a-z][a-z0-9-]*$/.test(id) || !object(decision) || !operationId(decision.revision)
        || typeof decision.activationId !== 'string' || !decision.activationId || typeof decision.checkPending !== 'boolean') {
        throw new Error('REMOTE_STATE_CORRUPT: resume decision');
      }
    }
  }
  const state = value.state;
  if (state.schemaVersion !== 1 || !object(state.pinned) || !object(state.processed) || !object(state.candidates)
    || state.configuredProcessed !== undefined && !object(state.configuredProcessed)) throw new Error('REMOTE_STATE_CORRUPT');
  for (const [id, pin] of Object.entries(state.pinned)) {
    validatePin(pin, id);
  }
  if (state.commitPins !== undefined && !object(state.commitPins)) throw new Error('REMOTE_STATE_CORRUPT: Git source pins');
  for (const [key, pin] of Object.entries(state.commitPins ?? {})) {
    if (!object(pin) || !validCommitIdentity(pin.identity) || commitSourceKey(pin.identity) !== key
      || pin.source !== undefined && (!validCommitSource(pin.source) || commitSourceKey(pin.source) !== key)) {
      throw new Error('REMOTE_STATE_CORRUPT: Git source pin');
    }
  }
  const validSourceReference = (reference: Record<string, any>) => reference.sourceKey === undefined
    ? Number.isSafeInteger(reference.releaseId) && state.pinned[String(reference.releaseId)]?.identity?.tag === reference.tag
      && typeof reference.tag === 'string'
    : typeof reference.sourceKey === 'string' && Object.hasOwn(state.commitPins ?? {}, reference.sourceKey)
      && reference.releaseId === undefined && reference.tag === undefined;
  const parked = value.parkedOperations === undefined ? [] : value.parkedOperations;
  if (!Array.isArray(parked) || parked.some(op => !object(op) || op.status !== 'pending')) {
    throw new Error('REMOTE_STATE_CORRUPT: parked operations');
  }
  const operations = [...parked, ...(state.pendingOperation === undefined ? [] : [state.pendingOperation])];
  const operationIds = new Set(operations.map(op => op?.id));
  if (operationIds.size !== operations.length) throw new Error('REMOTE_STATE_CORRUPT: duplicate operation');
  for (const [id, candidate] of Object.entries(state.candidates)) {
    if (!object(candidate) || candidate.id !== id || !/^[a-f0-9-]+$/.test(id)
      || !validSourceReference(candidate) || candidate.sourceKey !== undefined
        && (!candidate.definition || !state.commitPins[candidate.sourceKey].source)
      || !['building', 'publishing', 'verified', 'failed'].includes(candidate.status)
      || !Number.isSafeInteger(candidate.generation) || candidate.generation < 1 || candidate.generation > value.generation || typeof candidate.retained !== 'boolean'
      || typeof candidate.operationId !== 'string' || !/^[a-f0-9-]+$/.test(candidate.operationId)
      || !['update', 'rebuild'].includes(candidate.operation)
      || !['registered', 'files', 'metadata', 'evidence', 'complete'].includes(candidate.phase)
      || candidate.targetBranch !== value.targetBranch
      || ['filesCommit', 'metadataCommit', 'evidenceCommit'].some(key => candidate[key] !== undefined && !sha(candidate[key]))) {
      throw new Error('REMOTE_STATE_CORRUPT: candidate');
    }
    if (candidate.sourceKey !== undefined && ['evidence', 'complete'].includes(candidate.phase) && !digest(candidate.evidenceSha256)
      || candidate.phase !== 'registered' && !digest(candidate.buildId)
      || ['metadata', 'evidence', 'complete'].includes(candidate.phase) && !sha(candidate.filesCommit)
      || ['evidence', 'complete'].includes(candidate.phase) && !sha(candidate.metadataCommit)
      || candidate.phase === 'complete' && !sha(candidate.evidenceCommit)
      || candidate.logicalId !== undefined && (typeof candidate.logicalId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(candidate.logicalId) || !candidate.definition)
      || candidate.phase !== 'complete' && candidate.retained && (candidate.generation !== value.generation || !operationIds.has(candidate.operationId))) {
      throw new Error('REMOTE_STATE_CORRUPT: candidate progress or operation');
    }
    if (candidate.manifestUrl !== undefined && (!candidate.metadataCommit
        || candidate.manifestUrl !== immutableUrl(candidate.metadataCommit, `candidates/${id}/manifest.json`))
      || candidate.evidenceUrl !== undefined && (!candidate.evidenceCommit
        || candidate.evidenceUrl !== immutableUrl(candidate.evidenceCommit, `candidates/${id}/readback.json`))) {
      throw new Error('REMOTE_STATE_CORRUPT: candidate address');
    }
    if (candidate.definition !== undefined) {
      const definition = parseRuleDefinition(candidate.definition, candidate.sourceKey === undefined ? 'plain-yaml' : 'cidr-text');
      if (candidate.logicalId !== definition.id) throw new Error('REMOTE_STATE_CORRUPT: candidate logical ID');
    }
  }
  const processed = (records: unknown, logicalId?: string) => {
    if (!object(records)) throw new Error('REMOTE_STATE_CORRUPT: processed');
    for (const [releaseId, record] of Object.entries(records)) {
      if (!object(record) || typeof record.candidateId !== 'string' || !/^[a-f0-9-]+$/.test(record.candidateId)
        || (/^[1-9][0-9]*$/.test(releaseId) ? !/^[0-9]{14}$/.test(record.tag)
          : !logicalId || !Object.hasOwn(state.commitPins ?? {}, releaseId) || record.tag !== undefined
            || !digest(record.definitionSha256))
        || record.evidenceUrl !== undefined && typeof record.evidenceUrl !== 'string'
        || record.definitionSha256 !== undefined && !digest(record.definitionSha256)) throw new Error('REMOTE_STATE_CORRUPT: processed');
      if (Object.hasOwn(state.commitPins ?? {}, releaseId)) {
        const candidate = state.candidates[record.candidateId];
        if (candidate ? candidate.sourceKey !== releaseId || candidate.logicalId !== logicalId || candidate.phase !== 'complete'
          : record.evidenceUrl !== undefined) throw new Error('REMOTE_STATE_CORRUPT: processed Git candidate');
      }
    }
  };
  processed(state.processed);
  for (const [id, records] of Object.entries(state.configuredProcessed ?? {})) processed(records, id);
  if (state.latestChecks !== undefined) {
    if (!object(state.latestChecks)) throw new Error('REMOTE_STATE_CORRUPT: latest checks');
    for (const [id, check] of Object.entries(state.latestChecks)) {
      if (!/^[a-z][a-z0-9-]*$/.test(id) || !object(check) || typeof check.operationId !== 'string'
        || !/^[a-f0-9-]{36}$/.test(check.operationId) || !['activated', 'unchanged', 'paused', 'failed', 'verification-pending'].includes(check.status)
        || typeof check.checkedAt !== 'string' || !Number.isFinite(Date.parse(check.checkedAt))
        || (check.releaseId === undefined ? check.tag !== undefined : !Number.isSafeInteger(check.releaseId)
          || state.pinned[String(check.releaseId)]?.identity?.tag !== check.tag || typeof check.tag !== 'string')
        || check.error !== undefined && typeof check.error !== 'string'
        || check.candidateId !== undefined && (typeof check.candidateId !== 'string' || !/^[a-f0-9-]+$/.test(check.candidateId))) {
        throw new Error('REMOTE_STATE_CORRUPT: latest check');
      }
    }
  }
  for (const op of operations) {
    if (!object(op) || typeof op.id !== 'string' || !/^[a-f0-9-]+$/.test(op.id) || !['update', 'rebuild', 'check'].includes(op.kind)
      || !Number.isSafeInteger(op.generation) || op.generation < 1 || op.generation > value.generation
      || op.status === 'pending' && op.generation !== value.generation || !validSourceReference(op)
      || !sha(op.expectedHead) || !Array.isArray(op.candidateIds) || new Set(op.candidateIds).size !== op.candidateIds.length
      || !['pending', 'complete'].includes(op.status)) throw new Error('REMOTE_STATE_CORRUPT: operation');
    if (op.configuration !== undefined) {
      if (typeof op.configuration !== 'string') throw new Error('REMOTE_STATE_CORRUPT: operation configuration');
      const configuration = parseBuildConfiguration(op.configuration);
      if (configuration.target.branch !== value.targetBranch || op.selectedIds !== undefined && (!Array.isArray(op.selectedIds)
        || !op.selectedIds.length || new Set(op.selectedIds).size !== op.selectedIds.length
        || op.selectedIds.some((id: unknown) => !configuration.ruleSets.some(rule => rule.id === id)))) throw new Error('REMOTE_STATE_CORRUPT: operation selection');
    } else if (op.selectedIds !== undefined) throw new Error('REMOTE_STATE_CORRUPT: operation selection');
    const configuration = op.configuration === undefined ? undefined : parseBuildConfiguration(op.configuration);
    if (op.sourceKey !== undefined && (!configuration || configuration.ruleSets.some(rule =>
      (!op.selectedIds || op.selectedIds.includes(rule.id)) && configuration.sources[rule.source].version !== 'git-branch'))) {
      throw new Error('REMOTE_STATE_CORRUPT: Git operation source');
    }
    if (op.kind === 'check') {
      if (op.sourceKey !== undefined || !configuration || !op.selectedIds || !object(op.controlRevisions) || !object(op.subscriptionHashes)
        || Object.keys(op.controlRevisions).length !== op.selectedIds.length || Object.keys(op.subscriptionHashes).length !== op.selectedIds.length
        || op.selectedIds.some((id: string) => !(op.controlRevisions[id] === null || typeof op.controlRevisions[id] === 'string')
          || !digest(op.subscriptionHashes[id]))) throw new Error('REMOTE_STATE_CORRUPT: check operation');
    } else if (op.controlRevisions !== undefined || op.subscriptionHashes !== undefined) {
      throw new Error('REMOTE_STATE_CORRUPT: unexpected check operation fields');
    }
    for (const id of op.candidateIds) {
      const candidate = state.candidates[id];
      const definition = configuration?.ruleSets.find(rule => rule.id === candidate?.logicalId);
      if (typeof id !== 'string' || !object(candidate) || candidate.operationId !== op.id || candidate.operation !== (op.kind === 'check' ? 'update' : op.kind)
        || candidate.sourceKey !== op.sourceKey || candidate.releaseId !== op.releaseId || candidate.tag !== op.tag
        || (configuration ? !definition || op.selectedIds && !op.selectedIds.includes(definition.id)
          || !isDeepStrictEqual(candidate.definition, definition) : candidate.logicalId !== undefined || candidate.definition !== undefined)) {
        throw new Error('REMOTE_STATE_CORRUPT: operation candidate index');
      }
    }
    if (Object.values(state.candidates).some(candidate => candidate.operationId === op.id && !op.candidateIds.includes(candidate.id))) {
      throw new Error('REMOTE_STATE_CORRUPT: unindexed operation candidate');
    }
  }
}

/** Resume matching work without replacing a different operation's checkpoint. */
export function selectRemoteOperation(journal: RemoteJournal, matches: (operation: RemoteOperation) => unknown) {
  const { state, parkedOperations } = journal;
  const active = state.pendingOperation?.status === 'pending' ? state.pendingOperation : undefined;
  if (active && matches(active)) return active;
  const index = parkedOperations?.findIndex(matches) ?? -1;
  if (index < 0) return active;
  const [selected] = parkedOperations!.splice(index, 1);
  if (active) parkedOperations!.push(active);
  return state.pendingOperation = selected;
}

export async function readRemoteState(repository: PublicationRepository) {
  const snapshot = await repository.snapshot();
  const [identityBytes, stateBytes] = await Promise.all([snapshot.read(IDENTITY_PATH), snapshot.read(STATE_PATH)]);
  if (!identityBytes && !stateBytes) throw new Error('REMOTE_NOT_INITIALIZED: initialize explicitly before update');
  if (!identityBytes || !stateBytes) throw new Error('REMOTE_STATE_MISSING: initialized state cannot be recreated implicitly');
  let journal: RemoteJournal;
  try {
    const identity = JSON.parse(identityBytes.toString());
    journal = JSON.parse(stateBytes.toString()); validate(journal);
    if (identity.schemaVersion !== 1 || identity.id !== journal.id || identity.targetBranch !== journal.targetBranch) throw new Error('identity mismatch');
    if (repository.branch !== (journal.targetBranch === 'main' ? 'candidates' : journal.targetBranch)) throw new Error('target mismatch');
  } catch (error) { throw new Error(`REMOTE_STATE_CORRUPT: ${String(error)}`); }
  return { snapshot, journal };
}

export async function initializeRemoteState(repository: PublicationRepository, targetBranch: string) {
  if (!branch(targetBranch) || repository.branch !== (targetBranch === 'main' ? 'candidates' : targetBranch)) throw new Error('Invalid initialization target');
  const snapshot = await repository.snapshot();
  if (snapshot.paths.includes(STATE_PATH) || snapshot.paths.includes(IDENTITY_PATH)) throw new Error('REMOTE_ALREADY_INITIALIZED: refusing to replace state');
  const journal: RemoteJournal = { schemaVersion: 1, id: randomUUID(), generation: 1, maintenance: 'open', targetBranch,
    state: { schemaVersion: 1, pinned: {}, processed: {}, configuredProcessed: {}, candidates: {} } };
  const identity = { schemaVersion: 1, id: journal.id, targetBranch };
  const head = await repository.commit(snapshot.head, { [STATE_PATH]: encode(journal), [IDENTITY_PATH]: encode(identity) }, '初始化候选恢复状态');
  return { head, journal };
}

export async function guardRemoteState(repository: PublicationRepository, expectedHead: string, journal: RemoteJournal) {
  const current = await readRemoteState(repository);
  if (current.snapshot.head !== expectedHead || current.journal.id !== journal.id
    || current.journal.generation !== journal.generation || current.journal.maintenance !== 'open') {
    throw new Error('PUBLICATION_CONFLICT: head, generation or maintenance changed');
  }
}

/** A successful result may only expose addresses from the same open generation. */
export async function guardResultGeneration(repository: PublicationRepository, journal: RemoteJournal) {
  const current = await readRemoteState(repository);
  if (current.journal.id !== journal.id || current.journal.generation !== journal.generation
    || current.journal.maintenance !== 'open') throw new Error('PUBLICATION_CONFLICT: generation or maintenance changed');
}

export function commitRemoteState(repository: PublicationRepository, expectedHead: string, journal: RemoteJournal,
  files: Record<string, Buffer>, message: string, maintenanceId?: string) {
  validate(journal);
  return repository.commit(expectedHead, { ...files, [STATE_PATH]: encode(journal) }, message, maintenanceId);
}

/** The captured head and generation are never refreshed to make an old write succeed. */
export async function openRemoteSession(publication: PublicationTransport, directory: string, targetBranch: string, beforeWrite?: () => Promise<void>) {
  const repository = publication.repository!;
  const restored = await readRemoteState(repository);
  const { journal } = restored;
  if (journal.targetBranch !== targetBranch) throw new Error('REMOTE_TARGET_MISMATCH');
  if (journal.maintenance !== 'open') throw new Error('REPOSITORY_MAINTENANCE');
  const snapshot = restored.snapshot;
  let expectedHead = snapshot.head;
  let stopped = false;
  let cacheWarning: string | undefined;
  // A stage and its bytes were committed atomically. Any immutable containing
  // commit is a valid address when the stage's response checkpoint was lost.
  for (const candidate of Object.values(journal.state.candidates)) {
    if (!candidate.retained) continue;
    const phases = ['registered', 'files', 'metadata', 'evidence', 'complete'];
    const phase = phases.indexOf(candidate.phase!);
    if (phase >= 1) candidate.filesCommit ??= snapshot.head;
    if (phase >= 2) { candidate.metadataCommit ??= snapshot.head; candidate.manifestUrl = immutableUrl(candidate.metadataCommit, `candidates/${candidate.id}/manifest.json`); }
    if (phase >= 3) { candidate.evidenceCommit ??= snapshot.head; candidate.evidenceUrl = immutableUrl(candidate.evidenceCommit, `candidates/${candidate.id}/readback.json`); }
  }
  const cache = async () => {
    try {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, encode(journal.state));
      await rename(temporary, join(directory, 'update-state.json'));
    } catch (error) { cacheWarning = `REMOTE_STATE_SAVED_LOCAL_CACHE_PENDING: ${String(error)}`; }
  };
  const write = async (files: Record<string, Buffer>, message: string) => {
    if (stopped) throw new Error('PUBLICATION_PENDING: re-read remote state before another write');
    const expected = expectedHead;
    validate(journal);
    const next = encode(journal);
    try {
      try {
        await beforeWrite?.();
        await guardRemoteState(repository, expected, journal);
      }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('PUBLICATION_CONFLICT')) stopped = true;
        throw error;
      }
      const head = await repository.commit(expected, { ...files, [STATE_PATH]: next }, message);
      expectedHead = head;
      await cache();
      return head;
    } catch (error) {
      if (stopped) throw error;
      const attemptedCommit = error instanceof PublicationWriteError ? error.attemptedCommit : undefined;
      try {
        const current = await repository.snapshot();
        const actual = await current.read(STATE_PATH);
        if (actual?.equals(next) && (await Promise.all(Object.entries(files).map(async ([path, bytes]) => (await current.read(path))?.equals(bytes)))).every(Boolean)) {
          if (!attemptedCommit || current.head !== attemptedCommit) {
            stopped = true;
            throw new Error(`PUBLICATION_PENDING: write applied, refresh required before continuing; containing commit ${current.head}${attemptedCommit ? `, attempted ${attemptedCommit}` : ''}`);
          }
          expectedHead = current.head; await cache(); return current.head;
        }
        if (current.head !== expected) { stopped = true; throw new Error(`PUBLICATION_PENDING: conflicting remote outcome; ${String(error)}`); }
      } catch (verification) {
        stopped = true; throw new Error(`PUBLICATION_PENDING: cannot establish write outcome${attemptedCommit ? ` for ${attemptedCommit}` : ''}; ${String(verification)}`);
      }
      throw error;
    }
  };
  await cache();
  return { journal, state: journal.state, get head() { return expectedHead; },
    acceptStableCommit(parent: string, commit: string) {
      if (repository.branch !== targetBranch) return;
      if (expectedHead !== parent) throw new Error('PUBLICATION_CONFLICT: unexpected activation parent');
      expectedHead = commit;
    },
    confirmGeneration: () => guardResultGeneration(repository, journal),
    generation: journal.generation, snapshot: restored.snapshot,
    get cacheWarning() { return cacheWarning; },
    save: () => write({}, '保存候选操作进度').then(() => undefined),
    publication: { ...publication, async commit(files: Record<string, Buffer>, message: string) {
      const paths = Object.keys(files), id = paths[0]?.split('/')[1];
      const candidate = journal.state.candidates[id];
      if (!candidate || candidate.generation !== journal.generation || candidate.retained !== true
        || paths.some(path => !path.startsWith(`candidates/${id}/`))) throw new Error('Unregistered candidate write');
      const previousPhase = candidate.phase;
      const evidence = files[`candidates/${id}/readback.json`];
      if (evidence && candidate.sourceKey !== undefined) candidate.evidenceSha256 = sha256(evidence);
      candidate.phase = evidence ? 'evidence'
        : paths.some(path => path.endsWith('/manifest.json')) ? 'metadata' : 'files';
      try { return await write(files, message); }
      catch (error) {
        candidate.phase = previousPhase;
        if (evidence && candidate.sourceKey !== undefined) delete candidate.evidenceSha256;
        throw error;
      }
    } } satisfies PublicationTransport,
  };
}
