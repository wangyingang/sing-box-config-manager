import type { ActivationTransport } from './activation-transport.js';
import type { PublicationRepository, PublicationSnapshot } from './publication-repository.js';
import { immutableUrl } from './publication.js';
import { sha256 } from './release.js';
import { commitRemoteState, guardRemoteState, readRemoteState, type ManualOperation, type RemoteJournal } from './remote-state.js';

export function manualControl(operation: Pick<ManualOperation, 'id' | 'kind'>) {
  return {
    revision: operation.id,
    reason: operation.kind === 'rollback' ? 'manual-rollback' as const : 'manual-activation' as const,
    pauseAutomaticActivation: true as const,
    pauseAutomaticRetry: operation.kind === 'rollback',
  };
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
  let head: string;
  try {
    head = await commitRemoteState(repository, snapshot.head, registered, {}, `登记人工规则操作 ${operation.id}`);
  } catch (error) {
    // No stable write is attempted when registration is uncertain.
    throw new Error(`MANUAL_REGISTRATION_FAILED: operation ${operation.id}; ${String(error)}`, { cause: error });
  }
  return {
    expectedHead: repository.branch === journal.targetBranch ? head : operation.expectedHead,
    // Maintenance must drain the durable reservation before rewriting either ref.
    guard: () => guardRemoteState(repository, head, journal),
    async markNotCommitted() {
      const current = await readRemoteState(repository);
      await guardRemoteState(repository, current.snapshot.head, journal);
      const registeredOperation = current.journal.manualOperations?.[operation.id];
      if (!registeredOperation) return;
      const manualOperations = { ...current.journal.manualOperations, [operation.id]: { ...registeredOperation, notCommitted: true as const } };
      await commitRemoteState(repository, current.snapshot.head, { ...current.journal, manualOperations }, {},
        `记录未提交的人工规则操作 ${operation.id}`);
    },
  };
}

export interface ObservedActivation {
  id: string;
  candidateId: string;
  candidateEvidenceUrl: string;
  files: Record<string, { byteLength: number; sha256: string }>;
  history?: { id: string; commit: string }[];
}

interface ManualOperationResult extends ManualOperation {
  status: 'committed' | 'not-committed' | 'pending' | 'superseded';
  commit?: string;
  error?: string;
}

export async function readManualOperationResults(repository: PublicationRepository, journal: RemoteJournal,
  stable: PublicationSnapshot, currentByPath: ReadonlyMap<string, ObservedActivation>,
  download: ActivationTransport['download']) {
  const operations = Object.values(journal.manualOperations ?? {});
  return Promise.all(operations.map(async (operation): Promise<ManualOperationResult> => {
    const current = currentByPath.get(operation.recordPath);
    if (current?.id === operation.id) {
      const commit = stable.head;
      try {
        if (current.candidateId !== operation.candidateId || current.candidateEvidenceUrl !== operation.candidateEvidenceUrl) {
          throw new Error('Committed candidate does not match the registered operation');
        }
        for (const [path, expected] of Object.entries(current.files)) {
          const bytes = await download(immutableUrl(commit, path));
          if (bytes.length !== expected.byteLength || sha256(bytes) !== expected.sha256) throw new Error(`Committed bytes mismatch: ${path}`);
        }
        return { ...operation, status: 'committed', commit };
      } catch (error) {
        return { ...operation, status: 'pending', commit, error: String(error) };
      }
    }
    if (operation.notCommitted) return { ...operation, status: 'not-committed' };
    if (operation.generation !== journal.generation || current?.id !== operation.previousActivationId) {
      const commit = current?.history?.find(entry => entry.id === operation.id)?.commit;
      return { ...operation, status: 'superseded', ...(commit ? { commit } : {}) };
    }
    // On a shared branch the registration itself is the parent of the proposed switch.
    // Until that parent is fenced off, a lost reply can still represent an in-flight write.
    const shared = repository.branch === journal.targetBranch;
    if (shared ? !stable.parent || stable.parent === operation.expectedHead : stable.head === operation.expectedHead) {
      return { ...operation, status: 'pending' };
    }
    return { ...operation, status: 'not-committed' };
  }));
}
