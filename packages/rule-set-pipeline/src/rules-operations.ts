import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { candidateStableFiles } from './activation.js';
import type { RuleDefinition } from './configuration.js';
import { guardRulesConfiguration, loadRulesRequest, rulesBinary, type LoadedRules, type RulesRequest } from './rules-context.js';
import { buildPreparedRules, buildRulesInput, resolveRulesInput, publishRuleBuild, recoverPublishedRuleCandidate, verifyRuleCandidate } from './rules-build.js';
import { deleteRuleDelivery, deliverRuleVersion, readRuleDeliveries, recoverRuleDelivery, ruleSubscription, ensureRulePathAvailable, matchesRuleDelivery } from './rules-delivery.js';
import { definitionRevision, inputBindingRevision, type ManagedRule, type RuleCandidate, type RuleResult, type RulesResult, type SuccessfulRuleInput } from './rules-model.js';
import { openRulesSession, type RulesSession } from './rules-session.js';
import { findReusableBuild, reusableInputBaseline, reuseSuccessfulInput, reuseVerifiedInput, unchangedBuiltInput } from './rules-success.js';
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
  const revision = definitionRevision(source, definition);
  const successfulInput = !fresh && previous.definitionRevision === revision ? previous.successfulInput : undefined;
  return { definition, source, inputBindingRevision: binding, definitionRevision: revision,
    configurationRevision: session.loaded.observed.revision, generation: fresh ? randomUUID() : previous.generation,
    lifecycle: 'present', control, ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}),
    ...(successfulInput ? { successfulInput } : {}) };
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

async function unchangedResult(session: RulesSession, rule: ManagedRule, success: SuccessfulRuleInput,
  changes: string[], verification: 'source-identity' | 'normalized-content' | 'native'): Promise<RuleResult> {
  const id = rule.definition.id;
  if (!session.loaded.dryRun) {
    // An authorized concurrent delivery changes the journal even when this
    // run has no facts to write.
    await session.guard();
    const next = { ...rule, successfulInput: success };
    delete next.lastFailure;
    session.journal.rules[id] = next;
    try { await session.save(); }
    catch (error) {
      session.journal.rules[id] = rule;
      throw error;
    }
  }
  return { id, status: 'unchanged', changes,
    verified: [...(verification === 'source-identity' ? [] : ['source']), verification, 'retained-candidate', 'subscription', 'stable-files'],
    ...(verification !== 'native' && { reliedOn: verification === 'source-identity'
      ? ['historical-normalized-content', 'historical-native', 'historical-candidate-publication']
      : ['historical-native', 'historical-candidate-publication'] }) };
}

