import { normalizeCidr } from './cidr-text-adapter.js';
import { normalizeBareDomain } from './convert.js';
import { normalizeTerms, type BuildTerm } from './projection.js';
import { diagnostic, emptyRuleReport } from './types.js';

type TypeCondition = { type: { anyOf: string[] } };
export type ClashTypeFilter = { include: TypeCondition } | { exclude: TypeCondition };

export const validClashRuleType = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(value);

type ClashTermType = Exclude<BuildTerm['type'], 'source_port_range' | 'port_range' | 'domain_regex'>;

function termType(type: string, options: string[]): ClashTermType | undefined {
  // no-resolve controls Clash DNS resolution. Both formats match the supplied destination IP.
  if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    const flags = new Set(options);
    if ([...flags].every(flag => flag === 'no-resolve' || flag === 'src')) {
      return flags.has('src') ? 'source_ip_cidr' : 'ip_cidr';
    }
    return;
  }
  if (options.length) return;
  if (type === 'DOMAIN') return 'domain';
  if (type === 'DOMAIN-SUFFIX') return 'domain_suffix';
  if (type === 'DOMAIN-KEYWORD') return 'domain_keyword';
  if (type === 'SRC-IP-CIDR') return 'source_ip_cidr';
  if (type === 'DST-PORT') return 'port';
  if (type === 'SRC-PORT') return 'source_port';
}

function portTerms(type: 'port' | 'source_port', value: string): BuildTerm[] | undefined {
  const rangeType = type === 'port' ? 'port_range' : 'source_port_range';
  const terms: BuildTerm[] = [];
  for (const part of value.split('/')) {
    if (!part) continue;
    const match = /^(\d+)(?: *- *(\d+))?$/.exec(part.trim());
    if (!match) return;
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first > 65535 || last > 65535) return;
    if (first === last) terms.push({ type, value: first });
    else terms.push({ type: rangeType, value: `${Math.min(first, last)}:${Math.max(first, last)}` });
  }
  return terms.length ? terms : undefined;
}

function convertPayload(type: ClashTermType, value: string): BuildTerm[] | undefined {
  if (type === 'port' || type === 'source_port') return portTerms(type, value);
  if (type === 'ip_cidr' || type === 'source_ip_cidr') {
    const cidr = normalizeCidr(value);
    return cidr ? [{ type, value: cidr }] : undefined;
  }
  if (type === 'domain_keyword') {
    return /[\x00-\x1f\x7f]/u.test(value) ? undefined : [{ type, value: value.toLowerCase() }];
  }
  const domain = normalizeBareDomain(value);
  return domain ? [{ type, value: domain }] : undefined;
}

export function convertClashRuleList(bytes: Uint8Array, file: string, filter?: ClashTypeFilter) {
  const report = emptyRuleReport();
  const location = { file, list: '' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    report.diagnostics.push(diagnostic('INVALID_UTF8', 'Clash rule list must be UTF-8', location));
    return { ok: false as const, report, error: `${file}: Clash rule list must be UTF-8` };
  }

  const include = filter && 'include' in filter;
  const types = new Set(filter && (include ? filter.include : filter.exclude).type.anyOf);
  const unsupported = new Map<string, number>();
  const terms: BuildTerm[] = [];
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#') || entry.startsWith('//')) continue;
    const [sourceType, value, ...options] = entry.split(',').map(part => part.trim());
    const invalid = (message: string) => {
      report.invalidCount++;
      report.diagnostics.push(diagnostic('INVALID_CLASH_RULE', message, { ...location, line: index + 1 }));
    };
    if (!validClashRuleType(sourceType)) { invalid('Expected a Clash rule type'); continue; }
    if (filter && types.has(sourceType) !== include) continue;
    report.inputCount++;
    if (!value) { invalid(`Missing payload for ${sourceType}`); continue; }

    const type = termType(sourceType, options);
    if (!type) {
      report.unsupportedCount++;
      unsupported.set(sourceType, (unsupported.get(sourceType) ?? 0) + 1);
      continue;
    }
    const counts = report.typeCounts[type] ??= { input: 0, converted: 0, output: 0 };
    counts.input++;
    const converted = convertPayload(type, value);
    if (!converted) { invalid(`Invalid payload for ${sourceType}`); continue; }
    counts.converted++;
    report.convertedCount++;
    terms.push(...converted);
  }

  if (unsupported.size) report.unsupportedTypeCounts = Object.fromEntries([...unsupported.entries()].sort(([a], [b]) => a.localeCompare(b)));
  if (report.invalidCount) return { ok: false as const, report, error: `${file}:${report.diagnostics[0].line}: ${report.diagnostics[0].message}` };
  if (!terms.length && report.unsupportedCount) {
    const summary = Object.entries(report.unsupportedTypeCounts!).map(([type, count]) => `${type}=${count}`).join(', ');
    return { ok: false as const, report, error: `${file}: all selected Clash rules are unsupported (${summary})` };
  }
  const output = normalizeTerms(terms);
  for (const { type } of output) (report.typeCounts[type] ??= { input: 0, converted: 0, output: 0 }).output++;
  report.status = 'converted';
  report.duplicateCount = terms.length - output.length;
  report.outputTermCount = output.length;
  return { ok: true as const, terms: output, report };
}
