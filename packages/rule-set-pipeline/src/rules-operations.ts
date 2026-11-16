import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { candidateStableFiles } from './activation.js';
import type { RuleDefinition } from './configuration.js';
import { guardRulesConfiguration, loadRulesRequest, rulesBinary, type LoadedRules, type RulesRequest } from './rules-context.js';
import { buildRulesInput, publishRuleBuild, recoverPublishedRuleCandidate, unchangedDelivery, verifyRuleCandidate } from './rules-build.js';
import { deleteRuleDelivery, deliverRuleVersion, readRuleDeliveries, recoverRuleDelivery, ruleSubscription, ensureRulePathAvailable } from './rules-delivery.js';
import { definitionRevision, inputBindingRevision, type ManagedRule, type RuleCandidate, type RuleResult, type RulesResult } from './rules-model.js';
import { openRulesSession, type RulesSession } from './rules-session.js';
import { addCurrentFacts, disabledRulesResult, rulesFailure, rulesReport } from './rules-status.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sharedFailure = (session: RulesSession, error: unknown) => Boolean(session.journal.pendingDelivery)
  || /RULE_(WRITE_|INTENT_|MAINTENANCE)|PUBLICATION_(PENDING|CONFLICT)/.test(message(error));
const ownRule = (session: RulesSession, id: string) => Object.hasOwn(session.journal.rules, id) ? session.journal.rules[id] : undefined;

function desiredRule(session: RulesSession, definition: RuleDefinition): ManagedRule {
  const previous = ownRule(session, definition.id);
  const source = session.loaded.configuration.sources[definition.source];
  const binding = inputBindingRevision(source, definition);
  const fresh = !previous || previous.lifecycle === 'deleted';
  const control = fresh || previous.inputBindingRevision !== binding
    ? { mode: 'auto' as const, revision: randomUUID(), inputBindingRevision: binding } : previous.control;
  return { definition, source, inputBindingRevision: binding, definitionRevision: definitionRevision(source, definition),
    configurationRevision: session.loaded.observed.revision, generation: fresh ? randomUUID() : previous.generation,
    lifecycle: 'present', control, ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}) };
}

function definitionChanges(session: RulesSession, next: ManagedRule) {
  const previous = ownRule(session, next.definition.id);
  if (!previous || previous.lifecycle === 'deleted') return ['add'];
  if (previous.inputBindingRevision !== next.inputBindingRevision) return ['change-source', ...(previous.control.mode === 'pinned' ? ['clear-previous-pin'] : [])];
  if (previous.definitionRevision !== next.definitionRevision) return ['change-subscription'];
  return [];
}

async function failure(session: RulesSession, id: string, error: unknown, changes: string[] = []): Promise<RuleResult> {
  const pending = Boolean(session.journal.pendingDelivery) || /PENDING/.test(message(error));
  if (!session.loaded.dryRun && !sharedFailure(session, error)) {
    const rule = ownRule(session, id);
    if (rule) { rule.lastFailure = message(error); await session.save(); }
  }
  return { id, status: pending ? 'pending' : /SUPERSEDED/.test(message(error)) ? 'superseded' : 'failed', changes,
    error: message(error), continueWith: 'sync' };
}

