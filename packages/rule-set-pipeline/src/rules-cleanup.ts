import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stageRef } from './maintenance-baseline-transport.js';
import { branchRef, type RefChange } from './maintenance-refs.js';
import { PublicationWriteError } from './publication-repository.js';
import { ARTIFACT_REPOSITORY } from './publication.js';
import { guardRulesConfiguration, loadRulesRequest, rulesBinary, type LoadedRules, type RulesRequest } from './rules-context.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH, type RulesJournal, type RulesResult } from './rules-model.js';
import { openRulesSession, type RulesSession } from './rules-session.js';
import { disabledRulesResult, rulesFailure, rulesReport } from './rules-status.js';
import { planRulesCleanup } from './rules-cleanup-plan.js';
import type { CleanupPlan, CleanupReport, CleanupRun } from './rules-cleanup-model.js';
import { prepareRulesBaseline, verifyRulesBaseline } from './rules-cleanup-baseline.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const markerPath = 'pipeline/baseline.json';

async function guardCleanup(session: RulesSession, stableHead: string) {
  await guardRulesConfiguration(session.loaded);
  const repository = session.loaded.context.repository;
  if ((await repository.snapshot()).head !== session.snapshot.head
    || !session.shared && (await repository.snapshot(session.loaded.context.targetBranch)).head !== stableHead) {
    throw new Error('RULE_CLEANUP_PENDING: remote heads changed; the recorded plan cannot overwrite newer decisions');
  }
}

/** Checkpoint with the same CAS as normal writers, including response-loss reconciliation. */
async function checkpoint(session: RulesSession, journal: RulesJournal, stableHead: string) {
  const repository = session.loaded.context.repository;
  const bytes = encodeRecord({ ...journal, writeId: randomUUID() });
  parseRulesJournal(bytes);
  const guard = () => guardCleanup(session, stableHead);
  await guard();
  try {
    await repository.commit(repository.branch, session.snapshot.head, { [RULE_STATE_PATH]: bytes }, '记录规则历史清理进度', guard);
  } catch (error) {
    if (!(error instanceof PublicationWriteError)) throw error;
    // An unknown outcome is never permission to register a second maintenance.
    const actual = await repository.snapshot().catch(() => undefined);
    if (!(await actual?.read(RULE_STATE_PATH))?.equals(bytes)) {
      throw new Error(`RULE_CLEANUP_PENDING: checkpoint ${error.attemptedCommit} cannot be confirmed`, { cause: error });
    }
  }
  const next = await openRulesSession(session.loaded);
  if (next.snapshot.parent !== session.snapshot.head || !(await next.snapshot.read(RULE_STATE_PATH))?.equals(bytes)) {
    throw new Error('RULE_CLEANUP_PENDING: checkpoint changed after commit');
  }
  return next;
}

function switchChanges(session: RulesSession, run: CleanupRun): RefChange[] {
  const { repository, targetBranch } = session.loaded.context;
  const stages = run.baseline!.stages;
  return [
    { ref: branchRef(repository.branch), before: session.snapshot.head, after: stages.journal.head },
    { ref: branchRef(stageRef(run.id, 'old-journal')), after: session.snapshot.head },
    ...session.shared ? [] : [
      { ref: branchRef(targetBranch), before: run.oldHeads.stable, after: stages.stable.head },
      { ref: branchRef(stageRef(run.id, 'old-stable')), after: run.oldHeads.stable },
    ],
  ];
}

async function switchedRun(session: RulesSession) {
  const bytes = await session.snapshot.read(markerPath);
  const marker = bytes && JSON.parse(bytes.toString());
  if (marker?.schemaVersion !== 2 || marker.generation !== session.journal.generation
    || !/^[a-f0-9-]{36}$/.test(marker.maintenanceId)) throw new Error('RULE_CLEANUP_PENDING: unknown isolated baseline');
  const snapshot = await session.loaded.context.repository.snapshot(stageRef(marker.maintenanceId, 'old-journal'));
  const state = await snapshot.read(RULE_STATE_PATH);
  const journal = state && parseRulesJournal(state);
  const run = journal?.cleanupRun;
  if (!journal || !run || journal.id !== session.journal.id || journal.generation !== session.journal.generation
    || run.id !== marker.maintenanceId || run.phase !== 'prepared' || !run.baseline
    || snapshot.parent !== run.preparedFrom) throw new Error('RULE_CLEANUP_PENDING: old journal cannot establish the switched plan');
  return { run, original: { ...session, snapshot, journal } };
}

