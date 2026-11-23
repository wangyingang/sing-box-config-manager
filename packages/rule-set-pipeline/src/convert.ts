import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { DlcTagFilter } from './configuration.js';
import { renderRuleJson } from './projection.js';
import { diagnostic, emptyReport, TERM_TYPES, type ConversionReport, type InputRule, type RuleTerm, type TermType } from './types.js';

const mapping: Record<string, TermType> = {
  domain: 'domain_suffix', full: 'domain', keyword: 'domain_keyword', regexp: 'domain_regex',
};
export type ConversionResult = { ok: true; terms: RuleTerm[]; report: ConversionReport }
  | { ok: false; report: ConversionReport };

export function isDomainName(value: string): boolean {
  return value.length <= 254
    && /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.?$/u.test(value)
    && value.replace(/\.$/, '').split('.').every(label => label.length <= 63);
}

export function normalizeBareDomain(value: string): string | undefined {
  // Check bare syntax first: domainToASCII also accepts parts of some URLs.
  const name = value.replace(/\.$/, '');
  const domain = /^[\p{L}\p{M}\p{N}.-]+$/u.test(name) && domainToASCII(name);
  // The 255-octet DNS name includes the root and label lengths.
  if (domain && isDomainName(domain) && domain.length <= 253 && !domain.endsWith('.') && !isIP(domain)) return domain;
}

export function isDomainKeyword(value: string): boolean {
  return /^[\p{L}\p{N}.-]+$/u.test(value);
}

function regexpAttributeSeparator(value: string): number {
  // An attribute tail contains no colon. Earlier :@ occurrences belong to the expression.
  const separator = value.lastIndexOf(':@');
  if (separator < 0) return -1;
  let beforeEscape = separator;
  while (value[beforeEscape - 1] === '\\') beforeEscape--;
  return (separator - beforeEscape) % 2 === 0 ? separator : -1;
}

function selectsTags(filter: DlcTagFilter | undefined, tags: readonly string[]) {
  if (!filter) return true;
  const hasTag = (tag: string) => tags.includes(tag);
  const matches = filter.match === 'allOf' ? filter.tags.every(hasTag) : filter.tags.some(hasTag);
  return filter.action === 'include' ? matches : !matches;
}

export function convertRules(rules: readonly InputRule[], selection?: { filter?: DlcTagFilter }): ConversionResult {
  const report = emptyReport();
  report.inputCount = rules.length;
  const terms = new Map<string, RuleTerm>();
  const unsupportedTypes = new Map<string, number>();
  for (const rule of rules) {
    const location = { line: rule.line, column: rule.column, index: rule.index };
    const invalid = (message: string) => {
      report.invalidCount++;
      report.diagnostics.push(diagnostic('INVALID_RULE', message, location));
    };
    if (typeof rule.value !== 'string') { invalid('规则必须为字符串'); continue; }
    const colon = rule.value.indexOf(':');
    if (colon < 1) { invalid('规则缺少类型或分隔符'); continue; }
    const sourceType = rule.value.slice(0, colon);
    const type = Object.hasOwn(mapping, sourceType) ? mapping[sourceType] : undefined;
    const unsupported = () => {
      report.unsupportedCount++;
      if (selection) unsupportedTypes.set(sourceType, (unsupportedTypes.get(sourceType) ?? 0) + 1);
      report.diagnostics.push(diagnostic('UNSUPPORTED_TYPE', `未知类型 ${sourceType}`, location));
    };
    if (!selection) {
      if (!type) { unsupported(); continue; }
      report.typeCounts[type].input++;
    }
    let value = rule.value.slice(colon + 1);
    let tags: string[] = [];
    const attributes = sourceType === 'regexp' ? regexpAttributeSeparator(value) : value.indexOf(':@');
    if (attributes !== -1) {
      const tail = value.slice(attributes + 1);
      const validTail = /^@[A-Za-z0-9!]+(?:,@[A-Za-z0-9!]+)*$/.test(tail);
      // V2Fly lowercases attributes before serializing. Keep uppercase literals in regexps.
      if (validTail && (sourceType !== 'regexp' || tail === tail.toLowerCase())) {
        value = value.slice(0, attributes);
        tags = tail.slice(1).split(',@');
        report.attributeRecordCount++;
      } else if (sourceType !== 'regexp') {
        invalid('属性尾部格式非法'); continue;
      }
    }
    if (!selectsTags(selection?.filter, tags)) continue;
    if (!type) { unsupported(); continue; }
    if (selection) report.typeCounts[type].input++;
    if (!value || /[\u0000-\u001f\u007f]/u.test(value) || (sourceType !== 'regexp' && /\s/u.test(value))) {
      invalid('匹配值为空或含非法空白／控制字符'); continue;
    }
    if ((sourceType === 'domain' || sourceType === 'full') && !isDomainName(value)) {
      invalid('域名匹配值非法'); continue;
    }
    if (sourceType === 'keyword' && !isDomainKeyword(value)) {
      invalid('keyword 含有非法域名字符'); continue;
    }
    // Do not compile with JS RegExp: sing-box uses Go's engine (#16).
    report.convertedCount++;
    report.typeCounts[type].converted++;
    const key = JSON.stringify([type, value]);
    if (terms.has(key)) report.duplicateCount++;
    else terms.set(key, { type, value });
  }
  const output = [...terms.values()].sort((a, b) => TERM_TYPES.indexOf(a.type) - TERM_TYPES.indexOf(b.type)
    || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (unsupportedTypes.size) report.unsupportedTypeCounts = Object.fromEntries(unsupportedTypes);
  report.outputTermCount = output.length;
  for (const term of output) report.typeCounts[term.type].output++;
  report.usageCounts = { route: output.length, 'dns-query': output.length, 'dns-response': 0 };
  if (!selection && !rules.length) report.diagnostics.push(diagnostic('EMPTY_LIST', '不能转换空规则列表'));
  const failed = selection
    ? report.invalidCount > 0 || (report.unsupportedCount > 0 && output.length === 0)
    : report.diagnostics.length > 0;
  if (failed) return { ok: false, report };
  report.status = 'converted';
  return { ok: true, report, terms: output };
}

export function renderDomainJson(terms: readonly RuleTerm[]): string {
  return renderRuleJson(terms);
}
