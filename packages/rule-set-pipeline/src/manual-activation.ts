import { isDeepStrictEqual } from 'node:util';
import { configuredLayout } from './configuration.js';
import type { ActivationTransport } from './activation-transport.js';
import type { PublicationRepository, PublicationSnapshot } from './publication-repository.js';
import { immutableUrl } from './publication.js';
import { sha256 } from './release.js';
import { commitRemoteState, guardRemoteState, readRemoteState, type ActivationOperation, type ManualOperation, type RemoteJournal } from './remote-state.js';

export function manualControl(operation: Pick<ManualOperation, 'id' | 'kind'>) {
  return {
    revision: operation.id,
    reason: operation.kind === 'rollback' ? 'manual-rollback' as const : 'manual-activation' as const,
    pauseAutomaticActivation: true as const,
    pauseAutomaticRetry: operation.kind === 'rollback',
  };
}

export function applicableResume(journal: RemoteJournal, id: string, active: ObservedActivation | undefined) {
  const decision = Object.hasOwn(journal.resumes ?? {}, id) ? journal.resumes![id] : undefined;
  // The resume clears the specific pin it observed. A later manual switch
  // installs its own pin. Automatic switches leave the resume revision intact.
  return decision && active && (!active.control || active.id === decision.activationId) ? decision : undefined;
}

export function effectiveControl(journal: RemoteJournal, id: string, active: ObservedActivation | undefined) {
  const decision = applicableResume(journal, id, active);
  return decision ? { revision: decision.revision, reason: 'manual-resume' as const,
    pauseAutomaticActivation: false, pauseAutomaticRetry: false } : active?.control;
}

export function activationDigest(record: Record<string, unknown>) {
  // On a shared branch the registration itself becomes the switch parent.
  const { expectedHead: _parent, ...activation } = record;
  return sha256(JSON.stringify(activation));
}

export interface ActivationWriteReservation {
  operationId: string;
  journalHead: string;
}

export async function authorizeActivationWrite(repository: PublicationRepository, branch: string, expectedHead: string,
  files: Record<string, Buffer>, reservation: ActivationWriteReservation) {
  const { snapshot, journal } = await readRemoteState(repository);
  const operation = journal.manualOperations?.[reservation.operationId] ?? journal.automaticOperations?.[reservation.operationId];
  if (snapshot.head !== reservation.journalHead || journal.targetBranch !== branch || journal.maintenance !== 'open'
    || !operation || operation.notCommitted || operation.generation !== journal.generation
    || expectedHead !== (repository.branch === branch ? snapshot.head : operation.expectedHead)) {
    throw new Error('PUBLICATION_CONFLICT: registration, head, generation or maintenance changed');
  }
  if (operation.kind === 'automatic') {
    const check = journal.state.pendingOperation;
    const stable = repository.branch === branch ? snapshot : await repository.snapshot(branch);
    const previousBytes = await stable.read(operation.recordPath);
    const previous = previousBytes && JSON.parse(previousBytes.toString());
    if (!operation.logicalId) throw new Error('PUBLICATION_CONFLICT: automatic activation requires a logical ID');
    const control = effectiveControl(journal, operation.logicalId, previous);
    if (stable.head !== expectedHead || check?.kind !== 'check' || check.status !== 'pending' || check.id !== operation.checkOperationId
      || previous?.id !== operation.previousActivationId || control?.pauseAutomaticActivation
      || (control?.revision ?? null) !== check.controlRevisions?.[operation.logicalId]) {
      throw new Error('PUBLICATION_CONFLICT: automatic activation control revision changed');
    }
  }
  const recordBytes = files[operation.recordPath];
  const record = recordBytes && JSON.parse(recordBytes.toString());
  const directory = operation.recordPath.slice(0, -'activation.json'.length);
  const ruleFiles = Object.keys(files).filter(path => path !== operation.recordPath);
  const configured = operation.logicalId !== undefined;
  const { stem } = configuredLayout(record?.source?.kind === 'github-commit' ? 'cidr-text' : 'plain-yaml');
  if (record?.schemaVersion !== 1 || record.id !== operation.id || record.logicalId !== operation.logicalId || record.expectedHead !== expectedHead
    || record.candidateId !== operation.candidateId || record.candidateEvidenceUrl !== operation.candidateEvidenceUrl
    || record.operation !== (operation.kind === 'activate' ? undefined : operation.kind)
    || record.historicalActivationCommit !== operation.historicalActivationCommit
    || !isDeepStrictEqual(record.control, operation.kind === 'automatic' || !configured ? undefined : manualControl({ id: operation.id, kind: operation.kind })) || activationDigest(record) !== operation.activationDigest
    || !ruleFiles.length || !isDeepStrictEqual(Object.keys(record.files ?? {}).sort(), ruleFiles.sort())
    || ruleFiles.some(path => {
      const expected = record.files[path];
      return (configured ? path !== directory + stem + '.srs' && path !== directory + stem + '.json' : !/\.(srs|json)$/.test(path))
        || expected?.byteLength !== files[path].length || expected?.sha256 !== sha256(files[path]);
    })) {
    throw new Error('Invalid registered activation write set');
  }
}

