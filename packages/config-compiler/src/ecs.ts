import ipaddr from 'ipaddr.js';
import { object, objects } from './json.js';
import type { Diagnostic, GenerationParams, Obj } from './types.js';

export function applyEcs(config: Obj, tags: string[], params: GenerationParams): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string) => diagnostics.push({ severity: 'error', code: 'ECS_INVALID', path: '/params/ecs', message });
  if (!object(params) || Object.keys(params).some(k => k !== 'ecs') || !('ecs' in params)) {
    error('生成参数只允许显式的 ecs；没有可靠 IPv4 时传 null'); return diagnostics;
  }
  let subnet: string | undefined;
  if (params.ecs !== null) {
    const ecs = params.ecs;
    if (!object(ecs) || Object.keys(ecs).some(k => !['address', 'prefix'].includes(k)) ||
      typeof ecs.address !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ecs.address) ||
      !Number.isInteger(ecs.prefix) || ecs.prefix < 0 || ecs.prefix > 32) {
      error('ECS 需要公网 IPv4 和显式的 0–32 前缀长度'); return diagnostics;
    }
    try {
      if (!ipaddr.IPv4.isValidFourPartDecimal(ecs.address)) throw new Error();
      const address = ipaddr.IPv4.parse(ecs.address);
      if (address.range() !== 'unicast') throw new Error();
      subnet = ipaddr.IPv4.networkAddressFromCIDR(`${ecs.address}/${ecs.prefix}`).toString() + '/' + ecs.prefix;
    } catch { error('ECS 地址不是公网单播 IPv4'); return diagnostics; }
  }
  const rules = object(config.dns) ? objects(config.dns.rules) : [];
  const unique = new Set(tags);
  if (unique.size !== tags.length) error('ECS 声明包含重复响应 tag');
  function rejectUndeclared(value: unknown, path: string) {
    if (Array.isArray(value)) value.forEach((item, i) => rejectUndeclared(item, `${path}/${i}`));
    else if (object(value)) {
      if ('client_subnet' in value && !( /^\/dns\/rules\/\d+$/.test(path) && value.action === 'evaluate' && typeof value.tag === 'string' && unique.has(value.tag))) {
        error('配置包含未声明的 client_subnet，不能保证请求级 ECS 隔离');
      }
      for (const [key, item] of Object.entries(value)) rejectUndeclared(item, `${path}/${key}`);
    }
  }
  rejectUndeclared(config, '');
  for (const tag of unique) {
    const matching = rules.filter(r => r.tag === tag && r.action === 'evaluate');
    if (matching.length !== 1) { error('ECS 声明必须引用唯一的顶层 evaluate 响应'); continue; }
    const rule = matching[0];
    delete rule.client_subnet;
    delete rule.remove_client_subnet;
    if (subnet === undefined) rule.remove_client_subnet = true;
    else rule.client_subnet = subnet;
  }
  return diagnostics;
}
