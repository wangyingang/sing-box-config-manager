import { renderRuleJson } from './projection.js';
import { diagnostic, emptyReport, TERM_TYPES, type ConversionReport, type InputRule, type RuleTerm, type TermType } from './types.js';

const mapping: Record<string, TermType> = {
  domain: 'domain_suffix', full: 'domain', keyword: 'domain_keyword', regexp: 'domain_regex',
};
export type ConversionResult = { ok: true; terms: RuleTerm[]; report: ConversionReport }
  | { ok: false; report: ConversionReport };

export function convertRules(rules: readonly InputRule[]): ConversionResult {
  const report = emptyReport();
  report.inputCount = rules.length;
  const terms = new Map<string, RuleTerm>();
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
    if (!Object.hasOwn(mapping, sourceType)) {
      report.unsupportedCount++;
      report.diagnostics.push(diagnostic('UNSUPPORTED_TYPE', `未知类型 ${sourceType}`, location));
      continue;
    }
    const type = mapping[sourceType];
    report.typeCounts[type].input++;
    let value = rule.value.slice(colon + 1);
    const attributes = value.indexOf(':@');
    if (sourceType === 'regexp' && attributes !== -1) { invalid('regexp 含有歧义的字面 :@'); continue; }
    if (attributes !== -1) {
      const tail = value.slice(attributes + 1);
      if (!/^@[A-Za-z0-9!]+(?:,@[A-Za-z0-9!]+)*$/.test(tail)) {
        invalid('属性尾部格式非法'); continue;
      }
      value = value.slice(0, attributes);
      report.attributeRecordCount++;
    }
    if (!value || /[\u0000-\u001f\u007f]/u.test(value) || (sourceType !== 'regexp' && /\s/u.test(value))) {
      invalid('匹配值为空或含非法空白／控制字符'); continue;
    }
    if ((sourceType === 'domain' || sourceType === 'full') &&
        (!/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.?$/u.test(value) ||
         value.length > 254 || value.replace(/\.$/, '').split('.').some((label) => label.length > 63))) {
      invalid('域名匹配值非法'); continue;
    }
    if (sourceType === 'keyword' && !/^[\p{L}\p{N}.-]+$/u.test(value)) {
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
  report.outputTermCount = output.length;
  for (const term of output) report.typeCounts[term.type].output++;
  report.usageCounts = { route: output.length, 'dns-query': output.length, 'dns-response': 0 };
  if (!rules.length) report.diagnostics.push(diagnostic('EMPTY_LIST', '不能转换空规则列表'));
  if (report.diagnostics.length) return { ok: false, report };
  report.status = 'converted';
  return { ok: true, report, terms: output };
}

export function renderDomainJson(terms: readonly RuleTerm[]): string {
  return renderRuleJson(terms);
}