async function updateSelectedRules(session: RulesSession, definitions: RuleDefinition[], changes: Map<string, string[]>) {
  const results: RuleResult[] = [];
  const deliveries = await readRuleDeliveries(await session.stable());
  const groups = new Map<string, RuleDefinition[]>();
  for (const definition of definitions) {
    const rule = session.loaded.dryRun ? desiredRule(session, definition) : ownRule(session, definition.id)!;
    try {
      ruleSubscription(session, rule, deliveries.get(definition.id));
      await ensureRulePathAvailable(session, definition);
    } catch (error) { results.push(await failure(session, definition.id, error, changes.get(definition.id))); continue; }
    if (rule.control.mode === 'pinned') {
      results.push({ id: definition.id, status: 'pinned-skipped', changes: changes.get(definition.id) });
      continue;
    }
    const sourceKey = JSON.stringify(rule.source);
    const group = groups.get(sourceKey) ?? [];
    group.push(definition); groups.set(sourceKey, group);
  }
  for (const definitions of groups.values()) {
    const completed = new Set<string>();
    const blocked = new Set<string>();
    if (!session.loaded.dryRun) for (const definition of definitions) {
      const rule = ownRule(session, definition.id)!;
      const recovering = Object.values(session.journal.candidates).filter(candidate => ['building', 'publishing'].includes(candidate.status)
        && candidate.logicalId === definition.id && candidate.inputBindingRevision === rule.inputBindingRevision
        && candidate.definitionGeneration === rule.generation && candidate.controlRevision === rule.control.revision
        && definitionRevision(candidate.sourceInput, candidate.definition) === rule.definitionRevision)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const fixed of recovering) {
        try {
          const current = deliveries.get(definition.id);
          const direct = recovering.length === 1 && !current;
          let candidate = await recoverPublishedRuleCandidate(session, fixed);
          if (!candidate) {
            const built = await buildRulesInput(session.loaded, [fixed.definition], fixed);
            const result = built.results[0];
            if (result.status === 'failed') throw new Error(result.error);
            candidate = await publishRuleBuild(session, built, result, rule, fixed);
          }
          // Without a current delivery, one effective candidate has an
          // unambiguous destination. Multiple candidates require normal input
          // selection; their traversal order never selects a version.
          if (direct) {
            const afterRule = { ...rule }; delete afterRule.lastFailure;
            const delivered = await deliverRuleVersion(session, afterRule, candidate, 'sync', current);
            deliveries.set(definition.id, delivered); completed.add(definition.id);
            results.push({ id: definition.id, status: 'delivered', changes: [...(changes.get(definition.id) ?? []), current ? 'replace-current-version' : 'first-delivery'],
              candidate: { versionId: candidate.versionId, publishedAt: candidate.publishedAt } });
          } else await session.save(); // Qualified history is durable even if latest input fails.
        } catch (error) {
          results.push(await failure(session, definition.id, new Error(`Candidate ${fixed.id}: ${message(error)}`), changes.get(definition.id)));
          blocked.add(definition.id);
          if (sharedFailure(session, error)) return results;
        }
      }
    }
    const batch = definitions.filter(definition => !completed.has(definition.id) && !blocked.has(definition.id));
    if (batch.length) {
      let built;
      try { built = await buildRulesInput(session.loaded, batch); }
      catch (error) {
        for (const definition of batch) results.push(await failure(session, definition.id, error, changes.get(definition.id)));
        continue;
      }
      for (const builtRule of built.results) {
        const id = builtRule.id;
        const rule = session.loaded.dryRun ? desiredRule(session, session.loaded.configuration.ruleSets.find(rule => rule.id === id)!) : ownRule(session, id)!;
        const itemChanges = changes.get(id) ?? [];
        if (builtRule.status === 'failed') { results.push(await failure(session, id, builtRule.error, itemChanges)); continue; }
        try {
          const current = deliveries.get(id);
          if (await unchangedDelivery(session, built, builtRule, current, rule)) {
            if (!session.loaded.dryRun) { delete rule.lastFailure; await session.save(); }
            results.push({ id, status: 'unchanged', changes: itemChanges, verified: ['source', 'native', 'subscription'] });
            continue;
          }
          if (session.loaded.dryRun) {
            results.push({ id, status: 'planned', changes: [...itemChanges, current ? 'replace-current-version' : 'first-delivery'],
              verified: ['source', 'native', 'subscription'], unverified: ['remote-publication', 'HTTPS-readback'] });
            continue;
          }
          const reusable = Object.values(session.journal.candidates).find(candidate => candidate.buildId === builtRule.buildId
            && candidate.logicalId === id && candidate.definitionGeneration === rule.generation && candidate.status === 'verified');
          const candidate = reusable ?? await publishRuleBuild(session, built, builtRule, rule);
          const afterRule = { ...rule }; delete afterRule.lastFailure;
          const delivered = await deliverRuleVersion(session, afterRule, candidate, 'sync', current);
          deliveries.set(id, delivered);
          results.push({ id, status: 'delivered', changes: [...itemChanges, current ? 'replace-current-version' : 'first-delivery'],
            candidate: { versionId: candidate.versionId, publishedAt: candidate.publishedAt } });
        } catch (error) {
          results.push(await failure(session, id, error, itemChanges));
          if (sharedFailure(session, error)) return results;
        }
      }
    }
  }
  return results;
}

async function operationReport(session: RulesSession, operation: RulesResult['operation'], results: RuleResult[]) {
  try {
    // A failed CAS may leave proposed control changes only in this session.
    // Report persisted facts, never those uncommitted proposals.
    const observed = await openRulesSession(session.loaded);
    const stable = await addCurrentFacts(observed, results);
    return { ...rulesReport(observed, operation, results), observedHeads: { journal: observed.snapshot.head, stable: stable.head } };
  } catch (error) {
    return { ...rulesReport(session, operation, results), status: 'pending' as const, exitCode: 1 as const,
      error: `Current delivery could not be verified: ${message(error)}` };
  }
}

