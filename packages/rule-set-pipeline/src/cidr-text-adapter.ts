import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { normalizeTerms, type BuildTerm } from './projection.js';
import { diagnostic, emptyReport } from './types.js';

function normalizeCidr(value: string) {
  const parts = value.split('/');
  if (parts.length !== 2 || !/^(0|[1-9][0-9]{0,2})$/.test(parts[1]) || parts[0].includes('%')) return undefined;
  const family = isIP(parts[0]);
  const prefix = Number(parts[1]);
  if (family === 4 && prefix <= 32) return ipaddr.IPv4.networkAddressFromCIDR(value).toString() + '/' + prefix;
  if (family === 6 && prefix <= 128) {
    // ipaddr.js treats a bare ::dotted-quad as IPv4-mapped. Preserve the original IPv6 bits.
    const address = parts[0].replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_tail, a, b, c, d) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`);
    return ipaddr.IPv6.networkAddressFromCIDR(`${address}/${prefix}`).toRFC5952String() + '/' + prefix;
  }
  return undefined;
}

/** Each non-comment line is one CIDR. An invalid line fails the entire conversion. */
export function convertCidrText(bytes: Uint8Array, file: string, list: string) {
  const report = emptyReport();
  const counts = { input: 0, converted: 0, output: 0 };
  report.typeCounts.ip_cidr = counts;
  const failure = { ok: false as const, report, error: 'CIDR text conversion failed' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    report.diagnostics.push(diagnostic('INVALID_UTF8', 'CIDR input must be UTF-8', { file, list }));
    return failure;
  }

  const terms: BuildTerm[] = [];
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    const value = line.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!value || value.startsWith('#')) continue;
    report.inputCount++;
    const cidr = normalizeCidr(value);
    if (!cidr) {
      report.invalidCount++;
      report.diagnostics.push(diagnostic('INVALID_CIDR', 'Expected one IPv4 or IPv6 CIDR', {
        file, list, line: index + 1, column: line.indexOf(value) + 1,
      }));
    } else terms.push({ type: 'ip_cidr', value: cidr });
  }
  if (!report.inputCount) report.diagnostics.push(diagnostic('EMPTY_INPUT', 'CIDR input contains no rules', { file, list }));

  const output = normalizeTerms(terms);
  report.convertedCount = terms.length;
  report.duplicateCount = terms.length - output.length;
  counts.input = report.inputCount;
  counts.converted = terms.length;
  if (report.diagnostics.length) return failure;

  report.status = 'converted';
  report.outputTermCount = counts.output = output.length;
  report.usageCounts = { route: output.length, 'dns-query': 0, 'dns-response': output.length };
  return { ok: true as const, terms: output, report };
}
