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
  if (converted.ok) return converted;
  if (!selection) return { ...converted, error: 'Rule conversion failed' };
  const diagnostics = converted.report.diagnostics;
  const blocking = diagnostics.find(entry => entry.code !== 'UNSUPPORTED_TYPE') ?? diagnostics[0];
  const location = blocking?.line === undefined ? '' : ` at line ${blocking.line}`;
  return { ...converted, error: `DLC list ${list} conversion failed${location}: ${blocking?.message ?? 'No convertible rules'}` };
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