async function updateSelectedRules(session: RulesSession, definitions: RuleDefinition[], changes: Map<string, string[]>, recoveredDeliveryId?: string) {
  const results: RuleResult[] = [];
  const deliveries = new Map(await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries));
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
    const rulesWithRecoveredCandidates = new Set<string>();
    if (!session.loaded.dryRun) for (const definition of definitions) {
      const rule = ownRule(session, definition.id)!;
      const recovering = Object.values(session.journal.candidates).filter(candidate => ['building', 'publishing'].includes(candidate.status)
        && candidate.logicalId === definition.id && candidate.inputBindingRevision === rule.inputBindingRevision
        && candidate.definitionGeneration === rule.generation && candidate.controlRevision === rule.control.revision
        && definitionRevision(candidate.sourceInput, candidate.definition) === rule.definitionRevision)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (recovering.length) rulesWithRecoveredCandidates.add(definition.id);
      for (const fixed of recovering) {
        try {
          const current = deliveries.get(definition.id);
          const direct = recovering.length === 1 && !current;
          const published = await recoverPublishedRuleCandidate(session, fixed);
          let candidate = published;
          if (!candidate) {
            const built = await buildRulesInput(session.loaded, [fixed.definition], { candidate: fixed, snapshot: session.snapshot });
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
              candidate: { versionId: candidate.versionId, publishedAt: candidate.publishedAt },
              verified: ['candidate-git', 'native', 'subscription', 'stable-git', 'stable-HTTPS', ...(!published ? ['candidate-HTTPS'] : [])],
              ...(published && { reliedOn: ['historical-candidate-publication'] }) });
          } else await session.save(); // Qualified history is durable even if latest input fails.
        } catch (error) {
          results.push(await failure(session, definition.id, new Error(`Candidate ${fixed.id}: ${message(error)}`), changes.get(definition.id)));
          blocked.add(definition.id);
          if (sharedFailure(session, error)) return results;
        }
      }
    }
    const batch = definitions.filter(definition => !completed.has(definition.id) && !blocked.has(definition.id));
    if (!batch.length) continue;
    let source;
    try {
      session.loaded.progress('source-identity', batch.map(rule => rule.id).join(', '));
      source = await resolveRulesInput(session.loaded, batch);
    } catch (error) {
      for (const definition of batch) results.push(await failure(session, definition.id, error, changes.get(definition.id)));
      if (sharedFailure(session, error)) return results;
      continue;
    }
    const batchResults = new Map<string, RuleResult>();
    const orderedResults = () => batch.map(definition => batchResults.get(definition.id))
      .filter((result): result is RuleResult => result !== undefined);
    if (!session.loaded.dryRun) for (const definition of batch) {
      const id = definition.id;
      const rule = ownRule(session, id)!;
      const current = deliveries.get(id);
      const baseline = reusableInputBaseline(rule, current);
      if (!baseline || id === recoveredDeliveryId || rulesWithRecoveredCandidates.has(id)) continue;
      try {
        const unchanged = await source.unchanged?.(baseline.source);
        const success = unchanged && await reuseVerifiedInput(session, rule, current, baseline, unchanged);
        if (success) batchResults.set(id, await unchangedResult(session, rule, success, changes.get(id) ?? [], 'source-identity'));
      } catch (error) {
        batchResults.set(id, await failure(session, id, error, changes.get(id)));
        if (sharedFailure(session, error)) return [...results, ...orderedResults()];
      }
    }
    const bodyNeeded = batch.filter(definition => !batchResults.has(definition.id));
    let body: ReturnType<typeof source.read> | undefined;
    for (const definition of bodyNeeded) {
      const id = definition.id;
      const rule = session.loaded.dryRun ? desiredRule(session, definition) : ownRule(session, id)!;
      const itemChanges = changes.get(id) ?? [];
      const current = deliveries.get(id);
      try {
        const input = await (body ??= source.read(bodyNeeded));
        const reused = !session.loaded.dryRun && await reuseSuccessfulInput(session, rule, current, input);
        if (reused) {
          batchResults.set(id, await unchangedResult(session, rule, reused, itemChanges, 'normalized-content'));
          continue;
        }
        const built = await buildPreparedRules(session.loaded, [definition], input);
        const builtRule = built.results[0];
        if (builtRule.status === 'failed') {
          batchResults.set(id, await failure(session, id, builtRule.error, itemChanges));
          continue;
        }
        const unchanged = await unchangedBuiltInput(session, rule, current, built, builtRule);
        if (unchanged) {
          batchResults.set(id, await unchangedResult(session, rule, unchanged, itemChanges, 'native'));
          continue;
        }
        const deliveryChanges = [...itemChanges, current ? 'replace-current-version' : 'first-delivery'];
        if (session.loaded.dryRun) {
          batchResults.set(id, { id, status: 'planned', changes: deliveryChanges,
            verified: ['source', 'native', 'subscription'], unverified: ['remote-publication', 'HTTPS-readback'] });
          continue;
        }
        const retained = await findReusableBuild(session, rule, built, builtRule);
        const candidate = retained ?? await publishRuleBuild(session, built, builtRule, rule);
        const afterRule = { ...rule }; delete afterRule.lastFailure;
        const delivered = await deliverRuleVersion(session, afterRule, candidate, 'sync', current);
        deliveries.set(id, delivered);
        batchResults.set(id, { id, status: 'delivered', changes: deliveryChanges,
          candidate: { versionId: candidate.versionId, publishedAt: candidate.publishedAt },
          verified: ['source', 'native', 'candidate-git', 'subscription', 'stable-git', 'stable-HTTPS',
            ...(!retained ? ['candidate-HTTPS'] : [])],
          ...(retained && { reliedOn: ['historical-candidate-publication'] }) });
      } catch (error) {
        batchResults.set(id, await failure(session, id, error, itemChanges));
        if (sharedFailure(session, error)) return [...results, ...orderedResults()];
      }
    }
    results.push(...orderedResults());
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
    await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries);
    const recoveredDeliveryId = session.journal.pendingDelivery?.logicalId;
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
    const deliveries = await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries);
    for (const rule of removed) {
      const id = rule.definition.id;
      if (session.loaded.dryRun) { results.push({ id, status: 'planned', changes: ['delete-stable-entry', 'delete-candidates'] }); continue; }
      try { await deleteRuleDelivery(session, rule, deliveries.get(id)); results.push({ id, status: 'deleted', changes: ['delete-stable-entry', 'delete-candidates'] }); }
      catch (error) {
        results.push(await failure(session, id, error));
        if (sharedFailure(session, error)) return operationReport(session, 'sync', results);
      }
    }
    results.push(...await updateSelectedRules(session, definitions, changes, recoveredDeliveryId));
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
    let current = (await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries)).get(request.id);
    let afterRule = desiredRule(session, definition);
    // All candidate and contract checks happen before accepting even the target
    // definition, so an invalid pin is a genuinely read-only failure.
    await ensureRulePathAvailable(session, definition);
    const verified = await verifyRuleCandidate(session, candidate, rulesBinary(session.loaded.context));
    const files = candidateStableFiles(verified, ruleSubscription(session, afterRule, current), definition, session.loaded.context.targetBranch);
    if (request.dryRun) return operationReport(session, 'pin', [{ id: request.id, status: 'planned',
      changes: ['deliver-selected-version', 'stop-automatic-updates'], candidate: { versionId: candidate.versionId, publishedAt: candidate.publishedAt },
      verified: ['candidate-git', 'native', 'subscription'], reliedOn: ['historical-candidate-publication'], unverified: ['stable-commit', 'HTTPS-readback'] }]);
    await guardRulesConfiguration(session.loaded);
    if (session.journal.pendingDelivery && session.journal.pendingDelivery.logicalId !== request.id) throw new Error('RULE_WRITE_PENDING: another rule set has an unresolved delivery');
    await recoverRuleDelivery(session);
    current = (await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries)).get(request.id);
    afterRule = desiredRule(session, definition);
    const existing = ownRule(session, request.id);
    if (existing?.control.mode === 'pinned' && existing.control.candidateId === candidate.id
      && existing.inputBindingRevision === afterRule.inputBindingRevision && existing.definitionRevision === afterRule.definitionRevision
      && current && matchesRuleDelivery(current, candidate, files)) return operationReport(session, 'pin', [{ id: request.id, status: 'pinned', changes: [], verified: ['candidate-git', 'native', 'subscription'],
        reliedOn: ['historical-candidate-publication', 'historical-stable-delivery'] }]);
    afterRule.control = { mode: 'pinned', revision: randomUUID(), inputBindingRevision: afterRule.inputBindingRevision, candidateId: candidate.id };
    delete afterRule.lastFailure;
    await deliverRuleVersion(session, afterRule, candidate, 'pin', current);
    return operationReport(session, 'pin', [{ id: request.id, status: 'pinned', changes: ['deliver-selected-version', 'stop-automatic-updates'],
      verified: ['candidate-git', 'native', 'subscription', 'stable-git', 'stable-HTTPS'], reliedOn: ['historical-candidate-publication'] }]);
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
    await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries);
    const recoveredDeliveryId = session.journal.pendingDelivery?.logicalId;
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
      const current = (await readRuleDeliveries(await session.stable(), session.loaded.readStableDeliveries)).get(request.id);
      ruleSubscription(session, next, current);
      await ensureRulePathAvailable(session, definition);
      const built = await buildRulesInput(session.loaded, [definition]);
      if (built.results[0].status === 'failed') throw new Error(built.results[0].error);
      return operationReport(session, 'resume', [{ id: request.id, status: 'planned', changes: ['restore-automatic-updates', 'check-current-source'],
        verified: ['source', 'native', 'subscription'], unverified: ['remote-publication', 'HTTPS-readback'] }]);
    }
    session.journal.rules[request.id] = next;
    await session.save(); resumed = true;
    const results = await updateSelectedRules(session, [definition], new Map([[request.id, ['automatic-updates-restored']]]), recoveredDeliveryId);
    for (const result of results) if (['delivered', 'unchanged'].includes(result.status)) result.status = 'resumed';
    return operationReport(session, 'resume', results);
  } catch (error) {
    if (!session) return rulesFailure('resume', request, error, loaded);
    return operationReport(session, 'resume', [{ id: request.id, status: session.journal.pendingDelivery || /PENDING/.test(message(error)) ? 'pending' : 'failed',
      changes: resumed ? ['automatic-updates-restored'] : [], error: message(error), continueWith: 'sync' }]);
  }
}
