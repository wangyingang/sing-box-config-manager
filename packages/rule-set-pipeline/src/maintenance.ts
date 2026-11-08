import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ActivationTransport } from './activation-transport.js';
import type { PublicationRepository } from './publication-repository.js';
import { PublicationWriteError } from './publication-repository.js';
import { githubPublication, type PublicationTransport } from './publication.js';
import { commitRemoteState, IDENTITY_PATH, readRemoteState, STATE_PATH, type RemoteJournal } from './remote-state.js';
import { prepareBaseline, verifyPreparedBaseline } from './maintenance-baseline.js';
import { githubBaselineTransport, type BaselineTransport, type PreparedBaseline } from './maintenance-baseline-transport.js';
import { gitMaintenanceRefs, type MaintenanceRefTransport, type Ref } from './maintenance-refs.js';
import { finishMaintenance } from './maintenance-switch.js';
export type { MaintenanceCleanup } from './maintenance-switch.js';
import { inspectBinary } from './native.js';
import { candidateFiles } from './candidate-publication.js';
import { readRemoteStatus } from './remote-status.js';

export interface MaintenanceSchedule { periodDays: number; startAt: string }
interface Heads { journal: string; stable: string }

export type MaintenanceRun = { id: string; generation: number; oldHeads: Heads } & (
  { phase: 'isolated'; isolatedHead?: never; plan?: never }
  | { phase: 'ready'; isolatedHead: string; plan: MaintenancePlan }
  | { phase: 'prepared'; isolatedHead: string; plan: MaintenancePlan; readyHead: string; baseline: PreparedBaseline }
);

export interface MaintenanceOptions {
  repository: PublicationRepository;
  publication?: PublicationTransport;
  activation?: Pick<ActivationTransport, 'download'>;
  baseline?: BaselineTransport;
  refTransport?: MaintenanceRefTransport;
  refs?: () => Promise<Ref[]>;
  binary?: string;
  now?: Date;
}

export type MaintenanceRequest =
  | { action: 'preview' | 'enter'; schedule?: MaintenanceSchedule; manual?: boolean }
  | { action: 'resume' }
  | { action: 'prepare' | 'switch'; maintenanceId?: string }
  | { action: 'abort'; maintenanceId: string };

const day = 86_400_000;
function assessSchedule(schedule: MaintenanceSchedule | undefined, lastCleanupAt: string | undefined, now: Date) {
  if (!schedule) return { status: 'disabled' as const, enabled: false, lastCleanupAt };
  const start = new Date(schedule.startAt);
  if (!Number.isSafeInteger(schedule.periodDays) || schedule.periodDays <= 0
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(schedule.startAt)
    || !Number.isFinite(start.valueOf()) || start.toISOString() !== (schedule.startAt.length === 20 ? schedule.startAt.slice(0, -1) + '.000Z' : schedule.startAt)) {
    throw new Error('Invalid maintenance schedule: specify positive period days and a UTC start date');
  }
  const origin = Math.max(start.valueOf(), lastCleanupAt ? Date.parse(lastCleanupAt) : start.valueOf());
  const nextDue = new Date(origin + schedule.periodDays * day);
  if (!Number.isFinite(nextDue.valueOf())) throw new Error('Maintenance due date is out of range');
  return { ...schedule, enabled: true, lastCleanupAt, nextDueAt: nextDue.toISOString(),
    status: now < nextDue ? 'not-due' as const : 'due' as const };
}