/** One public command resumes its remote plan through preparation, switching and retirement. */
export async function cleanupRuleHistory(request: RulesRequest = {}): Promise<RulesResult> {
  let session: RulesSession | undefined;
  let loaded: LoadedRules | undefined;
  let plan: CleanupPlan | undefined;
  let phase: CleanupReport['phase'] = 'preview';
  let maintenanceId: string | undefined;
  const report = (status: RulesResult['status'], error?: string, extra: Partial<CleanupReport> = {}): RulesResult => ({
    ...rulesReport(session!, 'cleanup', []), status, exitCode: status === 'success' ? 0 : 1,
    ...(error && { error }), observedHeads: { journal: session!.snapshot.head, stable: stableHead },
    cleanup: { phase, plan: plan!, ...(maintenanceId && { maintenanceId }),
      ...(status === 'pending' ? { continueWith: 'cleanup' as const } : {}), ...extra },
  });
  let stableHead = '';
  try {
    if (request.draft !== undefined) throw new Error('cleanup uses the current official configuration; draft input is not allowed');
    loaded = await loadRulesRequest(request, 'cleanup');
    const disabled = disabledRulesResult(loaded, 'cleanup');
    if (disabled) return disabled;
    session = await openRulesSession(loaded);
    loaded.progress('cleanup');
    const { repository, cleanup, targetBranch } = session.loaded.context;
    if (!cleanup) throw new Error('Rule cleanup requires trusted baseline and reference transports');
    const refs = cleanup.refs;
    const list = async () => new Map((await refs.list()).map(({ ref, head }) => [ref, head]));
    stableHead = (await session.stable()).head;
    let run = session.journal.cleanupRun;
    let original = session;
    if (session.journal.maintenance === 'maintenance') {
      if (run) { plan = run.plan; maintenanceId = run.id; phase = run.phase; }
      else if (session.journal.cleanupCheckpoint) {
        plan = session.journal.cleanupCheckpoint.plan; maintenanceId = session.journal.cleanupCheckpoint.id; phase = 'cleanup';
      } else {
        ({ run, original } = await switchedRun(session));
        plan = run.plan; maintenanceId = run.id; phase = 'readback';
      }
    } else {
      plan = await planRulesCleanup(session, await refs.list());
      if (plan.blockers.length) { phase = 'blocked'; return report('pending', plan.blockers.join('; ')); }
      if (!plan.hasCleanup) { phase = 'unchanged'; return report('success'); }
    }
    if (session.loaded.dryRun) return report('success', undefined, { phase: 'preview',
      ...(session.journal.maintenance === 'maintenance' ? { continueWith: 'cleanup' as const } : {}),
      unverified: ['retained-candidate-native-validation', 'new-baseline-HTTPS-readback', 'atomic-ref-switch'] });
    await guardCleanup(session, stableHead);
    const binary = rulesBinary(session.loaded.context);
    const nativeBuild = session.loaded.nativeBuild;
    if (session.journal.maintenance === 'open') {
      run = { id: randomUUID(), generation: session.journal.generation + 1,
        oldHeads: { journal: session.snapshot.head, stable: stableHead }, phase: 'isolated', plan };
      session = await checkpoint(session, { ...session.journal, generation: run.generation,
        maintenance: 'maintenance', cleanupRun: run }, stableHead);
      maintenanceId = run.id; phase = 'isolated';
      stableHead = session.shared ? session.snapshot.head : stableHead;
      original = session;
    }
    // Preparation can be retried with the exact same clock boundary and candidate set.
    if (session.journal.cleanupRun) {
      run = session.journal.cleanupRun;
      const currentPlan = await planRulesCleanup(session, await refs.list(), run.plan);
      if (currentPlan.blockers.length || !isDeepStrictEqual(currentPlan.retain, run.plan.retain)
        || !isDeepStrictEqual(currentPlan.discard, run.plan.discard)) {
        phase = 'blocked'; return report('pending', 'Recorded retention plan no longer matches protected state');
      }
      const guard = () => guardCleanup(session!, run!.oldHeads.stable);
      // Every scratch stage checks authority; no stage silently follows changed live heads.
      const transport = { ...cleanup.baseline, async stage(...args: Parameters<typeof cleanup.baseline.stage>) {
        await guard(); const head = await cleanup.baseline.stage(...args); await guard(); return head;
      } };
      const verification = { transport, repository, binary, nativeBuild, targetBranch, plan: run.plan, runId: run.id, journal: session.journal };
      if (run.phase === 'isolated') {
        const baseline = await prepareRulesBaseline({ ...verification, source: session.snapshot,
          stable: await session.stable(), now: new Date(run.plan.cleanupObservedAt) });
        run = { ...run, phase: 'prepared', baseline, preparedFrom: session.snapshot.head };
        session = await checkpoint(session, { ...session.journal, cleanupRun: run }, run.oldHeads.stable);
        phase = 'prepared';
      }
      if (!run.baseline || session.snapshot.parent !== run.preparedFrom) throw new Error('RULE_CLEANUP_PENDING: prepared checkpoint identity differs');
      await verifyRulesBaseline({ ...verification, journal: session.journal }, run.baseline.stages);
      await guardCleanup(session, run.oldHeads.stable);
      original = session;
      const changes = switchChanges(session, run);
      const before = await list();
      if (changes.some(change => before.get(change.ref) !== change.before)) throw new Error('RULE_CLEANUP_PENDING: switch references changed');
      let failure: unknown;
      try { await refs.update(changes); } catch (error) { failure = error; }
      const after = await list();
      if (changes.some(change => after.get(change.ref) !== change.after)) {
        throw new Error(`RULE_CLEANUP_PENDING: switch not confirmed: ${message(failure ?? 'reference conflict')}`);
      }
      session = await openRulesSession(session.loaded);
      stableHead = run.baseline.stages.stable.head;
      phase = 'readback';
    }
    if (!session.journal.cleanupCheckpoint) {
      if (!run?.baseline) throw new Error('RULE_CLEANUP_PENDING: missing switched plan');
      const { stages } = run.baseline;
      const changes = switchChanges(original, run);
      const verifyLive = async () => {
        const heads = await list();
        if (session!.snapshot.head !== stages.journal.head || changes.some(change => heads.get(change.ref) !== change.after)) {
          throw new Error('RULE_CLEANUP_PENDING: switched or recovery references changed');
        }
        await guardCleanup(session!, stages.stable.head);
      };
      await verifyLive();
      await verifyRulesBaseline({ transport: cleanup.baseline, repository, binary, nativeBuild, targetBranch, plan,
        runId: run.id, journal: original.journal }, stages);
      const stable = await session.stable();
      for (const { recordPath, record } of plan.retain.active) {
        for (const path of [recordPath, ...Object.keys(record.files)]) {
          const actual = await repository.download(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${targetBranch}/${path}`);
          if (!(await stable.read(path))?.equals(actual)) throw new Error(`RULE_CLEANUP_PENDING: stable URL readback differs: ${path}`);
        }
      }
      await verifyLive();
      session = await checkpoint(session, { ...session.journal, cleanupCheckpoint: {
        id: run.id, stableHead: stages.stable.head, plan,
        verifiedAt: (session.loaded.context.now?.() ?? new Date()).toISOString(),
        refs: Object.fromEntries([...Object.values(stages).map(stage => [branchRef(stage.ref), stage.head]),
          ...changes.filter(change => !change.before).map(change => [change.ref, change.after!])]),
      } }, stages.stable.head);
    }
    phase = 'cleanup';
    const completed = session.journal.cleanupCheckpoint!;
    const assertLive = async (heads: Map<string, string>) => {
      if (heads.get(branchRef(repository.branch)) !== session!.snapshot.head
        || heads.get(branchRef(targetBranch)) !== (session!.shared ? session!.snapshot.head : completed.stableHead)) {
        throw new Error('RULE_CLEANUP_PENDING: live references changed during scratch cleanup');
      }
      await guardCleanup(session!, completed.stableHead);
    };
    const before = await list(); await assertLive(before);
    const owned = Object.entries(completed.refs).filter(([ref, head]) => before.get(ref) === head)
      .map(([ref, before]) => ({ ref, before }));
    let failure: unknown;
    try { await refs.update(owned); } catch (error) { failure = error; }
    const after = await list(); await assertLive(after);
    if (Object.entries(completed.refs).some(([ref, head]) => after.get(ref) === head)) {
      throw new Error(`RULE_CLEANUP_PENDING: scratch references remain: ${message(failure ?? 'reference conflict')}`);
    }
    const next = { ...session.journal, maintenance: 'open' as const,
      lastCleanup: { id: completed.id, completedAt: (session.loaded.context.now?.() ?? new Date()).toISOString(),
        headBeforeReopen: session.snapshot.head, stableHead: completed.stableHead } };
    delete next.cleanupCheckpoint;
    session = await checkpoint(session, next, completed.stableHead);
    stableHead = session.shared ? session.snapshot.head : completed.stableHead;
    phase = 'completed';
    return report('success', undefined, { removedCandidateCount: plan.discard.candidateIds.length,
      retainedCandidateCount: plan.retain.candidateIds.length,
      otherRefs: [...after].filter(([ref]) => ![branchRef(repository.branch), branchRef(targetBranch)].includes(ref))
        .map(([ref, head]) => ({ ref, head })) });
  } catch (error) {
    if (!session || !plan) return rulesFailure('cleanup', request, error, loaded);
    return report(session.journal.maintenance === 'maintenance' || /PENDING/.test(message(error)) ? 'pending' : 'failed', message(error));
  }
}
