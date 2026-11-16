import { isDeepStrictEqual } from 'node:util';
import { filePaths } from './maintenance-baseline-transport.js';
import { branchRef, type Ref } from './maintenance-refs.js';
import { candidateFiles } from './candidate-publication.js';
import { readRuleDeliveries } from './rules-delivery.js';
import type { CleanupPlan } from './rules-cleanup-model.js';
import type { RulesSession } from './rules-session.js';
import { definitionRevision, RULE_STATE_PATH } from './rules-model.js';

export async function planRulesCleanup(session: RulesSession, refs: Ref[], frozen?: CleanupPlan): Promise<CleanupPlan> {
  const { journal, snapshot, shared, loaded } = session;
  const stable = await session.stable();
  const deliveries = await readRuleDeliveries(stable);
  const candidateRetentionDays = frozen?.candidateRetentionDays ?? loaded.configuration.candidateRetentionDays;
  const observed = frozen?.cleanupObservedAt ?? (loaded.context.now?.() ?? new Date()).toISOString();
  const cutoff = new Date(Date.parse(observed) - candidateRetentionDays * 86_400_000).toISOString();
  const blockers: string[] = [];
  const active: CleanupPlan['retain']['active'] = [];
  const knownStable = new Set<string>();
  for (const record of deliveries.values()) {
    const recordPath = stable.paths.find(path => path.endsWith('/activation.json')
      && Object.keys(record.files).some(file => file.startsWith(path.slice(0, -'activation.json'.length))));
    if (!recordPath) throw new Error('RULE_CLEANUP_PENDING: current delivery has no stable path');
    active.push({ recordPath, record });
    knownStable.add(recordPath);
    Object.keys(record.files).forEach(path => knownStable.add(path));
    const candidate = journal.candidates[record.candidateId];
    if (!candidate || candidate.logicalId !== record.logicalId || candidate.versionId !== record.versionId
      || candidate.publishedAt !== record.publishedAt || !isDeepStrictEqual(candidate.source, record.source)) {
      blockers.push(`Current delivery ${record.logicalId} has no matching retained candidate`);
    }
  }
  for (const path of filePaths(stable.paths).filter(path => path.startsWith('stable/'))) {
    if (!knownStable.has(path)) blockers.push(`Unidentified stable file: ${path}`);
  }
  if (journal.pendingDelivery) blockers.push(`Unresolved delivery ${journal.pendingDelivery.id}; run sync to reconcile it`);
  for (const [id, rule] of Object.entries(journal.rules)) {
    if (rule.lifecycle === 'deleting') blockers.push(`Deletion for ${id} is not yet isolated/completed; run sync`);
  }
  for (const candidate of Object.values(journal.quarantinedCandidates ?? {})) {
    blockers.push(`Quarantined candidate ${candidate.id}: ${candidate.reason}`);
  }
  const candidateIds = new Set([...Object.keys(journal.candidates),
    ...filePaths(snapshot.paths).flatMap(path => /^candidates\/([^/]+)\//.exec(path)?.[1] ?? [])]);
  const decisions: CleanupPlan['decisions'] = [];
  let retainedBytes = 0;
  for (const id of [...candidateIds].sort()) {
    const candidate = journal.candidates[id];
    if (!candidate) {
      blockers.push(`Unindexed candidate files: ${id}`);
      decisions.push({ candidateId: id, action: 'retain', reasons: ['unresolved-ownership'] });
      continue;
    }
    const reasons: string[] = [];
    if ([...deliveries.values()].some(delivery => delivery.candidateId === id)) reasons.push('current-delivery');
    if (Object.values(journal.rules).some(rule => rule.control.mode === 'pinned' && rule.control.candidateId === id)) reasons.push('pin-target');
    const owner = journal.rules[candidate.logicalId];
    // A superseded generation/control can no longer resume this operation. The
    // maintenance CAS fences its old writer before any files are reclaimed.
    const invalidated = candidate.operation === 'sync' && candidate.status !== 'verified' && reasons.length === 0
      && (!owner || owner.lifecycle === 'deleted' || owner.generation !== candidate.definitionGeneration
        || owner.control.revision !== candidate.controlRevision
        || owner.definitionRevision !== definitionRevision(candidate.sourceInput, candidate.definition));
    const complete = candidate.status === 'verified'
      && Boolean(candidate.versionId && candidate.publishedAt && candidate.evidenceUrl) && !candidate.migrationPending;
    if (!complete && !invalidated) {
      reasons.push(candidate.migrationPending || !candidate.publishedAt ? 'publication-time-unresolved' : 'operation-unresolved');
      blockers.push(`Candidate ${id}: ${candidate.migrationPending ?? 'publication or recovery is incomplete'}`);
    } else if (Date.parse(candidate.publishedAt!) >= Date.parse(cutoff)) reasons.push('retention-window');
    const action = reasons.length ? 'retain' : 'discard';
    if (action === 'discard') reasons.push(invalidated ? 'invalidated-operation' : 'expired-unprotected');
    decisions.push({ candidateId: id, logicalId: candidate.logicalId, versionId: candidate.versionId,
      publishedAt: candidate.publishedAt, action, reasons });
    if (action === 'retain') {
      const paths = candidateFiles(candidate.definition).map(file => `candidates/${id}/${file}`);
      for (const path of paths) {
        const bytes = await snapshot.read(path);
        if (!bytes) blockers.push(`Missing retained file: ${path}`);
        else retainedBytes += bytes.length;
      }
    }
  }
  for (const path of knownStable) retainedBytes += (await stable.read(path))!.length;
  const retained = decisions.filter(item => item.action === 'retain').map(item => item.candidateId);
  const discard = decisions.filter(item => item.action === 'discard').map(item => item.candidateId);
  const freshBaseline = journal.lastCleanup && snapshot.parent === journal.lastCleanup.headBeforeReopen
    && (shared || stable.head === journal.lastCleanup.stableHead);
  const hasCleanup = discard.length > 0 || Boolean(await snapshot.read(RULE_STATE_PATH)) && !freshBaseline;
  return { candidateRetentionDays, cleanupObservedAt: observed, cutoff,
    retain: { candidateIds: retained, active: active.sort((a, b) => a.recordPath.localeCompare(b.recordPath)) },
    discard: { candidateIds: discard }, decisions, blockers: [...new Set(blockers)], retainedBytes,
    otherRefs: refs.filter(({ ref }) => ![branchRef(loaded.context.repository.branch), branchRef(loaded.context.targetBranch)].includes(ref)),
    hasCleanup };
}
