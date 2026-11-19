import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { isDomainName } from './convert.js';
import { normalizeTerms } from './projection.js';
import { diagnostic, emptyReport, type RuleTerm } from './types.js';

export function convertDomainSuffixText(bytes: Uint8Array, file: string, list: string) {
  const report = emptyReport();
  const counts = report.typeCounts.domain_suffix;
  const failed = (detail: string) => ({ ok: false as const, report, error: `${file}: ${detail}` });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    report.diagnostics.push(diagnostic('INVALID_UTF8', 'Domain input must be UTF-8', { file, list }));
    return failed('domain input must be UTF-8');
  }

  const terms: RuleTerm[] = [];
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    const value = line.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!value) continue;
    report.inputCount++;
    // Check bare syntax first: domainToASCII also accepts parts of some URLs.
    const name = value.replace(/\.$/, '');
    const domain = /^[\p{L}\p{M}\p{N}.-]+$/u.test(name) && domainToASCII(name);
    // The 255-octet DNS name includes the root and label lengths.
    if (!domain || !isDomainName(domain) || domain.length > 253 || domain.endsWith('.') || isIP(domain)) {
      report.invalidCount++;
      report.diagnostics.push(diagnostic('INVALID_RULE', 'Expected one bare domain name', {
        file, list, line: index + 1, column: line.indexOf(value) + 1,
      }));
    } else terms.push({ type: 'domain_suffix', value: domain });
  }
  const output = normalizeTerms(terms);
  counts.input = report.inputCount;
  counts.converted = report.convertedCount = terms.length;
  report.duplicateCount = terms.length - output.length;
  if (!report.inputCount) {
    report.diagnostics.push(diagnostic('EMPTY_INPUT', 'Domain input contains no rules', { file, list }));
    return failed('domain input contains no rules');
  }
  if (report.invalidCount) return failed(`expected one bare domain name on line ${report.diagnostics[0].line}`);

  report.status = 'converted';
  report.outputTermCount = counts.output = output.length;
  report.usageCounts = { route: output.length, 'dns-query': output.length, 'dns-response': 0 };
  return { ok: true as const, terms: output, report };
}
