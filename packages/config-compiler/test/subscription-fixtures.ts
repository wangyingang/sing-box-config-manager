import contract from '../../rule-set-pipeline/contracts/rule-subscription-v2.example.json' with { type: 'json' };
import { input } from './recipe-fixtures.js';
import type { RecipeCompileInput, RuleSubscription } from '../src/index.js';

// Controlled metadata only; these URLs are not evidence of a deployed stable subscription.
export function subscriptionInput(): RecipeCompileInput {
  const original = input();
  const subscription: RuleSubscription = structuredClone(contract) as RuleSubscription;
  return {
    ...original,
    recipe: { ...original.recipe, schemaVersion: 2, resources: {
      ...original.recipe.resources,
      httpClients: [{ tag: 'download', detour: 'direct', domain_resolver: 'local' }],
      ruleSets: [
        { kind: 'subscription', tag: 'routing', subscriptionRef: { systemRuleSetId: subscription.systemRuleSetId, usage: 'route' }, httpClient: 'download' },
        { kind: 'subscription', tag: 'queries', subscriptionRef: { systemRuleSetId: subscription.systemRuleSetId, usage: 'dns-query' } },
      ],
    }, routeSteps: [{ id: 'route', rule: { rule_set: 'routing', outbound: 'direct' } }],
    dnsSteps: [{ id: 'query', rule: { rule_set: 'queries', server: 'local' } }] },
    dependencies: { ...original.dependencies, templates: original.dependencies.templates.map(t => ({ ...t, schemaVersion: 2, resources: { ...t.resources, ruleSets: [] } })), subscriptions: [subscription] },
  };
}

export function subscriptionResponseInput(): RecipeCompileInput {
  const request = subscriptionInput();
  if (request.recipe.schemaVersion !== 2) throw new Error('Subscription fixture must be v2');
  const subscription = request.dependencies.subscriptions![0]!;
  subscription.projections['dns-response'] = { formats: { binary: { url: 'https://rules.example.invalid/stable/ips.srs', requiredCapabilities: [] } } };
  request.recipe.resources.ruleSets!.push({ kind: 'subscription', tag: 'answers', subscriptionRef: { systemRuleSetId: subscription.systemRuleSetId, usage: 'dns-response' } });
  request.recipe.dnsSteps.push(
    { id: 'evaluate', rule: { action: 'evaluate', server: 'local', tag: 'first' } },
    { id: 'response', rule: { type: 'logical', mode: 'and', rules: [{ match_response: 'first', rule_set: 'answers' }, { query_type: 'A' }], action: 'reject' } },
    { id: 'return-response', rule: { match_response: 'first', action: 'respond' } },
  );
  return request;
}