export async function openManualActivation(transport: ActivationTransport, expectedHead: string) {
  const repository = transport.repository;
  if (!repository) throw new Error('Configured activation requires a remote coordination repository');
  const { snapshot, journal } = await readRemoteState(repository);
  if (journal.targetBranch !== transport.branch) throw new Error('REMOTE_TARGET_MISMATCH');
  if (journal.maintenance !== 'open') throw new Error('REPOSITORY_MAINTENANCE');
  if (repository.branch === transport.branch && snapshot.head !== expectedHead) {
    throw new Error('ACTIVATION_CONFLICT: remote head changed');
  }
  return { repository, snapshot, journal };
}

export async function registerManualActivation(session: Awaited<ReturnType<typeof openManualActivation>>,
  operation: ManualOperation) {
  const { repository, snapshot, journal } = session;
  await guardRemoteState(repository, snapshot.head, journal);
  const registered = { ...journal, manualOperations: { ...journal.manualOperations, [operation.id]: operation } };
  async function markNotCommitted() {
    const current = await readRemoteState(repository);
    const registeredOperation = current.journal.manualOperations?.[operation.id];
    if (!registeredOperation || registeredOperation.notCommitted) return;
    await guardRemoteState(repository, current.snapshot.head, journal);
    const manualOperations = { ...current.journal.manualOperations, [operation.id]: { ...registeredOperation, notCommitted: true as const } };
    await commitRemoteState(repository, current.snapshot.head, { ...current.journal, manualOperations }, {},
      `记录未提交的人工规则操作 ${operation.id}`);
  }
  let head: string;
  try {
    head = await commitRemoteState(repository, snapshot.head, registered, {}, `登记人工规则操作 ${operation.id}`);
  } catch (error) {
    // The stable request was never sent. If registration is visible, close it.
    let checkpointFailure = '';
    try { await markNotCommitted(); }
    catch (checkpointError) { checkpointFailure = `; outcome checkpoint failed: ${String(checkpointError)}`; }
    throw new Error(`MANUAL_REGISTRATION_FAILED: operation ${operation.id}; ${String(error)}${checkpointFailure}`, { cause: error });
  }
  return {
    expectedHead: repository.branch === journal.targetBranch ? head : operation.expectedHead,
    write: { operationId: operation.id, journalHead: head } satisfies ActivationWriteReservation,
    markNotCommitted,
  };
}

export interface ObservedActivation {
  id: string;
  candidateId: string;
  candidateEvidenceUrl: string;
  files: Record<string, { byteLength: number; sha256: string }>;
  history?: { id: string; commit: string }[];
  control?: ReturnType<typeof manualControl>;
}

export interface ActivationOperationResult extends ActivationOperation {
  status: 'committed' | 'not-committed' | 'pending' | 'superseded';
  commit?: string;
  containingCommit?: string;
  error?: string;
}

export async function readActivationOperationResults(repository: PublicationRepository, journal: RemoteJournal,
  stable: PublicationSnapshot, currentByPath: ReadonlyMap<string, ObservedActivation>,
  download: ActivationTransport['download'], operations: ActivationOperation[]) {
  return Promise.all(operations.map(async (operation): Promise<ActivationOperationResult> => {
    const current = currentByPath.get(operation.recordPath);
    if (current?.id === operation.id) {
      let commit: string | undefined;
      try {
        if (current.candidateId !== operation.candidateId || current.candidateEvidenceUrl !== operation.candidateEvidenceUrl) {
          throw new Error('Committed candidate does not match the registered operation');
        }
        commit = await repository.lastChange?.(stable.head, operation.recordPath);
        const containingCommit = commit ?? stable.head;
        const record = JSON.parse((await download(immutableUrl(containingCommit, operation.recordPath))).toString());
        if (record.id !== operation.id || activationDigest(record) !== operation.activationDigest) {
          throw new Error('Commit does not contain the registered activation');
        }
        for (const [path, expected] of Object.entries(current.files)) {
          const bytes = await download(immutableUrl(containingCommit, path));
          if (bytes.length !== expected.byteLength || sha256(bytes) !== expected.sha256) throw new Error(`Committed bytes mismatch: ${path}`);
        }
        return { ...operation, status: 'committed', ...(commit ? { commit } : { containingCommit }) };
      } catch (error) {
        return { ...operation, status: 'pending', ...(commit ? { commit } : { containingCommit: stable.head }), error: String(error) };
      }
    }
    if (operation.notCommitted) return { ...operation, status: 'not-committed' };
    if (current?.id !== operation.previousActivationId) {
      const commit = current?.history?.find(entry => entry.id === operation.id)?.commit;
      return { ...operation, status: 'superseded', ...(commit ? { commit } : {}) };
    }
    // On a shared branch the registration itself is the parent of the proposed switch.
    // Until that parent is fenced off, a lost reply can still represent an in-flight write.
    const shared = repository.branch === journal.targetBranch;
    if (shared ? !stable.parent || stable.parent === operation.expectedHead : stable.head === operation.expectedHead) {
      return { ...operation, status: 'pending' };
    }
    return { ...operation, status: operation.generation !== journal.generation ? 'superseded' : 'not-committed' };
  }));
}
