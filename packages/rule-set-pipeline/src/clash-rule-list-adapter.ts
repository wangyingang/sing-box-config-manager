import { normalizeCidr } from './cidr-text-adapter.js';
import { isDomainKeyword, normalizeBareDomain } from './convert.js';
import { normalizeTerms, type BuildTerm } from './projection.js';
import { diagnostic, emptyRuleReport } from './types.js';

type TypeCondition = { type: { anyOf: string[] } };
export type ClashTypeFilter = { include: TypeCondition } | { exclude: TypeCondition };

export const validClashRuleType = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(value);

function termType(type: string, options: string[]): BuildTerm['type'] | undefined {
  // no-resolve controls Clash DNS resolution. Both formats match the same supplied destination IP.
  if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    if (!options.length || options.length === 1 && options[0] === 'no-resolve') return 'ip_cidr';
    return;
  }
  if (options.length) return;
  if (type === 'DOMAIN') return 'domain';
  if (type === 'DOMAIN-SUFFIX') return 'domain_suffix';
  if (type === 'DOMAIN-KEYWORD') return 'domain_keyword';
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
    const normalized = type === 'ip_cidr' ? normalizeCidr(value)
      : type === 'domain_keyword' ? (isDomainKeyword(value) ? value.toLowerCase() : undefined)
      : normalizeBareDomain(value);
    if (!normalized) { invalid(`Invalid payload for ${sourceType}`); continue; }
    counts.converted++;
    terms.push({ type, value: normalized });
  }

  if (unsupported.size) report.unsupportedTypeCounts = Object.fromEntries([...unsupported.entries()].sort(([a], [b]) => a.localeCompare(b)));
  report.convertedCount = terms.length;
  if (report.invalidCount) return { ok: false as const, report, error: `${file}:${report.diagnostics[0].line}: ${report.diagnostics[0].message}` };
  if (!terms.length && report.unsupportedCount) {
    const summary = Object.entries(report.unsupportedTypeCounts!).map(([type, count]) => `${type}=${count}`).join(', ');
    return { ok: false as const, report, error: `${file}: all selected Clash rules are unsupported (${summary})` };
  }
  const output = normalizeTerms(terms);
  for (const { type } of output) report.typeCounts[type]!.output++;
  report.status = 'converted';
  report.duplicateCount = terms.length - output.length;
  report.outputTermCount = output.length;
  return { ok: true as const, terms: output, report };
}
