import type { Json, Obj } from '../src/types.js';
/** Only the documented 1.14.4 typed-encoding differences; never sort an array. */
export function normalize(config: Obj): Obj {
  const listable = new Set(['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr', 'process_name', 'process_path', 'process_path_regex', 'package_name', 'rule_set', 'protocol', 'network', 'port', 'inbound', 'query_type']);
  function walk(value: Json, path: string): Json {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}/${i}`));
    if (!value || typeof value !== 'object') return value;
    const result: Obj = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'action' && item === 'route' && /\/(dns|route)\/rules\//.test(path)) continue;
      if (key === 'type' && item === 'inline' && /^\/route\/rule_set\/\d+$/.test(path)) continue;
      if (key === 'format' && ((item === 'binary' && String(value.url).endsWith('.srs')) || (item === 'source' && String(value.url).endsWith('.json')))) continue;
      if (key === 'disabled' && item === false && path === '/log') continue;
      if (key === 'prefer_go' && item === false && /^\/dns\/servers\/\d+$/.test(path)) continue;
      if (key === 'neighbor_domain' && Array.isArray(item) && !item.length && /^\/dns\/servers\/\d+$/.test(path)) continue;
      if (key === 'secret' && item === '' && /^\/services\/\d+$/.test(path)) continue;
      if (key === 'version' && item === 2 && /^\/http_clients\/\d+$/.test(path)) continue;
      const normalized = walk(item, `${path}/${key}`);
      result[key] = listable.has(key) && Array.isArray(normalized) && normalized.length === 1 && typeof normalized[0] !== 'object' ? normalized[0] : normalized;
    }
    return result;
  }
  return walk(config, '') as Obj;
}