export async function syncRules(request: RulesRequest = {}): Promise<RulesResult> {
  let session: RulesSession | undefined;
  let loaded: LoadedRules | undefined;
  const results: RuleResult[] = [];
  try {
    loaded = await loadRulesRequest(request);
    const disabled = disabledRulesResult(loaded, 'sync');
    if (disabled) return disabled;
    session = await openRulesSession(loaded);
    // Shared delivery corruption must stop even definition/control checkpoints.
    await readRuleDeliveries(await session.stable());
    if (!session.loaded.dryRun) { await guardRulesConfiguration(session.loaded); await recoverRuleDelivery(session); }
    else if (session.journal.pendingDelivery) {
      return operationReport(session, 'sync', [{ id: session.journal.pendingDelivery.logicalId, status: 'pending',
        error: 'An existing delivery must be reconciled by a real operation; preview is read-only', continueWith: 'sync' }]);
    }
    const definitions = session.loaded.configuration.ruleSets;
    const ids = new Set(definitions.map(rule => rule.id));
    const changes = new Map<string, string[]>();
    for (const definition of definitions) {
      const next = desiredRule(session, definition);
      changes.set(definition.id, definitionChanges(session, next));
      if (!session.loaded.dryRun) session.journal.rules[definition.id] = next;
    }
    const removed = Object.values(session.journal.rules).filter(rule => !ids.has(rule.definition.id) && rule.lifecycle !== 'deleted');
    if (!session.loaded.dryRun) {
      for (const rule of removed) {
        rule.lifecycle = 'deleting';
        rule.configurationRevision = session.loaded.observed.revision;
        if (rule.control.mode !== 'auto') rule.control = { mode: 'auto', revision: randomUUID(), inputBindingRevision: rule.inputBindingRevision };
      }
      await session.save();
    }
    const deliveries = await readRuleDeliveries(await session.stable());
    for (const rule of removed) {
      const id = rule.definition.id;
      if (session.loaded.dryRun) { results.push({ id, status: 'planned', changes: ['delete-stable-entry', 'delete-candidates'] }); continue; }
      try { await deleteRuleDelivery(session, rule, deliveries.get(id)); results.push({ id, status: 'deleted', changes: ['delete-stable-entry', 'delete-candidates'] }); }
      catch (error) {
        results.push(await failure(session, id, error));
        if (sharedFailure(session, error)) return operationReport(session, 'sync', results);
      }
    }
    results.push(...await updateSelectedRules(session, definitions, changes));
    return operationReport(session, 'sync', results);
  } catch (error) {
    if (!session) return rulesFailure('sync', request, error, loaded);
    return { ...await operationReport(session, 'sync', results), status: session.journal.pendingDelivery || /PENDING/.test(message(error)) ? 'pending' : 'failed', exitCode: 1, error: message(error) };
  }
}

function selectedDefinition(session: RulesSession, id: string) {
  const definition = session.loaded.configuration.ruleSets.find(rule => rule.id === id);
  if (!definition) throw new Error(`Rule set is not present in the current official configuration: ${id}`);
  return definition;
}

function selectedVersion(session: RulesSession, id: string, version: string): RuleCandidate {
  const candidate = Object.values(session.journal.candidates).find(candidate => candidate.versionId === version && candidate.logicalId === id);
  if (!candidate || candidate.status !== 'verified' || candidate.migrationPending
    || candidate.definitionGeneration !== ownRule(session, id)?.generation) throw new Error('CANDIDATE_UNAVAILABLE: version is missing, incomplete, cleared or belongs to another rule set');
  return candidate;
}

