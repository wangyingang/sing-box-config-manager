import { readFileSync } from 'node:fs';
import type { CompileInput, Obj, Resources, RuleArtifact, RuleSetBinding, ProfileId } from '../src/types.js';
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/legacy/${name}.json`, import.meta.url), 'utf8'));
export const manifest = read('manifest') as { cases: { id: string; profile: ProfileId }[]; artifacts: RuleArtifact[]; configRevision: string; ruleRevision: string };
export function fixture(id = 'user-a-tun'): { input: CompileInput; golden: Obj; fragments: Record<string, Obj> } {
  const { fragments, golden } = read(id) as { fragments: Record<string, Obj>; golden: Obj };
  const profile = manifest.cases.find(c => c.id === id)!.profile;
  const input: CompileInput = {
    template: { id: id.includes('user-d') ? 'independent' : 'common', revision: manifest.configRevision, targetVersion: '1.14.4', defaults: {}, resources: {},
      platformDnsServers: {}, dnsPresets: {}, routePresets: {}, ecsResponseTags: ['ecs'] },
    recipe: { id, revision: manifest.configRevision, resources: {}, dnsSteps: [], routeSteps: [] },
    artifacts: structuredClone(manifest.artifacts), profile, params: { ecs: { address: '8.8.8.8', prefix: 24 } },
  };
  // Explicit migration mapping for the five legacy cases, not a production snippet reader.
  // No deep merge: each singleton field must be equal if repeated; rules use ordered presets.
  for (const [name, fragment] of Object.entries(fragments)) {
    const personal = /^4\.|^9\.|^7\.|^8\./.test(name);
    // Shared business selectors appear after user selectors in the legacy output.
    // Resolve those into the recipe collection instead of inventing array insertion patches.
    const resource: Resources = personal || name.startsWith('6.') ? input.recipe.resources : input.template.resources;
    for (const section of ['log', 'experimental', 'ntp', 'certificate', 'dns', 'route'] as const) {
      const data = fragment[section] as Obj | undefined;
      if (!data) continue;
      const fields = Object.fromEntries(Object.entries(data).filter(([k]) => !['servers', 'rules', 'rule_set'].includes(k)));
      if (Object.keys(fields).length) {
        const defaults = input.template.defaults[section] ??= {};
        for (const [key, value] of Object.entries(fields)) {
          if (key in defaults && JSON.stringify(defaults[key]) !== JSON.stringify(value)) throw new Error('fixture singleton conflict');
          defaults[key] = value;
        }
      }
    }
    for (const [source, dest] of [['inbounds', 'inbounds'], ['outbounds', 'outbounds'], ['http_clients', 'httpClients'], ['services', 'services']] as const) {
      const items = fragment[source] as Obj[] | undefined;
      if (items?.length) (resource[dest] ??= []).push(...items);
    }
    const dns = fragment.dns as Obj | undefined, route = fragment.route as Obj | undefined;
    const servers = dns?.servers as Obj[] | undefined;
    if (name.startsWith('1.dns-lan')) {
      input.template.platformDnsServers[profile] = servers ?? [];
    } else if (servers?.length) (resource.dnsServers ??= []).push(...servers);
    for (const section of ['dns', 'route'] as const) {
      const rules = (fragment[section] as Obj | undefined)?.rules as Obj[] | undefined;
      if (!rules?.length) continue;
      if (personal) input.recipe[`${section}Steps`].push(...rules.map(rule => ({ rule })));
      else {
        input.template[`${section}Presets`][name] = rules;
        input.recipe[`${section}Steps`].push({ preset: name });
      }
    }
    for (const ruleSet of (route?.rule_set ?? []) as Obj[]) {
      let binding: RuleSetBinding;
      if (ruleSet.type === 'inline') binding = { kind: 'inline', definition: ruleSet };
      else binding = { kind: 'curated', artifactId: String(ruleSet.tag), tag: String(ruleSet.tag), ...(ruleSet.http_client ? { httpClient: String(ruleSet.http_client) } : {}) };
      (resource.ruleSets ??= []).push(binding);
    }
  }
  return { input, golden, fragments };
}
