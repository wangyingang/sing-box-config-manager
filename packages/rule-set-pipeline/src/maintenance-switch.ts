import { githubBaselineTransport, stageRef } from './maintenance-baseline-transport.js';
import { verifyPreparedBaseline } from './maintenance-baseline.js';
import { branchRef, gitMaintenanceRefs, type RefChange } from './maintenance-refs.js';
import type { MaintenanceOptions, MaintenanceRun } from './maintenance.js';
import { inspectBinary } from './native.js';
import { ARTIFACT_REPOSITORY, githubPublication } from './publication.js';
import { BASELINE_PATH, readRemoteState, type RemoteJournal } from './remote-state.js';

export interface MaintenanceCleanup {
  id: string;
  stableHead: string;
  verifiedAt: string;
  refs: Record<string, string>;
}

type Snapshot = Awaited<ReturnType<typeof readRemoteState>>;
type Prepared = Extract<MaintenanceRun, { phase: 'prepared' }>;
type Checkpoint = (current: Snapshot, next: RemoteJournal, message: string, id: string) => Promise<Snapshot>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function targetChanges(branch: string, target: string, head: string, run: Prepared): RefChange[] {
  const { journal, stable } = run.baseline.stages;
  return [
    { ref: branchRef(branch), before: head, after: journal.head },
    { ref: branchRef(stageRef(run.id, 'old-journal')), after: head },
    ...branch === target ? [] : [
      { ref: branchRef(target), before: run.oldHeads.stable, after: stable.head },
      { ref: branchRef(stageRef(run.id, 'old-stable')), after: run.oldHeads.stable },
    ],
  ];
}