async function scan(options: MaintenanceOptions) {
  const status = await readRemoteStatus({ ...options, maintenanceInventory: true });
  const { targetBranch, snapshot, stable, currentByPath, historicalActivations, resumes } = status.inventory!;
  const blockers = [...status.pendingOperations];
  const active = [...currentByPath].map(([recordPath, record]) => {
    const definition = status.state.candidates[record.candidateId]?.definition;
    const candidatePaths = candidateFiles(definition).map(file => `candidates/${record.candidateId}/${file}`);
    const control = record.logicalId ? status.activeRuleVersions[record.logicalId].control : undefined;
    // The Release baseline cannot yet rebase the evidence for an active CIDR candidate.
    if (record.source?.kind === 'github-commit') {
      blockers.push({ id: record.id, candidateId: record.candidateId, logicalId: record.logicalId,
        status: 'unsupported-active-rule-format', error: `History cleanup does not yet support the active CIDR rule set: ${record.logicalId}` });
    }
    return { recordPath, record, candidatePaths, ...(control ? { control } : {}) };
  });
  const currentIds = new Set(active.map(({ record }) => record.candidateId));
  const candidateIds = new Set(snapshot.paths.flatMap(path => /^candidates\/([a-f0-9-]+)\//.exec(path)?.[1] ?? []));
  for (const candidate of Object.values(status.state.candidates)) candidateIds.add(candidate.id);
  const discardCandidates: string[] = [];
  for (const id of candidateIds) {
    if (currentIds.has(id)) continue;
    const candidate = status.state.candidates[id];
    const completed = candidate ? candidate.phase === 'complete' && candidate.status === 'verified'
      : status.candidateAvailability[id]?.status === 'available';
    if (completed || candidate?.retained === false) {
      discardCandidates.push(id);
    } else if (!blockers.some(blocker => blocker.candidateId === id)) {
      blockers.push({ id, candidateId: id, status: 'candidate-completion-unverified',
        error: status.candidateAvailability[id]?.error });
    }
  }
  for (const [id, check] of Object.entries(status.state.latestChecks ?? {})) {
    if (check.status === 'verification-pending') blockers.push({ id: check.operationId, logicalId: id, status: check.status, error: check.error });
  }
  const knownPaths = new Set(active.flatMap(({ recordPath, record }) => [recordPath, ...Object.keys(record.files)]));
  const unmatched = stable.paths.filter(path => path.startsWith('stable/') && /\.(srs|json)$/.test(path) && !knownPaths.has(path));
  for (const path of unmatched) blockers.push({ id: path, status: 'unidentified-stable-file' });
  const journal = status.state;
  const operations = [...status.manualOperations, ...status.automaticOperations];
  const ownRefs = new Set([`refs/heads/${options.repository.branch}`, `refs/heads/${targetBranch}`]);
  const otherRefs = (await (options.refs ?? (options.refTransport ?? gitMaintenanceRefs()).list)()).filter(({ ref }) => !ownRefs.has(ref));
  const plan = {
    retain: {
      active,
      journalPaths: [IDENTITY_PATH, STATE_PATH],
      progress: {
        pinnedReleaseIds: Object.keys(journal.pinned),
        processedReleaseIds: Object.keys(journal.processed),
        configuredProcessedReleaseIds: Object.fromEntries(Object.entries(journal.configuredProcessed ?? {})
          .map(([id, records]) => [id, Object.keys(records)])),
        latestChecks: journal.latestChecks ?? {},
        resumes,
      },
    },
    discard: {
      candidateIds: discardCandidates.sort(),
      activations: historicalActivations,
      completedOperationIds: [...operations.filter(operation => operation.status !== 'pending').map(operation => operation.id),
        ...(journal.pendingOperation?.status === 'complete' ? [journal.pendingOperation.id] : [])],
    },
    otherRefs,
  };
  const hasCleanup = plan.discard.candidateIds.length > 0 || plan.discard.completedOperationIds.length > 0
    || Object.values(historicalActivations).some(entries => entries.length > 0);
  return { heads: { journal: snapshot.head, stable: stable.head }, plan, blockers, hasCleanup };
}
export type MaintenancePlan = Awaited<ReturnType<typeof scan>>['plan'];

type Snapshot = Awaited<ReturnType<typeof readRemoteState>>;
async function checkpoint(repository: PublicationRepository, current: Snapshot, next: RemoteJournal, message: string, id = current.journal.maintenanceRun?.id) {
  let expected: string;
  try {
    expected = await commitRemoteState(repository, current.snapshot.head, next, {}, message, id);
  } catch (error) {
    if (!(error instanceof PublicationWriteError)) throw error;
    expected = error.attemptedCommit;
  }
  const actual = await readRemoteState(repository);
  if (actual.snapshot.head !== expected) {
    throw new Error(`MAINTENANCE_WRITE_UNCERTAIN: ${expected}; read remote state before retrying`);
  }
  return actual;
}

/** Coordinate publication history maintenance through the remote journal. */
export async function manageMaintenance(options: MaintenanceOptions & MaintenanceRequest) {
  const { repository, action } = options;
  let current = await readRemoteState(repository);
  const schedule = assessSchedule('schedule' in options ? options.schedule : undefined, current.journal.lastCleanupAt, options.now ?? new Date());
  const report = <S extends string, D extends object>(status: S, details: D) => ({
    status, schedule, generation: current.journal.generation, maintenance: current.journal.maintenance,
    run: current.journal.maintenanceRun, ...details,
  });
  const inspect = async () => {
    try { return await scan(options); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  if (action === 'enter' && current.journal.maintenance === 'open' && !options.manual && schedule.status !== 'due') {
    return report(schedule.status, {});
  }
  if (action === 'preview' || action === 'enter') {
    const preview = await inspect();
    if ('error' in preview) return report('deferred', preview);
    if (preview.heads.journal !== current.snapshot.head) {
      current = await readRemoteState(repository);
      return report('deferred', { reason: 'Journal changed during preview' });
    }
    if (current.journal.maintenance === 'maintenance') {
      return report('deferred', { ...preview, reason: 'Maintenance already active; use maintenance-resume' });
    }
    if (!options.manual && schedule.status !== 'due') return report(schedule.status, preview);
    if (preview.blockers.length) return report('deferred', preview);
    if (!preview.hasCleanup) return report('no-cleanup', preview);
    if (action === 'preview') return report('ready', preview);
    const run: MaintenanceRun = { id: randomUUID(), generation: current.journal.generation + 1, phase: 'isolated', oldHeads: preview.heads };
    try {
      current = await checkpoint(repository, current, {
        ...current.journal, generation: run.generation, maintenance: 'maintenance', maintenanceRun: run,
      }, `进入规则产物维护 ${run.id}`);
    } catch (error) {
      if (!(error instanceof Error) || !/^(PUBLICATION_CONFLICT|MANUAL_OPERATION_PENDING)/.test(error.message)) throw error;
      current = await readRemoteState(repository);
      return report('deferred', { reason: error.message });
    }
    if (current.journal.maintenanceRun?.id !== run.id) throw new Error('MAINTENANCE_CONFLICT: isolation identity changed');
  }

  const finish = async (prepared?: Extract<MaintenanceRun, { phase: 'prepared' }>) => {
    const { status, current: latest, ...details } = await finishMaintenance(options, current, checkpoint.bind(undefined, repository), prepared);
    current = latest;
    return report(status, details);
  };
  const run = current.journal.maintenanceRun;
  if ((action === 'prepare' || action === 'switch') && options.maintenanceId !== undefined && options.maintenanceId !== run?.id) {
    return report('deferred', { reason: 'Maintenance identity mismatch' });
  }
  if (!run && (action === 'resume' || action === 'switch')) return finish();
  if (action === 'switch' && run?.phase !== 'prepared') return report('deferred', { reason: 'Prepare and verify a baseline before switching' });
  if (!run) return report('deferred', { reason: 'No recoverable maintenance run' });
  if (action === 'abort' && options.maintenanceId !== run.id) return report('deferred', { reason: 'Maintenance identity mismatch' });
  const shared = repository.branch === current.journal.targetBranch;
  const expectedParent = run.phase === 'isolated' ? run.oldHeads.journal : run.phase === 'ready' ? run.isolatedHead : run.readyHead;
  const verifyLiveHeads = async () => {
    const live = await repository.snapshot();
    return live.head === current.snapshot.head && live.parent === expectedParent
      && (shared || (await repository.snapshot(current.journal.targetBranch)).head === run.oldHeads.stable);
  };
  if (action === 'prepare' || (action === 'resume' || action === 'switch') && run.phase === 'prepared') {
    const binary = options.binary;
    if (!binary) return report('deferred', { reason: 'Baseline verification requires an explicit sing-box 1.14.4 binary' });
    let tool;
    try { tool = await inspectBinary(binary); }
    catch (error) { return report('deferred', { reason: error instanceof Error ? error.message : String(error) }); }
    if (run.phase === 'isolated') return report('deferred', { reason: 'Resume maintenance to finish recording its retention plan first' });
    if (!await verifyLiveHeads()) return report(action === 'switch' ? 'failed' : 'deferred', {
      reason: 'Maintenance heads changed; cannot verify this baseline',
    });
    const verification = { repository, transport: options.baseline ?? githubBaselineTransport(),
      publication: options.publication ?? githubPublication(), binary, targetBranch: current.journal.targetBranch,
      plan: run.plan, runId: run.id };
    if (run.phase === 'prepared') {
      try { await verifyPreparedBaseline(verification, run.baseline.stages); }
      catch (error) { return report('failed', { error: error instanceof Error ? error.message : String(error) }); }
      if (!await verifyLiveHeads()) return report(action === 'switch' ? 'failed' : 'deferred', {
        reason: 'Maintenance heads changed during verification',
      });
      return action === 'switch' ? finish(run) : report('prepared', { baseline: run.baseline });
    }
    // Revalidate the frozen old inventory before copying its files.
    const verified = await inspect();
    if ('error' in verified) return report('deferred', verified);
    if (verified.blockers.length || verified.heads.journal !== current.snapshot.head
      || verified.heads.stable !== (shared ? current.snapshot.head : run.oldHeads.stable)
      || !isDeepStrictEqual(run.plan.retain, verified.plan.retain) || !isDeepStrictEqual(run.plan.discard, verified.plan.discard)) {
      return report('deferred', { ...verified, reason: 'The recorded plan cannot be verified against the isolated state' });
    }
    let baseline: PreparedBaseline;
    try {
      const stable = shared ? current.snapshot : await repository.snapshot(current.journal.targetBranch);
      if (!shared && stable.head !== run.oldHeads.stable) return report('deferred', { reason: 'Stable head changed before preparation' });
      baseline = await prepareBaseline({ ...verification, journal: current.journal, source: current.snapshot, stable, tool,
        now: options.now ?? new Date() });
    } catch (error) {
      return report('failed', { error: error instanceof Error ? error.message : String(error) });
    }
    if (!await verifyLiveHeads()) return report('deferred', { reason: 'Maintenance heads changed during preparation' });
    current = await checkpoint(repository, current, { ...current.journal, maintenanceRun: {
      ...run, phase: 'prepared', readyHead: current.snapshot.head, baseline,
    } }, `记录已核验的规则产物基线 ${run.id}`);
    return report('prepared', { baseline });
  }
  const isolated = await inspect();
  if ('error' in isolated) return report('deferred', isolated);
  // Shared-branch control commits move its head without changing stable bytes.
  if (current.snapshot.parent !== expectedParent || isolated.heads.journal !== current.snapshot.head
    || isolated.heads.stable !== (shared ? current.snapshot.head : run.oldHeads.stable)) {
    return report('deferred', { reason: 'Maintenance heads changed; cannot prove this is still before the switch', ...isolated });
  }
  if (isolated.blockers.length) return report('deferred', isolated);
  if (run.phase !== 'isolated' && (!isDeepStrictEqual(run.plan.retain, isolated.plan.retain)
    || !isDeepStrictEqual(run.plan.discard, isolated.plan.discard))) {
    return report('deferred', { reason: 'The recorded plan differs from the isolated state', ...isolated });
  }
  if (action === 'abort') {
    const { maintenanceRun: _ended, ...journal } = current.journal;
    current = await checkpoint(repository, current, { ...journal, maintenance: 'open' }, `安全退出规则产物维护 ${run.id}`);
    return report('aborted', { maintenanceId: run.id });
  }
  if (run.phase === 'isolated') {
    current = await checkpoint(repository, current, { ...current.journal, maintenanceRun: {
      ...run, phase: 'ready', isolatedHead: current.snapshot.head, plan: isolated.plan,
    } }, `记录规则产物维护保留集合 ${run.id}`);
    if (current.journal.maintenanceRun?.id !== run.id) throw new Error('MAINTENANCE_CONFLICT: isolation identity changed');
  }
  return report('isolated', { plan: isolated.plan });
}
