import { resolveSubscriptionProjection, validateRuleSetUsages } from './rule-subscriptions.js';
import { ruleSubscriptionSchema } from './recipe-schema.js';
import build from '../schemas/build.json' with { type: 'json' };
import { applyEcs } from './ecs.js';
import { isJson, object, objects } from './json.js';
import { CAPABILITY_VERSION, PROFILES } from './profiles.js';
import { validateConfig } from './validate.js';
import type { CompileInput, CompiledConfig, Diagnostic, Obj, Resources, Result, RuleArtifact, Step } from './types.js';

export const COMPILER_VERSION = 'd06-1';

export interface CompositionInspection { candidate?: CompiledConfig; diagnostics: Diagnostic[] }

/** Only valid, platform-compatible configurations are returned as successful compilation. */
export function compile(input: CompileInput): Result<CompiledConfig> {
  const inspection = inspectComposition(input);
  return inspection.candidate && !inspection.diagnostics.some(d => d.severity === 'error')
    ? { ok: true, value: inspection.candidate, diagnostics: inspection.diagnostics }
    : { ok: false, diagnostics: inspection.diagnostics };
}

/** Preview/legacy audit only. A candidate with errors MUST NOT be published or downloaded. */
export function inspectComposition(input: CompileInput): CompositionInspection {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
  const fail = (): CompositionInspection => ({ diagnostics });
  const keys = (o: unknown, allowed: string[], path: string) => {
    if (!object(o)) throw new Error('object required');
    for (const key of Object.keys(o)) if (!allowed.includes(key)) error('INPUT_UNKNOWN', `${path}/${key}`, '该输入字段不属于 D06 组合契约');
  };
  try {
    if (!isJson(input)) throw new Error('input must be parsed JSON');
    // Own all mutable output. Never modify the caller's template, recipe or manifest.
    const { template, recipe, artifacts, profile, params } = structuredClone(input);
    keys(input, ['template', 'recipe', 'artifacts', 'profile', 'params', 'subscriptions'], '');
    keys(template, ['id', 'revision', 'targetVersion', 'defaults', 'resources', 'platformDnsServers', 'dnsPresets', 'routePresets', 'ecsResponseTags'], '/template');
    keys(recipe, ['id', 'revision', 'resources', 'settings', 'dnsSteps', 'routeSteps'], '/recipe');
    if (template.targetVersion !== '1.14.4') error('VERSION_UNSUPPORTED', '/template/targetVersion', '首期仅支持 1.14.4');
    if (!Object.hasOwn(PROFILES, profile)) error('PROFILE_UNKNOWN', '/profile', '未知 Client Profile');
    for (const [path, item] of [['template', template], ['recipe', recipe]] as const) {
      if (![item.id, item.revision].every(v => typeof v === 'string' && v.length > 0)) error('VERSION_REQUIRED', `/${path}`, '必须声明 id 和 revision');
    }
    keys(template.defaults, ['log', 'dns', 'route', 'experimental', 'ntp', 'certificate'], '/template/defaults');
    for (const [name, defaults] of Object.entries(template.defaults)) {
      if (!object(defaults)) throw new Error('defaults must be objects');
      for (const forbidden of name === 'dns' ? ['rules', 'servers'] : name === 'route' ? ['rules', 'rule_set'] : []) {
        if (forbidden in defaults) error('DEFAULTS_COLLECTION', `/template/defaults/${name}/${forbidden}`, '对象集合与规则必须通过专用输入生成');
      }
    }
    keys(template.platformDnsServers, Object.keys(PROFILES), '/template/platformDnsServers');
    if (!Array.isArray(template.ecsResponseTags) || !template.ecsResponseTags.every(t => typeof t === 'string' && t)) throw new Error('invalid ECS declarations');
    const config: Obj = { ...template.defaults };
    const dns: Obj = { ...(template.defaults.dns ?? {}) };
    const route: Obj = { ...(template.defaults.route ?? {}) };
    config.dns = dns; config.route = route;
    const resources: Resources[] = [template.resources, recipe.resources];
    const resourceKeys = ['inbounds', 'outbounds', 'dnsServers', 'httpClients', 'ruleSets', 'services'];
    for (const [index, resource] of resources.entries()) {
      keys(resource, resourceKeys, `/resources/${index}`);
      for (const entries of Object.values(resource)) if (!Array.isArray(entries) || !entries.every(object)) throw new Error('invalid resources');
    }
    for (const [source, target] of [['inbounds', 'inbounds'], ['outbounds', 'outbounds'], ['httpClients', 'http_clients'], ['services', 'services']] as const) {
      const items = resources.flatMap(r => r[source] ?? []);
      if (items.length) config[target] = items;
    }
    const platformServers = template.platformDnsServers[profile] ?? [];
    if (!Array.isArray(platformServers) || !platformServers.every(object)) throw new Error('invalid platform servers');
    dns.servers = [...(template.resources.dnsServers ?? []), ...platformServers, ...(recipe.resources.dnsServers ?? [])];
    const artifactMap = new Map<string, RuleArtifact>();
    for (const artifact of artifacts) {
      keys(artifact, ['id', 'revision', 'sha256', 'url', 'format', 'requiredCapabilities'], '/artifacts');
      if (!artifact.id || !artifact.revision || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !['source', 'binary'].includes(artifact.format) || !Array.isArray(artifact.requiredCapabilities) ||
        !artifact.requiredCapabilities.every(c => ['processMatching', 'packageMatching', 'dhcpDns'].includes(c)) ||
        !artifact.url.startsWith('https://')) error('ARTIFACT_INVALID', '/artifacts', '规则产物缺少有效的版本、摘要、HTTPS URL 或能力声明');
      if (artifactMap.has(artifact.id)) error('ARTIFACT_DUPLICATE', '/artifacts', '规则产物 id 重复');
      artifactMap.set(artifact.id, artifact);
    }
    const subscriptions = (input.subscriptions ?? []).map((s, i) => ruleSubscriptionSchema.parse(s, `/subscriptions/${i}`));
    const subscriptionMap = new Map(subscriptions.map(s => [s.systemRuleSetId, s]));
    if (subscriptionMap.size !== subscriptions.length) error('DEPENDENCY_DUPLICATE', '/subscriptions', '系统规则订阅身份重复');
    const selectedSubscriptions = new Map<string, typeof subscriptions[number]>();
    const subscriptionCapabilities: Pick<RuleArtifact, 'requiredCapabilities'>[] = [];
    const subscriptionUsages = new Map<string, ('route' | 'dns-query' | 'dns-response')[]>();
    const selected = new Map<string, RuleArtifact>();
    route.rule_set = resources.flatMap(r => r.ruleSets ?? []).map(binding => {
      if (binding.kind === 'inline') {
        keys(binding, ['kind', 'definition'], '/resources/ruleSets');
        if (!object(binding.definition) || binding.definition.type !== 'inline') error('RULE_SET_INLINE_REQUIRED', '/resources/ruleSets', '用户只能提供 Inline Rule Set');
        return binding.definition;
      }
      if (binding.kind === 'subscription') {
        keys(binding, ['kind', 'systemRuleSetId', 'usages', 'tag', 'httpClient'], '/resources/ruleSets');
        const subscription = subscriptionMap.get(binding.systemRuleSetId);
        if (!subscription) { error('DEPENDENCY_MISSING', '/resources/ruleSets', '规则订阅不存在'); return {}; }
        const projection = resolveSubscriptionProjection(subscription, binding.usages, '/resources/ruleSets');
        diagnostics.push(...projection.diagnostics);
        subscriptionCapabilities.push(projection);
        subscriptionUsages.set(binding.tag, binding.usages);
        selectedSubscriptions.set(subscription.systemRuleSetId, subscription);
        return { type: 'remote', tag: binding.tag, format: 'binary', url: projection.url ?? '', ...(binding.httpClient ? { http_client: binding.httpClient } : {}) };
      }
      keys(binding, ['kind', 'artifactId', 'tag', 'httpClient'], '/resources/ruleSets');
      if (binding.kind !== 'curated') throw new Error('invalid rule set binding');
      const artifact = artifactMap.get(binding.artifactId);
      if (!artifact) { error('ARTIFACT_MISSING', '/resources/ruleSets', '选定的系统规则产物不存在'); return {}; }
      selected.set(artifact.id, artifact);
      return { type: 'remote', tag: binding.tag, format: artifact.format, url: artifact.url, ...(binding.httpClient ? { http_client: binding.httpClient } : {}) };
    });
    const expand = (steps: Step[], presets: Record<string, Obj[]>, path: string): Obj[] => {
      if (!Array.isArray(steps) || !object(presets)) throw new Error('invalid policy');
      return steps.flatMap((step, i) => {
        keys(step, ['preset', 'rule'], `${path}/${i}`);
        if (('preset' in step) === ('rule' in step)) throw new Error('step requires exactly one form');
        if ('rule' in step) { if (!object(step.rule)) throw new Error('rule must be object'); return [step.rule]; }
        if (!Object.hasOwn(presets, step.preset)) { error('PRESET_MISSING', `${path}/${i}`, '预设不存在'); return []; }
        if (!Array.isArray(presets[step.preset]) || !presets[step.preset].every(object)) throw new Error('preset must contain rules');
        // Clone each use independently, including repeated preset expansions.
        return structuredClone(presets[step.preset]);
      });
    };
    dns.rules = expand(recipe.dnsSteps, template.dnsPresets, '/recipe/dnsSteps');
    route.rules = expand(recipe.routeSteps, template.routePresets, '/recipe/routeSteps');
    diagnostics.push(...validateRuleSetUsages({ dns: dns.rules as Obj[], route: route.rules as Obj[] }, subscriptionUsages));
    if (recipe.settings === null) throw new Error('null is not settings');
    const settings = recipe.settings ?? {};
    keys(settings, ['logLevel', 'tunMtu', 'dnsFinal', 'routeFinal'], '/recipe/settings');
    if (settings.logLevel !== undefined) config.log = { ...(template.defaults.log ?? {}), level: settings.logLevel };
    if (settings.dnsFinal !== undefined) dns.final = settings.dnsFinal;
    if (settings.routeFinal !== undefined) route.final = settings.routeFinal;
    if (settings.tunMtu !== undefined) {
      if (!Number.isInteger(settings.tunMtu) || settings.tunMtu < 576 || settings.tunMtu > 65535) error('SETTING_INVALID', '/recipe/settings/tunMtu', 'MTU 必须是 576–65535 的整数');
      const tun = objects(config.inbounds).filter(i => i.type === 'tun');
      if (tun.length !== 1) error('SETTING_AMBIGUOUS', '/recipe/settings/tunMtu', 'MTU 设置要求唯一 TUN 入站');
      else tun[0].mtu = settings.tunMtu;
    }
    if (diagnostics.some(d => d.severity === 'error')) return fail();
    diagnostics.push(...applyEcs(config, template.ecsResponseTags, params));
    if (diagnostics.some(d => d.severity === 'error')) return fail();
    const usedArtifacts = [...selected.values()];
    diagnostics.push(...validateConfig(config, profile, [...usedArtifacts, ...subscriptionCapabilities]));
    return { diagnostics, candidate: {
      config, profile, ecsResponseTags: template.ecsResponseTags, artifacts: usedArtifacts,
      ...(input.subscriptions ? { subscriptions: [...selectedSubscriptions.values()] } : {}),
      versions: { target: '1.14.4', compiler: COMPILER_VERSION, capabilities: CAPABILITY_VERSION,
        template: `${template.id}@${template.revision}`, recipe: `${recipe.id}@${recipe.revision}`, schema: build.schemaSha256 },
    } };
  } catch {
    error('INPUT_INVALID', '', '输入不符合已解析 Recipe 契约；不支持任意 JSON 覆盖');
    return fail();
  }
}
