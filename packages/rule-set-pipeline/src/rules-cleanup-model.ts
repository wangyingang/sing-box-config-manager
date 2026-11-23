import { stableRecordLocation } from './stable-rule-paths.js';
import type { PreparedBaseline } from './maintenance-baseline-transport.js';
import type { Ref } from './maintenance-refs.js';
import type { RuleDelivery } from './rules-model.js';
import { validBaseline } from './maintenance-baseline-transport.js';
import { cleanupRefNames } from './maintenance-refs.js';

export interface CleanupPlan {
  candidateRetentionDays: number;
  cleanupObservedAt: string;
  cutoff: string;
  retain: { candidateIds: string[]; active: { recordPath: string; record: RuleDelivery }[] };
  discard: { candidateIds: string[] };
  decisions: { candidateId: string; logicalId?: string; versionId?: string; publishedAt?: string;
    action: 'retain' | 'discard'; reasons: string[] }[];
  blockers: string[];
  retainedBytes: number;
  otherRefs: Ref[];
  deletedHistoryPending?: true;
  hasCleanup: boolean;
}

export interface CleanupRun {
  id: string;
  generation: number;
  oldHeads: { journal: string; stable: string };
  plan: CleanupPlan;
  phase: 'isolated' | 'prepared';
  baseline?: PreparedBaseline;
  /** The parent of the prepared checkpoint, checked before the atomic switch. */
  preparedFrom?: string;
}

export interface CleanupCheckpoint {
  id: string;
  stableHead: string;
  verifiedAt: string;
  refs: Record<string, string>;
  plan: CleanupPlan;
}

export interface LastCleanup {
  id: string;
  completedAt: string;
  headBeforeReopen: string;
  stableHead: string;
}

export interface CleanupReport {
  phase: 'preview' | 'unchanged' | 'isolated' | 'prepared' | 'readback' | 'cleanup' | 'completed' | 'blocked';
  maintenanceId?: string;
  plan: CleanupPlan;
  continueWith?: 'cleanup';
  removedCandidateCount?: number;
  retainedCandidateCount?: number;
  otherRefs?: Ref[];
  unverified?: string[];
}

/** Remote recovery metadata never grants authority over arbitrary refs or a new retention window. */
export function validateCleanupFields(value: Record<string, any>) {
  const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
  const uuid = (x: unknown) => typeof x === 'string' && /^[a-f0-9-]{36}$/.test(x);
  const sha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
  const time = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
  const ids = (x: unknown): x is string[] => Array.isArray(x) && x.every(uuid) && new Set(x).size === x.length;
  const plan = (p: any): p is CleanupPlan => {
    if (!object(p) || !Number.isSafeInteger(p.candidateRetentionDays) || p.candidateRetentionDays <= 0
      || !time(p.cleanupObservedAt) || !time(p.cutoff)
      || Date.parse(p.cleanupObservedAt) - Date.parse(p.cutoff) !== p.candidateRetentionDays * 86_400_000
      || !object(p.retain) || !object(p.discard) || !ids(p.retain.candidateIds) || !ids(p.discard.candidateIds)
      || p.retain.candidateIds.some((id: string) => p.discard.candidateIds.includes(id))
      || !Array.isArray(p.retain.active) || !Array.isArray(p.decisions) || !Array.isArray(p.blockers)
      || p.deletedHistoryPending !== value.deletedHistoryPending
      || p.blockers.length || !Number.isSafeInteger(p.retainedBytes) || p.retainedBytes < 0 || p.hasCleanup !== true
      || !Array.isArray(p.otherRefs) || !p.otherRefs.every((r: any) => object(r) && typeof r.ref === 'string' && sha(r.head))) return false;
    if (!p.retain.active.every((a: any) => object(a) && typeof a.recordPath === 'string'
      && (/^stable\/(?:[a-z0-9][a-z0-9._-]*\/)+activation\.json$/.test(a.recordPath)
        || stableRecordLocation(a.recordPath)?.artifact !== undefined)
      && object(a.record) && a.record.schemaVersion === 2 && p.retain.candidateIds.includes(a.record.candidateId))) return false;
    const all = [...p.retain.candidateIds, ...p.discard.candidateIds];
    return p.decisions.length === all.length && new Set(p.decisions.map((d: any) => d.candidateId)).size === all.length
      && p.decisions.every((d: any) => object(d) && all.includes(d.candidateId)
        && d.action === (p.retain.candidateIds.includes(d.candidateId) ? 'retain' : 'discard')
        && Array.isArray(d.reasons) && d.reasons.every((reason: any) => typeof reason === 'string'));
  };
  const fail = () => { throw new Error('RULE_STATE_CORRUPT: cleanup recovery metadata'); };
  if (value.deletedHistoryPending !== undefined && value.deletedHistoryPending !== true) fail();
  const run = value.cleanupRun;
  if (run !== undefined) {
    if (!object(run) || value.maintenance !== 'maintenance' || !uuid(run.id) || run.generation !== value.generation
      || !object(run.oldHeads) || !sha(run.oldHeads.journal) || !sha(run.oldHeads.stable) || !plan(run.plan)
      || !['isolated', 'prepared'].includes(run.phase) || value.cleanupCheckpoint || value.pendingDelivery) fail();
    if (run.phase === 'prepared' && (!sha(run.preparedFrom)
      || !validBaseline(run.baseline, run.id, value.targetBranch !== 'main'))) fail();
    if (run.phase === 'isolated' && (run.baseline !== undefined || run.preparedFrom !== undefined)) fail();
  }
  const checkpoint = value.cleanupCheckpoint;
  if (checkpoint !== undefined) {
    if (!object(checkpoint) || value.maintenance !== 'maintenance' || !uuid(checkpoint.id)
      || !sha(checkpoint.stableHead) || !time(checkpoint.verifiedAt) || !plan(checkpoint.plan)
      || !object(checkpoint.refs) || value.pendingDelivery) fail();
    const allowed = cleanupRefNames(checkpoint.id, value.targetBranch !== 'main');
    if (Object.keys(checkpoint.refs).length !== allowed.length
      || Object.entries(checkpoint.refs).some(([ref, head]) => !allowed.includes(ref) || !sha(head))) fail();
  }
  const last = value.lastCleanup;
  if (last !== undefined && (!object(last) || !uuid(last.id) || !time(last.completedAt)
    || !sha(last.headBeforeReopen) || !sha(last.stableHead))) fail();
}
