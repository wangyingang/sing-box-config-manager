import type { DlcRuleDefinition } from './configuration.js';
import { convertRules, type ConversionResult } from './convert.js';
import { emptyReport, type ConversionReport } from './types.js';
import { readLists, type ReadResult } from './yaml-input.js';

type ListConversion = Extract<ConversionResult, { ok: true }> | { ok: false; report: ConversionReport; error: string };

function convertList(parsed: ReadResult, list: string, selection?: { filter?: DlcRuleDefinition['filter']; file: string }): ListConversion {
  if (!parsed.ok) return { ok: false, error: selection
      ? `DLC list ${list} is unavailable or invalid: ${parsed.diagnostics.map(entry => entry.message).join(', ')}`
      : 'Plain YAML list is unavailable or invalid',
    report: { ...emptyReport(), inputCount: parsed.inputCount, diagnostics: selection ? parsed.diagnostics.map(entry => ({ ...entry, file: selection.file })) : parsed.diagnostics } };
  const converted = convertRules(parsed.rules, selection);
  converted.report.diagnostics = converted.report.diagnostics.map(entry => ({ ...entry, list, ...(selection && { file: selection.file }) }));
  return converted.ok ? converted : { ...converted, error: selection
    ? `DLC list ${list} conversion failed: ${converted.report.diagnostics[0]?.message}` : 'Rule conversion failed' };
}

/** Parse shared bytes once. Invalid individual lists do not block sibling lists. */
export function convertPlainYaml(input: Uint8Array, lists: readonly string[]) {
  return new Map([...readLists(input, [...new Set(lists)])].map(([list, parsed]) => [list, convertList(parsed, list)]));
}

/** Read each selected list once, then apply each rule set's own tag filter. */
export function convertDlcYaml(input: Uint8Array, definitions: readonly DlcRuleDefinition[], file: string) {
  const lists = readLists(input, [...new Set(definitions.map(({ list }) => list))], { allowEmpty: true });
  return new Map(definitions.map(({ id, list, filter }) => [id, convertList(lists.get(list)!, list, { filter, file })]));
}
