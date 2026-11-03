import type { RuleSubscription } from './recipe-schema.js';
import type { Capability, Diagnostic, Obj } from './types.js';

type Usage = keyof RuleSubscription['projections'];

/** Shared files must have consistent declarations across all selected contracts. */
export function validateSubscriptionEndpoints(subscriptions: RuleSubscription[], path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const endpoints = new Map<string, string>();
  for (const subscription of subscriptions) {
    for (const projection of Object.values(subscription.projections)) {
      if (!('formats' in projection)) continue;
      for (const [format, endpoint] of Object.entries(projection.formats)) {
        const signature = JSON.stringify([format, [...endpoint.requiredCapabilities].sort()]);
        if (endpoints.has(endpoint.url) && endpoints.get(endpoint.url) !== signature) {
          diagnostics.push({ severity: 'error', code: 'SUBSCRIPTION_ENDPOINT_CONFLICT', path,
            message: '同一稳定 URL 的格式及能力声明必须一致，包括跨规则订阅复用的入口' });
        }
        endpoints.set(endpoint.url, signature);
      }
    }
  }
  return diagnostics;
}

/** One local tag can name several purposes only when they share the same SRS. */
export function resolveSubscriptionProjection(subscription: RuleSubscription, usages: Usage[], path: string) {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
  const requiredCapabilities = new Set<Capability>();
  let url: string | undefined;
  if (!Array.isArray(usages) || !usages.length || new Set(usages).size !== usages.length) {
    error('INPUT_INVALID', '订阅用途必须非空且不能重复');
    return { diagnostics, url, requiredCapabilities: [] };
  }
  for (const usage of usages) {
    const projection = Object.hasOwn(subscription.projections, usage) ? subscription.projections[usage] : undefined;
    if (!projection) { error('DEPENDENCY_MISSING', '规则订阅用途不存在'); continue; }
    if ('unavailable' in projection) { error('ARTIFACT_PROJECTION_EMPTY', '所选用途没有内容，不能绑定规则订阅'); continue; }
    const endpoint = projection.formats.binary;
    if (url !== undefined && url !== endpoint.url) error('SUBSCRIPTION_ENDPOINT_MISMATCH', '同一本地 tag 的多个用途必须复用同一稳定 SRS 入口');
    url = endpoint.url;
    endpoint.requiredCapabilities.forEach(c => requiredCapabilities.add(c));
  }
  return { diagnostics, url, requiredCapabilities: [...requiredCapabilities] };
}

/** Validate every actual consumer after preset expansion, including logical children. */
export function validateRuleSetUsages(rules: { dns: Obj[]; route: Obj[] }, usages: Map<string, Usage[]>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const responses = new Set<string>();
  let untaggedResponse = false;
  for (const section of ['dns', 'route'] as const) {
    rules[section].forEach((rule, index) => {
      const walk = (match: Obj, path: string) => {
        const tags = typeof match.rule_set === 'string' ? [match.rule_set] : (match.rule_set as string[] | undefined) ?? [];
        for (const tag of tags) {
          const allowed = usages.get(tag);
          if (!allowed) continue; // Inline and missing tags retain existing resource validation.
          const response = match.match_response;
          const context = response === true ? untaggedResponse : typeof response === 'string' && responses.has(response);
          const compatible = section === 'route' ? allowed.includes('route')
            : response !== undefined && response !== false
              ? allowed.includes('dns-response') && context && match.rule_set_ip_cidr_match_source !== true
              : allowed.includes('dns-query');
          if (!compatible) diagnostics.push({ severity: 'error', code: 'ARTIFACT_USAGE_MISMATCH', path: `${path}/rule_set`,
            message: '规则集用途与消费位置不符；DNS 响应用途要求此前已 evaluate 的响应上下文' });
        }
        if (match.type === 'logical') (match.rules as Obj[]).forEach((child, i) => walk(child, `${path}/rules/${i}`));
      };
      walk(rule, `/${section}/rules/${index}`);
      if (section === 'dns' && rule.action === 'evaluate') {
        if (typeof rule.tag === 'string') responses.add(rule.tag);
        else untaggedResponse = true;
      }
    });
  }
  return diagnostics;
}
