import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { immutableUrl, type PublicationTransport } from './publication.js';
import type { PublicationRepository } from './publication-repository.js';
import { PublicationWriteError } from './publication-repository.js';
import type { UpdateState } from './update.js';
import { parseBuildConfiguration } from './configured-build.js';

export const STATE_PATH = 'pipeline/state.json';
export const IDENTITY_PATH = 'pipeline/identity.json';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export interface RemoteJournal {
  schemaVersion: 1; id: string; generation: number; maintenance: 'open' | 'maintenance'; targetBranch: string;
  state: UpdateState;
  manualOperations?: Record<string, ManualOperation>;
}

export interface ManualOperation {
  id: string;
  kind: 'activate' | 'rollback';
  logicalId: string;
  recordPath: string;
  generation: number;
  expectedHead: string;
  previousActivationId?: string;
  candidateId: string;
  candidateEvidenceUrl: string;
  historicalActivationCommit?: string;
  notCommitted?: true;
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const branch = (value: unknown) => typeof value === 'string' && (value === 'main' || /^acceptance-[a-zA-Z0-9._-]+$/.test(value));
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validatePin(pin: unknown, id: string) {
  if (!object(pin) || !object(pin.identity)) throw new Error('REMOTE_STATE_CORRUPT: source pin');
  const identity = pin.identity;
  if (!Number.isSafeInteger(identity.releaseId) || identity.releaseId <= 0 || String(identity.releaseId) !== id
    || !/^[0-9]{14}$/.test(identity.tag) || !sha(identity.commit) || identity.repository !== 'v2fly/domain-list-community') {
    throw new Error('REMOTE_STATE_CORRUPT: source identity');
  }
  for (const [key, name] of [['yaml', 'dlc.dat_plain.yml'], ['checksum', 'dlc.dat_plain.yml.sha256sum']] as const) {
    const asset = identity[key];
    if (!object(asset) || !Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.name !== name
      || asset.url !== `https://github.com/v2fly/domain-list-community/releases/download/${identity.tag}/${name}`) {
      throw new Error('REMOTE_STATE_CORRUPT: source asset identity');
    }
  }
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

function validate(value: unknown): asserts value is RemoteJournal {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !['open', 'maintenance'].includes(value.maintenance)
    || !branch(value.targetBranch) || !object(value.state)) throw new Error('REMOTE_STATE_CORRUPT');
  if (value.manualOperations !== undefined) {
    if (!object(value.manualOperations)) throw new Error('REMOTE_STATE_CORRUPT: manual operations');
    for (const [id, op] of Object.entries(value.manualOperations)) {
      if (!object(op) || !/^[a-f0-9-]{36}$/.test(id) || op.id !== id || !['activate', 'rollback'].includes(op.kind)
        || typeof op.logicalId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(op.logicalId)
        || typeof op.recordPath !== 'string' || !/^stable\/(?:[a-z0-9][a-z0-9._-]*\/)+activation\.json$/.test(op.recordPath)
        || !Number.isSafeInteger(op.generation) || op.generation < 1 || op.generation > value.generation
        || !sha(op.expectedHead) || op.previousActivationId !== undefined && typeof op.previousActivationId !== 'string'
        || typeof op.candidateId !== 'string' || !/^[a-f0-9-]+$/.test(op.candidateId)
        || typeof op.candidateEvidenceUrl !== 'string'
        || !sha(op.candidateEvidenceUrl.split('/')[5])
        || op.candidateEvidenceUrl !== immutableUrl(op.candidateEvidenceUrl.split('/')[5], `candidates/${op.candidateId}/readback.json`)
        || (op.kind === 'rollback' ? !sha(op.historicalActivationCommit) : op.historicalActivationCommit !== undefined)
        || op.notCommitted !== undefined && op.notCommitted !== true) throw new Error('REMOTE_STATE_CORRUPT: manual operation');
    }
  }
  const state = value.state;
  if (state.schemaVersion !== 1 || !object(state.pinned) || !object(state.processed) || !object(state.candidates)
    || state.configuredProcessed !== undefined && !object(state.configuredProcessed)) throw new Error('REMOTE_STATE_CORRUPT');
  for (const [id, pin] of Object.entries(state.pinned)) {
    validatePin(pin, id);
  }
  for (const [id, candidate] of Object.entries(state.candidates)) {
    if (!object(candidate) || candidate.id !== id || !/^[a-f0-9-]+$/.test(id)
      || !Number.isSafeInteger(candidate.releaseId) || !state.pinned[String(candidate.releaseId)]
      || candidate.tag !== state.pinned[String(candidate.releaseId)].identity.tag
      || !['building', 'publishing', 'verified', 'failed'].includes(candidate.status)
      || candidate.generation !== value.generation || typeof candidate.retained !== 'boolean'
      || typeof candidate.operationId !== 'string' || !/^[a-f0-9-]+$/.test(candidate.operationId)
      || !['update', 'rebuild'].includes(candidate.operation)
      || !['registered', 'files', 'metadata', 'evidence', 'complete'].includes(candidate.phase)
      || candidate.targetBranch !== value.targetBranch
      || ['filesCommit', 'metadataCommit', 'evidenceCommit'].some(key => candidate[key] !== undefined && !sha(candidate[key]))) {
      throw new Error('REMOTE_STATE_CORRUPT: candidate');
    }
    if (candidate.phase !== 'registered' && !digest(candidate.buildId)
      || ['metadata', 'evidence', 'complete'].includes(candidate.phase) && !sha(candidate.filesCommit)
      || ['evidence', 'complete'].includes(candidate.phase) && !sha(candidate.metadataCommit)
      || candidate.phase === 'complete' && !sha(candidate.evidenceCommit)
      || candidate.logicalId !== undefined && (typeof candidate.logicalId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(candidate.logicalId) || !candidate.definition)
      || candidate.phase !== 'complete' && candidate.retained && candidate.operationId !== state.pendingOperation?.id) {
      throw new Error('REMOTE_STATE_CORRUPT: candidate progress or operation');
    }
    if (candidate.manifestUrl !== undefined && (!candidate.metadataCommit
        || candidate.manifestUrl !== immutableUrl(candidate.metadataCommit, `candidates/${id}/manifest.json`))
      || candidate.evidenceUrl !== undefined && (!candidate.evidenceCommit
        || candidate.evidenceUrl !== immutableUrl(candidate.evidenceCommit, `candidates/${id}/readback.json`))) {
      throw new Error('REMOTE_STATE_CORRUPT: candidate address');
    }
    if (candidate.definition !== undefined) {
      const definition = parseBuildConfiguration(JSON.stringify({ schemaVersion: 1, source: 'v2fly/domain-list-community',
        target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: value.targetBranch }, ruleSets: [candidate.definition] })).ruleSets[0];
      if (candidate.logicalId !== definition.id) throw new Error('REMOTE_STATE_CORRUPT: candidate logical ID');
    }
  }
  const processed = (records: unknown) => {
    if (!object(records)) throw new Error('REMOTE_STATE_CORRUPT: processed');
    for (const [releaseId, record] of Object.entries(records)) {
      if (!object(record) || typeof record.candidateId !== 'string' || !/^[a-f0-9-]+$/.test(record.candidateId)
        || !/^[0-9]{14}$/.test(record.tag) || !/^[1-9][0-9]*$/.test(releaseId)
        || typeof record.evidenceUrl !== 'string'
        || record.definitionSha256 !== undefined && !digest(record.definitionSha256)) throw new Error('REMOTE_STATE_CORRUPT: processed');
    }
  };
  processed(state.processed);
  for (const records of Object.values(state.configuredProcessed ?? {})) processed(records);
  if (state.pendingOperation !== undefined) {
    const op = state.pendingOperation;
    if (!object(op) || typeof op.id !== 'string' || !/^[a-f0-9-]+$/.test(op.id) || !['update', 'rebuild'].includes(op.kind)
      || op.generation !== value.generation || !Number.isSafeInteger(op.releaseId) || !/^[0-9]{14}$/.test(op.tag)
      || !sha(op.expectedHead) || !Array.isArray(op.candidateIds) || new Set(op.candidateIds).size !== op.candidateIds.length
      || !state.pinned[String(op.releaseId)] || op.tag !== state.pinned[String(op.releaseId)].identity.tag
      || !['pending', 'complete'].includes(op.status)) throw new Error('REMOTE_STATE_CORRUPT: operation');
    if (op.configuration !== undefined) {
      if (typeof op.configuration !== 'string') throw new Error('REMOTE_STATE_CORRUPT: operation configuration');
      const configuration = parseBuildConfiguration(op.configuration);
      if (configuration.target.branch !== value.targetBranch || op.selectedIds !== undefined && (!Array.isArray(op.selectedIds)
        || !op.selectedIds.length || new Set(op.selectedIds).size !== op.selectedIds.length
        || op.selectedIds.some((id: unknown) => !configuration.ruleSets.some(rule => rule.id === id)))) throw new Error('REMOTE_STATE_CORRUPT: operation selection');
    } else if (op.selectedIds !== undefined) throw new Error('REMOTE_STATE_CORRUPT: operation selection');
    const configuration = op.configuration === undefined ? undefined : parseBuildConfiguration(op.configuration);
    for (const id of op.candidateIds) {
      const candidate = state.candidates[id];
      const definition = configuration?.ruleSets.find(rule => rule.id === candidate?.logicalId);
      if (typeof id !== 'string' || !object(candidate) || candidate.operationId !== op.id || candidate.operation !== op.kind
        || candidate.releaseId !== op.releaseId || candidate.tag !== op.tag
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

export function commitRemoteState(repository: PublicationRepository, expectedHead: string, journal: RemoteJournal,
  files: Record<string, Buffer>, message: string) {
  validate(journal);
  return repository.commit(expectedHead, { ...files, [STATE_PATH]: encode(journal) }, message);
}

/** The captured head and generation are never refreshed to make an old write succeed. */
export async function openRemoteSession(publication: PublicationTransport, directory: string, targetBranch: string) {
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
      try { await guardRemoteState(repository, expected, journal); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('PUBLICATION_CONFLICT')) stopped = true;
        throw error;
      }
      const head = await commitRemoteState(repository, expected, journal, files, message);
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
  return { state: journal.state, generation: journal.generation, snapshot: restored.snapshot,
    get cacheWarning() { return cacheWarning; },
    save: () => write({}, '保存候选操作进度').then(() => undefined),
    publication: { ...publication, async commit(files: Record<string, Buffer>, message: string) {
      const paths = Object.keys(files), id = paths[0]?.split('/')[1];
      const candidate = journal.state.candidates[id];
      if (!candidate || candidate.generation !== journal.generation || candidate.retained !== true
        || paths.some(path => !path.startsWith(`candidates/${id}/`))) throw new Error('Unregistered candidate write');
      const previousPhase = candidate.phase;
      candidate.phase = paths.some(path => path.endsWith('/readback.json')) ? 'evidence'
        : paths.some(path => path.endsWith('/manifest.json')) ? 'metadata' : 'files';
      try { return await write(files, message); }
      catch (error) { candidate.phase = previousPhase; throw error; }
    } } satisfies PublicationTransport,
  };
}
