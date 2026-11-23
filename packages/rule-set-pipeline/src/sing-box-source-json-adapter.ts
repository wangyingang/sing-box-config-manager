import { isScalar, parseDocument } from 'yaml';
import { normalizeTerms, readIndependentTerms } from './projection.js';
import { diagnostic, emptyRuleReport } from './types.js';

/** The initial v4 reader accepts independent predicates in Source Format v4. */
export function convertSingBoxSourceJson(bytes: Uint8Array, file: string) {
  const report = emptyRuleReport();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(text);
    const structure = parseDocument(text.replace(/\r\n?/g, '\n').trim(), { schema: 'json', uniqueKeys: true, stringKeys: true });
    if (structure.errors.length) throw new Error(structure.errors[0].message);
    const version = structure.get('version', true);
    if (!isScalar(version) || version.source !== '4') throw new Error('Expected Source Format version 4');
    if (!document || typeof document !== 'object' || !('version' in document) || !('rules' in document)
      || Object.keys(document).length !== 2) throw new Error('Expected sing-box Source Format v4 with version and rules');
    const input = readIndependentTerms(document);
    const terms = normalizeTerms(input);
    for (const { type } of input) {
      const count = report.typeCounts[type] ??= { input: 0, converted: 0, output: 0 };
      count.input++;
      count.converted++;
    }
    for (const { type } of terms) report.typeCounts[type]!.output++;
    report.status = 'converted';
    report.inputCount = report.convertedCount = input.length;
    report.outputTermCount = terms.length;
    report.duplicateCount = input.length - terms.length;
    return { ok: true as const, terms, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.diagnostics.push(diagnostic('INVALID_SING_BOX_SOURCE_JSON', message, { file, list: '' }));
    return { ok: false as const, report, error: `${file}: ${message}` };
  }
}
