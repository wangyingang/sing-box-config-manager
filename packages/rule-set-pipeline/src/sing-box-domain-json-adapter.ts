import { isScalar, parseDocument } from 'yaml';
import { isDomainKeyword, normalizeBareDomain } from './convert.js';
import { normalizeTerms } from './projection.js';
import { diagnostic, emptyReport, type RuleTerm } from './types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function convertSingBoxDomainJson(bytes: Uint8Array, file: string, list: string) {
  const report = emptyReport();
  const failed = (code: string, message: string) => {
    report.diagnostics.push(diagnostic(code, message, { file, list }));
    return { ok: false as const, report, error: `${file}: ${message}` };
  };

  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return failed('INVALID_UTF8', 'Domain JSON input must be UTF-8'); }

  let document: unknown;
  try { document = JSON.parse(text); }
  catch (error) { return failed('INVALID_JSON', String(error)); }

  if (!isObject(document)) return failed('INVALID_SOURCE', 'Expected a Source Format object');
  // JSON.parse checks JSON syntax. The syntax tree retains repeated keys and the version token.
  const structure = parseDocument(text.replace(/\r\n?/g, '\n').trim(), { schema: 'json', uniqueKeys: true, stringKeys: true });
  if (structure.errors.length) return failed('INVALID_JSON', structure.errors[0].message);
  const version = structure.get('version', true);
  if (!isScalar(version) || version.source !== '2' || document.version !== 2) {
    return failed('UNSUPPORTED_VERSION', 'Expected Source Format version 2 at version');
  }
  const extra = Object.keys(document).find(key => key !== 'version' && key !== 'rules');
  if (extra !== undefined) return failed('INVALID_SOURCE', `Unsupported source field ${JSON.stringify(extra)}`);
  if (!Array.isArray(document.rules)) return failed('INVALID_SOURCE', 'Expected a rules array');
  if (!document.rules.length) return failed('EMPTY_INPUT', 'rules contains no domain rules');

  const terms: RuleTerm[] = [];
  for (const [index, rule] of document.rules.entries()) {
    const path = `rules[${index}]`;
    const invalid = (message: string) => {
      report.invalidCount++;
      report.diagnostics.push(diagnostic('INVALID_RULE', message, { file, list, index }));
    };
    if (!isObject(rule)) {
      invalid(`Expected a domain rule object at ${path}`);
      continue;
    }
    const start = report.inputCount;
    const errors = report.diagnostics.length;
    for (const [type, values] of Object.entries(rule)) {
      const field = `${path}.${type}`;
      if (type !== 'domain' && type !== 'domain_suffix' && type !== 'domain_keyword') {
        report.unsupportedCount++;
        report.diagnostics.push(diagnostic('UNSUPPORTED_TYPE', `Unsupported rule field ${field}`, { file, list, index }));
        continue;
      }
      if (!Array.isArray(values)) {
        invalid(`Expected a string array at ${field}`);
        continue;
      }
      for (const [offset, value] of values.entries()) {
        report.inputCount++;
        const counts = report.typeCounts[type];
        counts.input++;
        // v2 and v4 both treat a leading dot in a suffix as subdomains only.
        // Validate the name without rewriting the native match value.
        if (typeof value !== 'string' || !(type === 'domain_keyword' ? isDomainKeyword(value)
          : normalizeBareDomain(type === 'domain_suffix' ? value.replace(/^\./, '') : value))) {
          invalid(`Invalid domain match value at ${field}[${offset}]`);
          continue;
        }
        report.convertedCount++;
        counts.converted++;
        terms.push({ type, value });
      }
    }
    if (report.inputCount === start && report.diagnostics.length === errors) {
      invalid(`No domain match values at ${path}`);
    }
  }
  if (report.diagnostics.length) {
    return { ok: false as const, report, error: `${file}: ${report.diagnostics[0].message}` };
  }

  // Native domain, suffix and keyword fields in one rule are alternatives.
  const output = normalizeTerms(terms);
  for (const term of output) {
    report.typeCounts[term.type].output++;
  }
  report.status = 'converted';
  report.duplicateCount = terms.length - output.length;
  report.outputTermCount = output.length;
  report.usageCounts = { route: output.length, 'dns-query': output.length, 'dns-response': 0 };
  return { ok: true as const, terms: output, report };
}
