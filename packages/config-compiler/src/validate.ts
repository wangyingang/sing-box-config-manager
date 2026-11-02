import schemaValidate from './generated/validate.cjs';
import { object, objects, strings } from './json.js';
import { PROFILES } from './profiles.js';
import type { Diagnostic, Json, Obj, ProfileId, RuleArtifact } from './types.js';

export function validateConfig(config: Obj, profile: ProfileId, artifacts: RuleArtifact[] = []): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
  if (!Object.hasOwn(PROFILES, profile)) {
    error('PROFILE_UNKNOWN', '/profile', '未知 Client Profile'); return diagnostics;
  }
  if (!schemaValidate(config)) {
    // No input values in diagnostics: configurations contain credentials.
    for (const e of (schemaValidate.errors ?? []).slice(0, 32)) {
      error('SCHEMA_INVALID', e.instancePath, `${e.keyword}: ${e.message ?? '结构不合法'}`);
    }
    return diagnostics;
  }
  const dns = object(config.dns) ? config.dns : {};
  const route = object(config.route) ? config.route : {};
  const groups: Record<string, Obj[]> = {
    outbound: objects(config.outbounds), inbound: objects(config.inbounds), dns: objects(dns.servers),
    ruleSet: objects(route.rule_set), httpClient: objects(config.http_clients), service: objects(config.services),
  };
  const sets: Record<string, Set<string>> = {};
  for (const [group, entries] of Object.entries(groups)) {
    sets[group] = new Set();
    entries.forEach((entry, i) => {
      const path = `/${group}/${i}/tag`;
      if (typeof entry.tag !== 'string' || !entry.tag) error('TAG_REQUIRED', path, '对象必须有非空 tag');
      else if (sets[group].has(entry.tag)) error('TAG_DUPLICATE', path, '同一命名空间有重复 tag');
      else sets[group].add(entry.tag);
    });
  }
  function ref(group: string, value: Json | undefined, path: string) {
    for (const name of strings(value)) {
      if (!sets[group].has(name)) error('REFERENCE_MISSING', path, `引用的 ${group} 对象不存在`);
    }
  }
  ref('dns', dns.final, '/dns/final');
  ref('outbound', route.final, '/route/final');
  const caps = PROFILES[profile];
  function walk(value: Json, path: string, visitor: (o: Obj, path: string) => void) {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}/${i}`, visitor));
    else if (object(value)) {
      visitor(value, path);
      for (const [key, item] of Object.entries(value)) walk(item, `${path}/${key}`, visitor);
    }
  }
  walk(config, '', (o, path) => {
    for (const key of ['certificate_path', 'key_path', 'private_key_path', 'config_path']) {
      if (typeof o[key] === 'string' && o[key]) error('RESOURCE_PATH_UNSUPPORTED', `${path}/${key}`, '配置必须自包含；本地证书或密钥请通过受控导入转换为内联内容');
    }
    for (const key of ['detour', 'outbound']) ref('outbound', o[key], `${path}/${key}`);
    for (const key of ['http_client', 'default_http_client']) ref('httpClient', o[key], `${path}/${key}`);
    for (const key of ['domain_resolver', 'default_domain_resolver']) {
      const resolver = o[key];
      ref('dns', object(resolver) ? resolver.server : resolver, `${path}/${key}`);
    }
    if (o.rule_set !== undefined && !objects(o.rule_set).length) ref('ruleSet', o.rule_set, `${path}/rule_set`);
    ref('inbound', o.inbound, `${path}/inbound`);
    ref('dns', o.preferred_by, `${path}/preferred_by`);
    for (const key of ['process_name', 'process_path', 'process_path_regex']) {
      if (key in o && !caps.processMatching) error('CAPABILITY_UNSUPPORTED', `${path}/${key}`, '此 Profile 不支持进程匹配');
    }
    for (const key of ['package_name', 'package_name_regex']) {
      if (key in o && !caps.packageMatching) error('CAPABILITY_UNSUPPORTED', `${path}/${key}`, '此 Profile 不支持 Android 应用匹配');
    }
  });
  groups.dns.forEach((server, i) => {
    if (server.type === 'dhcp' && !caps.dhcpDns) error('CAPABILITY_UNSUPPORTED', `/dns/servers/${i}`, '此 Profile 不支持 DHCP DNS');
  });
  for (const artifact of artifacts) {
    for (const capability of artifact.requiredCapabilities) {
      if (!caps[capability]) error('CAPABILITY_UNSUPPORTED', '/artifacts', '所选规则产物需要此 Profile 不支持的能力');
    }
  }
  const graph = new Map<string, string[]>();
  groups.outbound.forEach((outbound, i) => {
    const members = strings(outbound.outbounds);
    const edges = [...members, ...strings(outbound.detour)];
    ref('outbound', outbound.outbounds, `/outbounds/${i}/outbounds`);
    if (outbound.type === 'selector' || outbound.type === 'urltest') {
      if (!members.length) error('GROUP_EMPTY', `/outbounds/${i}/outbounds`, '出站组不能为空');
      if (outbound.default !== undefined && !members.includes(String(outbound.default))) {
        error('GROUP_DEFAULT_INVALID', `/outbounds/${i}/default`, '默认出站必须属于该组');
      }
    }
    if (typeof outbound.tag === 'string') graph.set(outbound.tag, edges);
  });
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(tag: string) {
    if (visiting.has(tag)) { error('OUTBOUND_CYCLE', '/outbounds', '出站依赖存在循环'); return; }
    if (visited.has(tag)) return;
    visiting.add(tag);
    for (const next of graph.get(tag) ?? []) visit(next);
    visiting.delete(tag); visited.add(tag);
  }
  for (const tag of graph.keys()) visit(tag);
  const responses = new Set<string>();
  let evaluated = false;
  for (const section of ['dns', 'route'] as const) {
    const rules = objects(section === 'dns' ? dns.rules : route.rules);
    let terminated = false;
    rules.forEach((rule, i) => {
      const path = `/${section}/rules/${i}`;
      if (terminated) diagnostics.push({ severity: 'warning', code: 'RULE_UNREACHABLE', path, message: '此前有无条件终结规则，此步骤不可达' });
      if (section === 'dns' || rule.action === 'resolve') ref('dns', rule.server, `${path}/server`);
      if (section === 'dns') {
        walk(rule, path, (nested, nestedPath) => {
          const response = nested.match_response;
          if ((typeof response === 'string' && !responses.has(response)) || (response === true && !evaluated)) {
            error('DNS_RESPONSE_MISSING', `${nestedPath}/match_response`, '响应必须由此前的 evaluate 步骤定义');
          }
        });
        if (rule.action === 'evaluate') {
          evaluated = true;
          if (typeof rule.tag === 'string') {
            if (responses.has(rule.tag)) error('DNS_RESPONSE_DUPLICATE', `${path}/tag`, 'DNS 响应 tag 重复');
            responses.add(rule.tag);
          }
        }
      }
      const parameters = new Set(['action', 'type', 'server', 'outbound', 'method', 'no_drop', 'rcode', 'answer', 'ns', 'extra', 'disable_cache', 'remove_client_subnet', 'client_subnet', 'rewrite_ttl', 'timeout']);
      const terminal = ['route', 'reject', 'predefined', 'hijack-dns'].includes(String(rule.action ?? 'route'));
      if (terminal && Object.keys(rule).every(key => parameters.has(key))) terminated = true;
    });
  }
  return diagnostics;
}
