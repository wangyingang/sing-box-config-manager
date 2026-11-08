import { convertRules, type ConversionResult } from './convert.js';
import { emptyReport, type ConversionReport } from './types.js';
import { readLists, type ReadResult } from './yaml-input.js';

type ListConversion = Extract<ConversionResult, { ok: true }> | { ok: false; report: ConversionReport; error: string };

function convertList(parsed: ReadResult, list: string): ListConversion {
  if (!parsed.ok) return { ok: false, error: 'Plain YAML list is unavailable or invalid',
    report: { ...emptyReport(), inputCount: parsed.inputCount, diagnostics: parsed.diagnostics } };
  const converted = convertRules(parsed.rules);
  converted.report.diagnostics = converted.report.diagnostics.map(entry => ({ ...entry, list }));
  return converted.ok ? converted : { ...converted, error: 'Rule conversion failed' };
}

/** Parse shared bytes once. Invalid individual lists do not block sibling lists. */
export function convertPlainYaml(input: Uint8Array, lists: readonly string[]) {
  return new Map([...readLists(input, [...new Set(lists)])].map(([list, parsed]) => [list, convertList(parsed, list)]));
}
