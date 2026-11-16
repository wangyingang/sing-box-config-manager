import { candidateStableFiles } from './activation.js';
import { ARTIFACT_REPOSITORY } from './publication.js';
import { loadRulesRequest, type LoadedRules, type RulesRequest } from './rules-context.js';
import { openRulesSession, type RulesSession } from './rules-session.js';
import { readRuleDeliveries, observedRule, ruleSubscription, ensureRulePathAvailable } from './rules-delivery.js';
import { verifyRuleCandidate } from './rules-build.js';
import { definitionRevision, type RuleResult, type RulesResult } from './rules-model.js';

export interface RuleStatus extends RuleResult {
  deliveryState: 'delivered' | 'not-delivered';
  lifecycle?: 'present' | 'deleting' | 'deleted';
  acceptedConfigurationRevision?: string;
  configurationDifference: 'add' | 'change' | 'delete' | 'none';
  stableUrls: string[];
  candidates: { id: string; versionId?: string; publishedAt?: string; source: unknown; current: boolean; selectable: boolean; reason?: string }[];
  candidateCount: number;
  pendingOperation?: string;
}

/** A closed environment gate does not read or migrate the artifact journal. */
export function disabledRulesResult(loaded: LoadedRules, operation: RulesResult['operation']): RulesResult | undefined {
  if (loaded.allowWrites || loaded.dryRun) return;
  const gate = loaded.writeKind === 'cleanup' ? 'RULE_CLEANUP_ENABLED' : 'RULE_UPDATE_ENABLED';
  return { operation, dryRun: false, configurationRevision: loaded.observed.revision,
    configurationOrigin: loaded.observed.origin, target: loaded.configuration.target,
    status: 'disabled', exitCode: 0, results: [], error: `${gate} is disabled; configuration has not been applied (未应用)` };
}

export function rulesReport(session: RulesSession, operation: RulesResult['operation'], results: RuleResult[]): RulesResult {
  const pending = results.some(result => result.status === 'pending') || Boolean(session.journal.pendingDelivery)
    || session.journal.maintenance === 'maintenance'
    || Object.values(session.journal.quarantinedCandidates ?? {}).some(candidate => !candidate.logicalId);
  const failed = results.filter(result => result.status === 'failed' || result.status === 'superseded').length;
  const status = pending ? 'pending' : failed ? (failed === results.length ? 'failed' : 'partial') : 'success';
  return { operation, dryRun: session.loaded.dryRun, configurationRevision: session.loaded.observed.revision,
    configurationOrigin: session.loaded.observed.origin, target: session.loaded.configuration.target, status,
    exitCode: status === 'success' ? 0 : 1, results,
    ...(Object.values(session.journal.quarantinedCandidates ?? {}).some(candidate => !candidate.logicalId)
      ? { error: 'RULE_MIGRATION_PENDING: retained candidate ownership is unresolved' } : {}) };
}

export function rulesFailure(operation: RulesResult['operation'], request: RulesRequest, error: unknown, loaded?: LoadedRules): RulesResult {
  const message = error instanceof Error ? error.message : String(error);
  return { operation, dryRun: Boolean(request.dryRun), configurationRevision: loaded?.observed.revision ?? 'unavailable',
    configurationOrigin: loaded?.observed.origin ?? 'unavailable',
    target: loaded?.configuration.target ?? { repository: ARTIFACT_REPOSITORY, branch: request.context?.targetBranch ?? process.env.RULE_TARGET ?? 'main' },
    status: /PENDING/.test(message) ? 'pending' : 'failed', exitCode: 1, results: [], error: message };
}

export async function addCurrentFacts(session: RulesSession, results: RuleResult[]) {
  const stable = await session.stable();
  const deliveries = await readRuleDeliveries(stable);
  for (const result of results) {
    const actual = await observedRule(session, result.id, stable);
    result.current = deliveries.get(result.id);
    result.control = actual?.control;
    result.expectedSource = session.loaded.configuration.ruleSets.some(rule => rule.id === result.id)
      ? session.loaded.configuration.sources[session.loaded.configuration.ruleSets.find(rule => rule.id === result.id)!.source] : undefined;
  }
  return stable;
}

