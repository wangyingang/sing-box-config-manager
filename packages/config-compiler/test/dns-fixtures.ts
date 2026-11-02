import type { Obj, RecipeCompileInput } from '../src/index.js';
import { fixture } from './fixtures.js';
import { input } from './recipe-fixtures.js';

/** Existing sample DNS policy; external rule contents use explicit synthetic inline dependencies.
 * This tests DNS orchestration, not the later curated-artifact or full sample migration slices. */
export function sampleDnsInput(): { request: RecipeCompileInput; expectedRules: Obj[] } {
  const legacy = fixture().input;
  const request: RecipeCompileInput = input();
  const template = request.dependencies.templates[0]!;
  template.defaults.dns = structuredClone(legacy.template.defaults.dns);
  template.defaults.route = { final: 'direct', default_domain_resolver: 'dns_local' };
  template.resources.dnsServers = structuredClone(legacy.template.resources.dnsServers) as any;
  template.resources.outbounds!.push({ type: 'selector', tag: '代理', outbounds: ['direct'] });
  template.resources.httpClients = structuredClone(legacy.template.resources.httpClients) as any;
  template.platformDnsServers = {
    'macos-standalone': [{ type: 'local', tag: 'local' }, { type: 'dhcp', tag: 'dns_lan' }],
    'android-google-play': [{ type: 'local', tag: 'local' }, { type: 'local', tag: 'dns_lan' }],
  };
  template.ecsResponseTags = ['ecs'];
  const expectedRules: Obj[] = [];
  template.dnsPresets = {};
  request.recipe.dnsSteps = legacy.recipe.dnsSteps.map((step, i) => {
    const rules = structuredClone('preset' in step ? legacy.template.dnsPresets[step.preset]! : [step.rule]);
    // Request-time addresses are not persisted in the structured Template/Recipe.
    for (const rule of rules) delete rule.client_subnet;
    expectedRules.push(...structuredClone(rules));
    if ('preset' in step) {
      template.dnsPresets![step.preset] = rules as any;
      return { id: `dns-${i}`, preset: step.preset };
    }
    return { id: `dns-${i}`, rule: rules[0] as any };
  });
  const tags = [...new Set(expectedRules.flatMap(rule => typeof rule.rule_set === 'string' ? [rule.rule_set] : rule.rule_set as string[] ?? []))];
  request.recipe.resources.ruleSets = tags.map(tag => ({ kind: 'inline', definition: {
    type: 'inline', tag, rules: tag === 'ChinaIPs' || tag.endsWith('_ipcidr') ? [{ ip_cidr: '192.0.2.0/24' }] : [{ domain_suffix: 'example.test' }],
  } }));
  request.params.ecs = { address: '8.8.8.8', prefix: 24 };
  return { request, expectedRules };
}