export async function pinRuleVersion(request: RulesRequest & { id: string; version: string }): Promise<RulesResult> {
  let session: RulesSession | undefined;
  let loaded: LoadedRules | undefined;
  try {
    if (request.draft !== undefined) throw new Error('pin uses the official configuration; drafts are only supported by sync preview');
    loaded = await loadRulesRequest(request);
    const disabled = disabledRulesResult(loaded, 'pin');
    if (disabled) return disabled;
    session = await openRulesSession(loaded);
    const definition = selectedDefinition(session, request.id);
    const candidate = selectedVersion(session, request.id, request.version);
    let current = (await readRuleDeliveries(await session.stable())).get(request.id);
    let afterRule = desiredRule(session, definition);
    // All candidate and contract checks happen before accepting even the target
    // definition, so an invalid pin is a genuinely read-only failure.
    await ensureRulePathAvailable(session, definition);
    const verified = await verifyRuleCandidate(session, candidate, rulesBinary(session.loaded.context));
    candidateStableFiles(verified, ruleSubscription(session, afterRule, current), definition, session.loaded.context.targetBranch);
    if (request.dryRun) return operationReport(session, 'pin', [{ id: request.id, status: 'planned',
      changes: ['deliver-selected-version', 'stop-automatic-updates'], candidate: { versionId: candidate.versionId, publishedAt: candidate.publishedAt },
      verified: ['retained-candidate', 'native', 'subscription'], unverified: ['stable-commit', 'HTTPS-readback'] }]);
    await guardRulesConfiguration(session.loaded);
    if (session.journal.pendingDelivery && session.journal.pendingDelivery.logicalId !== request.id) throw new Error('RULE_WRITE_PENDING: another rule set has an unresolved delivery');
    await recoverRuleDelivery(session);
    current = (await readRuleDeliveries(await session.stable())).get(request.id);
    afterRule = desiredRule(session, definition);
    const existing = ownRule(session, request.id);
    if (existing?.control.mode === 'pinned' && existing.control.candidateId === candidate.id
      && existing.inputBindingRevision === afterRule.inputBindingRevision && existing.definitionRevision === afterRule.definitionRevision
      && current?.candidateId === candidate.id) return operationReport(session, 'pin', [{ id: request.id, status: 'pinned', changes: [] }]);
    afterRule.control = { mode: 'pinned', revision: randomUUID(), inputBindingRevision: afterRule.inputBindingRevision, candidateId: candidate.id };
    delete afterRule.lastFailure;
    await deliverRuleVersion(session, afterRule, candidate, 'pin', current);
    return operationReport(session, 'pin', [{ id: request.id, status: 'pinned', changes: ['deliver-selected-version', 'stop-automatic-updates'] }]);
  } catch (error) {
    if (!session) return rulesFailure('pin', request, error, loaded);
    // Do not persist a failed pin or silently apply another configuration change.
    return operationReport(session, 'pin', [{ id: request.id, status: session.journal.pendingDelivery || /PENDING/.test(message(error)) ? 'pending' : 'failed', error: message(error) }]);
  }
}

export async function resumeRuleUpdates(request: RulesRequest & { id: string }): Promise<RulesResult> {
  let session: RulesSession | undefined;
  let loaded: LoadedRules | undefined;
  let resumed = false;
  try {
    if (request.draft !== undefined) throw new Error('resume uses the official configuration');
    loaded = await loadRulesRequest(request);
    const disabled = disabledRulesResult(loaded, 'resume');
    if (disabled) return disabled;
    session = await openRulesSession(loaded);
    const definition = selectedDefinition(session, request.id);
    await readRuleDeliveries(await session.stable());
    if (!session.loaded.dryRun) {
      await guardRulesConfiguration(session.loaded);
      if (session.journal.pendingDelivery && session.journal.pendingDelivery.logicalId !== request.id) throw new Error('RULE_WRITE_PENDING: another rule set has an unresolved delivery');
      await recoverRuleDelivery(session);
    }
    const next = desiredRule(session, definition);
    if (next.control.mode === 'pinned') next.control = { mode: 'auto', revision: randomUUID(), inputBindingRevision: next.inputBindingRevision };
    if (session.loaded.dryRun) {
      // Preview uses only the latest input and native validation. It does not
      // simulate journal writes or manufacture a published candidate.
      const current = (await readRuleDeliveries(await session.stable())).get(request.id);
      ruleSubscription(session, next, current);
      await ensureRulePathAvailable(session, definition);
      const built = await buildRulesInput(session.loaded, [definition]);
      if (built.results[0].status === 'failed') throw new Error(built.results[0].error);
      return operationReport(session, 'resume', [{ id: request.id, status: 'planned', changes: ['restore-automatic-updates', 'check-current-source'],
        verified: ['source', 'native', 'subscription'], unverified: ['remote-publication', 'HTTPS-readback'] }]);
    }
    session.journal.rules[request.id] = next;
    await session.save(); resumed = true;
    const results = await updateSelectedRules(session, [definition], new Map([[request.id, ['automatic-updates-restored']]]));
    for (const result of results) if (['delivered', 'unchanged'].includes(result.status)) result.status = 'resumed';
    return operationReport(session, 'resume', results);
  } catch (error) {
    if (!session) return rulesFailure('resume', request, error, loaded);
    return operationReport(session, 'resume', [{ id: request.id, status: session.journal.pendingDelivery || /PENDING/.test(message(error)) ? 'pending' : 'failed',
      changes: resumed ? ['automatic-updates-restored'] : [], error: message(error), continueWith: 'sync' }]);
  }
}