export async function getRulesStatus(request: RulesRequest & { id?: string } = {}): Promise<RulesResult & { rules?: RuleStatus[]; maintenance?: string; quarantinedCandidates?: RulesSession['journal']['quarantinedCandidates'] }> {
  let loaded: LoadedRules | undefined;
  try {
    if (request.draft !== undefined || request.dryRun) throw new Error('status is read-only and does not accept draft or dry-run');
    loaded = await loadRulesRequest(request);
    const session = await openRulesSession(loaded);
    const stable = await session.stable();
    const deliveries = await readRuleDeliveries(stable);
    const definitions = new Map(session.loaded.configuration.ruleSets.map(rule => [rule.id, rule]));
    const ids = [...new Set([...definitions.keys(), ...Object.entries(session.journal.rules)
      .filter(([, rule]) => rule.lifecycle !== 'deleted').map(([id]) => id), ...deliveries.keys()])];
    if (request.id && !ids.includes(request.id)) throw new Error(`Unknown rule set: ${request.id}`);
    const rules: RuleStatus[] = [];
    for (const id of ids.filter(id => !request.id || id === request.id)) {
      loaded.progress('status', id);
      const definition = definitions.get(id);
      const accepted = await observedRule(session, id, stable);
      const expectedSource = definition && session.loaded.configuration.sources[definition.source];
      const current = deliveries.get(id);
      const candidates: RuleStatus['candidates'] = [];
      for (const candidate of Object.values(session.journal.candidates).filter(candidate => candidate.logicalId === id)) {
        let reason = candidate.error ?? candidate.migrationPending;
        let selectable = candidate.status === 'verified' && Boolean(candidate.versionId) && !candidate.migrationPending;
        if (selectable) {
          try {
            const verified = await verifyRuleCandidate(session, candidate);
            if (accepted && candidate.definitionGeneration !== accepted.generation) throw new Error('Version belongs to a deleted definition generation');
            if (!definition) throw new Error('Rule definition is pending deletion');
            const subscription = ruleSubscription(session, { definition }, current);
            candidateStableFiles(verified, subscription, definition, session.loaded.context.targetBranch);
            await ensureRulePathAvailable(session, definition, stable);
            if (!verified.manifest) throw new Error('Incomplete candidate evidence');
          } catch (error) { selectable = false; reason = String(error); }
        }
        candidates.push({ id: candidate.id, versionId: candidate.versionId, publishedAt: candidate.publishedAt,
          source: candidate.source, current: candidate.id === current?.candidateId, selectable,
          ...(!selectable ? { reason: reason ?? 'Candidate publication is incomplete' } : {}) });
      }
      for (const candidate of Object.values(session.journal.quarantinedCandidates ?? {}).filter(candidate => candidate.logicalId === id)) {
        candidates.push({ id: candidate.id, source: undefined, current: false, selectable: false, reason: candidate.reason });
      }
      candidates.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.id.localeCompare(b.id));
      const configurationDifference = !definition ? 'delete' : !accepted || accepted.lifecycle === 'deleted' ? 'add'
        : definitionRevision(expectedSource!, definition) !== accepted.definitionRevision ? 'change' : 'none';
      rules.push({ id, status: session.journal.pendingDelivery?.logicalId === id ? 'pending' : accepted?.lastFailure ? 'failed' : 'unchanged',
        current, control: accepted?.control, expectedSource, deliveryState: current ? 'delivered' : 'not-delivered',
        lifecycle: accepted?.lifecycle, acceptedConfigurationRevision: accepted?.configurationRevision, configurationDifference,
        stableUrls: Object.keys(current?.files ?? {}).map(path => `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${session.loaded.context.targetBranch}/${path}`),
        candidates, candidateCount: candidates.filter(candidate => candidate.selectable).length,
        error: accepted?.lastFailure, pendingOperation: session.journal.pendingDelivery?.logicalId === id ? session.journal.pendingDelivery.id : undefined });
    }
    const cleanup = session.journal.cleanupRun ?? session.journal.cleanupCheckpoint;
    return { ...rulesReport(session, 'status', rules), rules, maintenance: session.journal.maintenance, quarantinedCandidates: session.journal.quarantinedCandidates,
      ...(cleanup && { cleanup: { phase: 'phase' in cleanup ? cleanup.phase : 'cleanup' as const,
        maintenanceId: cleanup.id, plan: cleanup.plan, continueWith: 'cleanup' as const } }),
      observedHeads: { journal: session.snapshot.head, stable: stable.head } };
  } catch (error) { return rulesFailure('status', request, error, loaded); }
}
