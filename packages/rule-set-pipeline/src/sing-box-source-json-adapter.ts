import { isScalar, parseDocument } from 'yaml';
import { BUILD_TERM_TYPES, readSourceTerms, type BuildRule } from './projection.js';
import { diagnostic, emptyRuleReport, type RuleConversionReport } from './types.js';

export const NATIVE_SOURCE_CONVERSION_POLICY = 'sing-box-source-json-v2';
export interface SourceRuleEntry { index: number; rule: Record<string, unknown> }
export interface SourceRuleEntries { inputCount: number; accepted: SourceRuleEntry[] }

// Source Format v4 fields written by sing-box 1.14.4's SRS encoder.
const stringLists = new Set([
  ...BUILD_TERM_TYPES, 'network', 'source_ip_cidr', 'source_port_range', 'port_range',
  'process_name', 'process_path', 'process_path_regex', 'package_name', 'network_type',
  'wifi_ssid', 'wifi_bssid', 'default_interface_address',
]);
const flags = new Set(['network_is_expensive', 'network_is_constrained']);
const logicalFields = new Set(['type', 'mode', 'rules', 'invert']);
// The v1.14.4 SRS reader rejects a rule below depth 100.
const MAX_LOGICAL_RULE_DEPTH = 100;

class SourceRuleError extends Error {
  constructor(path: string, readonly field: string, reason: string, readonly unsupported = false) {
    super(`${path}.${field}: ${reason}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sourceRules(document: unknown): unknown[] {
  if (!isObject(document) || document.version !== 4 || !Array.isArray(document.rules)
    || Object.keys(document).length !== 2) throw new Error('Expected sing-box Source Format v4 with version and rules');
  return document.rules;
}

const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
const isString = (value: unknown): value is string => typeof value === 'string';
const isUint16 = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;

function defaultCondition(field: string, value: unknown, path: string): unknown {
  if (flags.has(field)) {
    if (typeof value === 'boolean' || value === null) return value || undefined;
  } else if (field === 'network_interface_address') {
    if (value === null) return undefined;
    if (isObject(value)) {
      const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : 1);
      if (entries.every(([, addresses]) => list(addresses).every(isString))) {
        return entries.length ? Object.fromEntries(entries.map(([name, addresses]) => [name, list(addresses)])) : undefined;
      }
    }
  } else {
    const values = list(value);
    if (stringLists.has(field)) {
      if (values.every(isString) && (!['domain', 'domain_suffix'].includes(field) || !values.includes(''))) {
        return values.length ? [...new Set(values)] : undefined;
      }
    } else if (field === 'port' || field === 'source_port') {
      if (values.every(isUint16)) return values.length ? [...new Set(values)] : undefined;
    } else if (field === 'query_type') {
      if (values.every(item => isString(item) || isUint16(item))) return values.length ? [...new Set(values)] : undefined;
    } else {
      throw new SourceRuleError(path, field, 'not supported by Source Format v4', true);
    }
  }
  throw new SourceRuleError(path, field, 'invalid condition value');
}

function readRule(value: unknown, path: string, depth = 0): Record<string, unknown> {
  if (!isObject(value)) throw new SourceRuleError(path, 'type', 'expected a rule object');
  const { type, invert } = value;
  if (invert != null && typeof invert !== 'boolean') throw new SourceRuleError(path, 'invert', 'expected a boolean');
  if (type === 'logical') {
    if (depth >= MAX_LOGICAL_RULE_DEPTH) {
      throw new SourceRuleError(path, 'logical', `SRS supports at most ${MAX_LOGICAL_RULE_DEPTH} logical levels`, true);
    }
    for (const field of Object.keys(value)) {
      if (!logicalFields.has(field)) throw new SourceRuleError(path, field, 'not supported in a logical rule', true);
    }
    if (value.mode !== 'and' && value.mode !== 'or') throw new SourceRuleError(path, 'mode', 'expected and or or');
    if (!Array.isArray(value.rules) || !value.rules.length) throw new SourceRuleError(path, 'rules', 'expected nonempty child rules');
    return { type, mode: value.mode, rules: value.rules.map((rule, index) => readRule(rule, `${path}.rules[${index}]`, depth + 1)), ...(invert && { invert }) };
  }
  if (type != null && type !== '' && type !== 'default') throw new SourceRuleError(path, 'type', 'unsupported rule type', true);

  const conditions: [string, unknown][] = [];
  for (const field of Object.keys(value).sort()) {
    if (field === 'type' || field === 'invert') continue;
    const condition = defaultCondition(field, value[field], path);
    if (condition !== undefined) conditions.push([field, condition]);
  }
  if (!conditions.length) throw new SourceRuleError(path, 'type', 'expected at least one effective condition');
  return { ...Object.fromEntries(conditions), ...(invert && { invert }) };
}

function headless(rule: Record<string, unknown>): BuildRule {
  return { type: 'headless', rule };
}

export function sourceBuildRules({ inputCount, accepted }: SourceRuleEntries): BuildRule[] {
  if (inputCount > 1 && accepted.length === 1) {
    const [{ rule }] = accepted;
    if (rule.type !== 'logical' && rule.invert !== true) {
      // A single non-inverted default rule would newly merge with the consumer's outer groups.
      return [headless({ type: 'logical', mode: 'or', rules: [rule] })];
    }
  }
  return accepted.map(({ rule }) => headless(rule));
}

/** Candidate files are already converted. Any unsupported rule invalidates the candidate. */
export function readCandidateRules(document: unknown, singleArtifact: boolean, conversionPolicy: unknown): BuildRule[] {
  if (singleArtifact && conversionPolicy === NATIVE_SOURCE_CONVERSION_POLICY) {
    return sourceRules(document).map((rule, index) => headless(readRule(rule, `rules[${index}]`)));
  }
  return readSourceTerms(document, { allowEmpty: singleArtifact });
}

export function recordRejectedSourceRule(report: RuleConversionReport, file: string, index: number,
  field: string, message: string, unsupported = false) {
  const code = unsupported ? 'UNSUPPORTED_SING_BOX_RULE' : 'INVALID_SING_BOX_RULE';
  report.diagnostics.push(diagnostic(code, message, { file, list: '', index }));
  const counts = report.skippedRuleTypeCounts ??= {};
  const previous = Object.hasOwn(counts, field) ? counts[field] : 0;
  Object.defineProperty(counts, field, { value: previous + 1, enumerable: true, configurable: true, writable: true });
  if (unsupported) report.unsupportedCount++;
  else report.invalidCount++;
}

export function sourceRuleType(rule: Record<string, unknown>) {
  if (rule.type === 'logical') return 'logical';
  const conditions = Object.keys(rule).filter(field => field !== 'invert');
  return conditions.length === 1 ? conditions[0] : 'default';
}

export function sourceConversionReport(report: RuleConversionReport, entries: SourceRuleEntries) {
  report.diagnostics.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  report.inputCount = entries.inputCount;
  report.convertedCount = report.outputTermCount = entries.accepted.length;
  report.typeCounts = emptyRuleReport().typeCounts;
  for (const { rule } of entries.accepted) {
    const type = BUILD_TERM_TYPES.find(field => field === sourceRuleType(rule)) ?? 'headless';
    const count = report.typeCounts[type] ??= { input: 0, converted: 0, output: 0 };
    count.input++;
    count.converted++;
    count.output++;
  }
  report.status = entries.accepted.length || !entries.inputCount ? 'converted' : 'failed';
}

export function noConvertedRules(file: string, report: RuleConversionReport) {
  return `${file}: No rules could be converted. ${report.diagnostics[0].message}`;
}

export function convertSingBoxSourceJson(bytes: Uint8Array, file: string) {
  const report = emptyRuleReport();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(text);
    const structure = parseDocument(text.replace(/\r\n?/g, '\n').trim(), { schema: 'json', uniqueKeys: true, stringKeys: true });
    if (structure.errors.length) throw new Error(structure.errors[0].message);
    const version = structure.get('version', true);
    if (!isScalar(version) || version.source !== '4') throw new Error('Expected Source Format version 4');
    const rules = sourceRules(document);
    const entries: SourceRuleEntries = { inputCount: rules.length, accepted: [] };
    for (const [index, rule] of rules.entries()) {
      try {
        entries.accepted.push({ index, rule: readRule(rule, `rules[${index}]`) });
      } catch (error) {
        if (!(error instanceof SourceRuleError)) throw error;
        recordRejectedSourceRule(report, file, index, error.field, error.message, error.unsupported);
      }
    }
    sourceConversionReport(report, entries);
    if (report.status === 'failed') return { ok: false as const, report, error: noConvertedRules(file, report) };
    return { ok: true as const, terms: sourceBuildRules(entries), sourceEntries: entries, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.diagnostics.push(diagnostic('INVALID_SING_BOX_SOURCE_JSON', message, { file, list: '' }));
    return { ok: false as const, report, error: `${file}: ${message}` };
  }
}
