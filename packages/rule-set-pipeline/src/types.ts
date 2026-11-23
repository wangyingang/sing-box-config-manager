export const TARGET_LIST = 'category-ai-!cn';
export const TERM_TYPES = ['domain_suffix', 'domain', 'domain_keyword', 'domain_regex'] as const;
export type TermType = typeof TERM_TYPES[number];
/** Each term is an independent predicate; the collection is an OR. */
export interface RuleTerm { type: TermType; value: string }
export interface InputRule { value: unknown; line: number; column: number; index: number }
export interface Diagnostic {
  code: string;
  message: string;
  file: string;
  list: string;
  line?: number;
  column?: number;
  index?: number;
}
interface TermCounts { input: number; converted: number; output: number }
export interface RuleConversionReport {
  status: 'failed' | 'converted';
  inputCount: number;
  convertedCount: number;
  unsupportedCount: number;
  invalidCount: number;
  duplicateCount: number;
  outputTermCount: number;
  attributeRecordCount: number;
  filteredRules?: { type: 'PROCESS-NAME'; value: string; line: number }[];
  typeCounts: Record<TermType, TermCounts> & Partial<Record<'ip_cidr' | 'headless', TermCounts>>;
  skippedRuleTypeCounts?: Record<string, number>;
  diagnostics: Diagnostic[];
}
export interface ConversionReport extends RuleConversionReport {
  usageCounts: Record<'route' | 'dns-query' | 'dns-response', number>;
}
export interface AssetIdentity { id: number; name: string; url: string }
export interface SourceRecord {
  repository: string;
  releaseId: number;
  tag: string;
  commit: string;
  yaml: AssetIdentity;
  checksum: AssetIdentity;
  inputSha256: string;
  inputBytes: number;
  checksumSha256: string;
}
export function emptyRuleReport(): RuleConversionReport {
  return {
    status: 'failed', inputCount: 0, convertedCount: 0, unsupportedCount: 0,
    invalidCount: 0, duplicateCount: 0, outputTermCount: 0, attributeRecordCount: 0,
    typeCounts: Object.fromEntries(TERM_TYPES.map((type) => [type, { input: 0, converted: 0, output: 0 }])) as ConversionReport['typeCounts'],
    diagnostics: [],
  };
}
export function emptyReport(): ConversionReport {
  const { diagnostics, ...counts } = emptyRuleReport();
  return { ...counts, usageCounts: { route: 0, 'dns-query': 0, 'dns-response': 0 }, diagnostics };
}
export function diagnostic(code: string, message: string, location: Partial<Diagnostic> = {}): Diagnostic {
  return { code, message, file: 'dlc.dat_plain.yml', list: TARGET_LIST, ...location };
}
