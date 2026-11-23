import { isDomainKeyword, normalizeBareDomain } from './convert.js';
import { normalizeTerms } from './projection.js';
import { diagnostic, emptyReport, type ConversionReport, type RuleTerm } from './types.js';

const trimField = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, '');

export function convertTypedDomainText(bytes: Uint8Array, file: string, list: string) {
  const report = emptyReport();
  const filteredRules: NonNullable<ConversionReport['filteredRules']> = [];
  report.filteredRules = filteredRules;
  const failed = (detail: string) => ({ ok: false as const, report, error: `${file}: ${detail}` });

  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    report.diagnostics.push(diagnostic('INVALID_UTF8', 'Typed domain input must be UTF-8', { file, list }));
    return failed('typed domain input must be UTF-8');
  }

  const terms: RuleTerm[] = [];
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    const entry = trimField(line);
    if (!entry || entry.startsWith('#')) continue;
    report.inputCount++;
    const location = { file, list, line: index + 1, column: line.indexOf(entry) + 1 };
    const invalid = (message: string) => {
      report.invalidCount++;
      report.diagnostics.push(diagnostic('INVALID_RULE', message, location));
    };
    const fields = entry.split(',').map(trimField);
    const [kind, value] = fields;
    if (fields.length !== 2 || !kind || !value || /[\u0000-\u001f\u007f]/u.test(kind + value)) {
      invalid('Expected TYPE,value without extra fields or control characters');
      continue;
    }
    if (kind === 'PROCESS-NAME') {
      filteredRules.push({ type: kind, value, line: location.line });
      continue;
    }
    if (kind !== 'DOMAIN-SUFFIX' && kind !== 'DOMAIN-KEYWORD') {
      report.unsupportedCount++;
      report.diagnostics.push(diagnostic('UNSUPPORTED_TYPE', `Unsupported rule type: ${kind}`, location));
      continue;
    }
    const type = kind === 'DOMAIN-SUFFIX' ? 'domain_suffix' : 'domain_keyword';
    const counts = report.typeCounts[type];
    counts.input++;
    const domain = type === 'domain_suffix' ? normalizeBareDomain(value) : isDomainKeyword(value) && value.toLowerCase();
    if (!domain) {
      invalid(`Invalid ${kind} value`);
      continue;
    }
    counts.converted++;
    report.convertedCount++;
    terms.push({ type, value: domain });
  }

  if (report.diagnostics.length) {
    const { message, line } = report.diagnostics[0];
    return failed(`${message} on line ${line}`);
  }
  if (!terms.length) {
    const message = 'Typed domain input contains no domain rules after filtering';
    report.diagnostics.push(diagnostic('EMPTY_INPUT', message, { file, list }));
    return failed(message);
  }

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