/** The old journal scratch ref carries the verified plan across the switch. */
export async function finishMaintenance(options: MaintenanceOptions, initial: Snapshot, checkpoint: Checkpoint, prepared?: Prepared) {
  const { repository } = options;
  let current = initial;
  const { targetBranch, generation } = current.journal;
  const shared = repository.branch === targetBranch;
  const refs = options.refTransport ?? gitMaintenanceRefs();
  const list = async () => new Map((await refs.list()).map(({ ref, head }) => [ref, head]));
  const report = <S extends string, D extends object>(status: S, details: D) => ({ status, current, ...details });
  const otherRefs = (heads: Map<string, string>) => [...heads].filter(([ref]) =>
    ref !== branchRef(repository.branch) && ref !== branchRef(targetBranch)).map(([ref, head]) => ({ ref, head }));

  let phase = 'switch';
  let maintenanceId = prepared?.id;
  try {
    if (prepared) {
      const changes = targetChanges(repository.branch, targetBranch, current.snapshot.head, prepared);
      const before = await list();
      if (changes.some(change => before.get(change.ref) !== change.before)) {
        throw new Error('MAINTENANCE_CONFLICT: switch refs changed');
      }
      let pushError: unknown;
      try { await refs.update(changes); }
      catch (error) { pushError = error; }
      const after = await list();
      if (changes.every(change => after.get(change.ref) === change.before)) {
        throw new Error(`MAINTENANCE_SWITCH_REJECTED: ${errorMessage(pushError ?? 'remote refs did not change')}`);
      }
      if (changes.some(change => after.get(change.ref) !== change.after)) {
        throw new Error('MAINTENANCE_SWITCH_UNCERTAIN: remote refs differ from the transaction');
      }
      current = await readRemoteState(repository);
    }
    const bytes = await current.snapshot.read(BASELINE_PATH);
    const marker = bytes && JSON.parse(bytes.toString());
    if (marker?.schemaVersion !== 1 || marker.generation !== generation || !/^[a-f0-9-]{36}$/.test(marker.maintenanceId)
      || (maintenanceId !== undefined && maintenanceId !== marker.maintenanceId)) {
      if (!prepared && !current.journal.maintenanceCleanup && (!bytes || current.journal.maintenance === 'open')) {
        return report('deferred', { reason: 'No recoverable maintenance run' });
      }
      throw new Error('MAINTENANCE_SWITCH_UNCERTAIN: current baseline identity does not match');
    }
    maintenanceId = marker.maintenanceId as string;
    if (current.journal.maintenance === 'open' && current.journal.lastCleanupAt) {
      return report('completed', { phase: 'completed', maintenanceId, completedAt: current.journal.lastCleanupAt, otherRefs: otherRefs(await list()) });
    }
    if (current.journal.maintenance !== 'maintenance' || current.journal.maintenanceRun) {
      throw new Error('MAINTENANCE_SWITCH_UNCERTAIN: current journal is not an isolated baseline');
    }

    phase = 'readback';
    let cleanup = current.journal.maintenanceCleanup;
    if (!cleanup) {
      const binary = options.binary;
      if (!binary) return report('failed', { phase, maintenanceId, error: 'Baseline readback requires an explicit sing-box 1.14.4 binary' });
      await inspectBinary(binary);
      const backup = stageRef(maintenanceId, 'old-journal');
      const old = await readRemoteState({ ...repository, snapshot: () => repository.snapshot(backup) });
      const run = old.journal.maintenanceRun;
      if (old.journal.id !== current.journal.id || old.journal.generation !== generation || run?.id !== maintenanceId
        || run.phase !== 'prepared' || old.snapshot.parent !== run.readyHead) {
        throw new Error('Invalid old journal recovery ref');
      }
      const { stages } = run.baseline;
      const changes = targetChanges(repository.branch, targetBranch, old.snapshot.head, run);
      const verifyRefs = async () => {
        const heads = await list();
        if (changes.some(change => heads.get(change.ref) !== change.after)) {
          throw new Error('MAINTENANCE_SWITCH_UNCERTAIN: switched heads or recovery refs changed');
        }
      };
      if (current.snapshot.head !== stages.journal.head) throw new Error('Switched journal head does not match its verified stage');
      await verifyRefs();
      const publication = options.publication ?? githubPublication();
      await verifyPreparedBaseline({ repository, transport: options.baseline ?? githubBaselineTransport(), publication, binary, targetBranch,
        plan: run.plan, runId: maintenanceId }, stages);
      const stable = shared ? current.snapshot : await repository.snapshot(targetBranch);
      if (stable.head !== stages.stable.head) throw new Error('Switched stable head does not match its verified stage');
      for (const { record } of run.plan.retain.active) {
        for (const path of Object.keys(record.files)) {
          const url = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${targetBranch}/${path}`;
          const actual = await publication.download(url);
          if (!(await stable.read(path))?.equals(actual)) throw new Error(`Stable URL readback mismatch: ${url}`);
        }
      }
      await verifyRefs();
      cleanup = { id: maintenanceId, stableHead: stages.stable.head, verifiedAt: (options.now ?? new Date()).toISOString(),
        refs: Object.fromEntries([...Object.values(stages).map(stage => [branchRef(stage.ref), stage.head]),
          ...changes.filter(change => !change.before).map(change => [change.ref, change.after!])]) };
      phase = 'checkpoint';
      current = await checkpoint(current, { ...current.journal, maintenanceCleanup: cleanup }, `记录规则产物切换核验 ${maintenanceId}`, maintenanceId);
    }

    phase = 'cleanup';
    if (cleanup.id !== maintenanceId) throw new Error('Maintenance cleanup identity mismatch');
    const verifyLive = (heads: Map<string, string>) => {
      if (heads.get(branchRef(repository.branch)) !== current.snapshot.head
        || heads.get(branchRef(targetBranch)) !== (shared ? current.snapshot.head : cleanup.stableHead)) {
        throw new Error('MAINTENANCE_CONFLICT: live heads changed during cleanup');
      }
    };
    const owned = (heads: Map<string, string>) => Object.entries(cleanup.refs)
      .filter(([ref, before]) => heads.get(ref) === before).map(([ref, before]) => ({ ref, before }));
    const before = await list();
    verifyLive(before);
    let deleteError: unknown;
    try { await refs.update(owned(before)); }
    catch (error) { deleteError = error; }
    const after = await list();
    verifyLive(after);
    if (owned(after).length) throw new Error(`Maintenance refs still require cleanup: ${errorMessage(deleteError ?? 'refs did not change')}`);
    const { maintenanceCleanup: _cleanup, ...journal } = current.journal;
    phase = 'reopen';
    const completedAt = (options.now ?? new Date()).toISOString();
    current = await checkpoint(current, { ...journal, maintenance: 'open', lastCleanupAt: completedAt },
      `完成规则产物清理 ${maintenanceId}`, maintenanceId);
    return report('completed', { phase: 'completed', maintenanceId, completedAt, otherRefs: otherRefs(after) });
  } catch (error) {
    return report('failed', { phase, maintenanceId, error: errorMessage(error), observedJournalHead: current.snapshot.head });
  }
}
