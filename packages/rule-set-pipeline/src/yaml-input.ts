import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';
import { diagnostic, TARGET_LIST, type Diagnostic, type InputRule } from './types.js';

export type ReadResult = { ok: true; rules: InputRule[] } | { ok: false; diagnostics: Diagnostic[]; inputCount: number };
class SharedYamlError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) { super(diagnostics.map(entry => entry.message).join('; ')); }
}

/** Decode YAML exactly once. Keep scalar values and locations for conversion. */
export function readLists(input: Uint8Array, names: readonly string[]): Map<string, ReadResult> {
  const fail = (name: string, code: string, message: string, inputCount = 0): ReadResult => ({
    ok: false, diagnostics: [diagnostic(code, message, { list: name })], inputCount,
  });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { throw new SharedYamlError([diagnostic('INVALID_UTF8', '输入不是有效的 UTF-8')]); }
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, stringKeys: true });
  if (doc.errors.length || doc.warnings.length) {
    throw new SharedYamlError([...doc.errors, ...doc.warnings].map(error => diagnostic('INVALID_YAML', error.message,
      error.linePos?.[0] && { line: error.linePos[0].line, column: error.linePos[0].col })));
  }
  // The official plain export contains no aliases. Reject instead of expanding
  // unbounded/cyclic structures or losing precise source locations.
  let alias = false;
  visit(doc, { Alias() { alias = true; } });
  if (alias) throw new SharedYamlError([diagnostic('INVALID_YAML', 'plain YAML 不允许 alias')]);
  if (!isMap(doc.contents)) throw new SharedYamlError([diagnostic('INVALID_LISTS', 'YAML 根节点必须为 mapping')]);
  const lists = doc.contents.get('lists', true);
  if (!isSeq(lists)) throw new SharedYamlError([diagnostic('INVALID_LISTS', 'lists 必须为列表')]);
  return new Map(names.map(name => {
    const targets = lists.items.filter(item => isMap(item) && item.get('name') === name);
    if (targets.length !== 1) return [name, fail(name, 'TARGET_LIST_COUNT', `目标列表必须唯一，实际为 ${targets.length}`)];
    const target = targets[0];
    if (!isMap(target)) return [name, fail(name, 'INVALID_LIST', '目标列表必须为 mapping')];
    const rules = target.get('rules', true);
    const length = target.get('length');
    if (!isSeq(rules) || rules.items.length === 0) return [name, fail(name, 'EMPTY_LIST', '目标 rules 必须为非空列表')];
    if (!Number.isSafeInteger(length) || length !== rules.items.length) {
      return [name, fail(name, 'LENGTH_MISMATCH', `声明 length ${String(length)} 与规则数 ${rules.items.length} 不一致`, rules.items.length)];
    }
    return [name, { ok: true, rules: rules.items.map((item, index) => {
      const pos = lines.linePos((isNode(item) ? item.range?.[0] : undefined) ?? target.range?.[0] ?? 0);
      return { value: isScalar(item) ? item.value : undefined, index, line: pos.line, column: pos.col };
    }) }];
  }));
}

export function readTargetList(input: Uint8Array): ReadResult {
  try { return readLists(input, [TARGET_LIST]).get(TARGET_LIST)!; }
  catch (error) {
    if (error instanceof SharedYamlError) return { ok: false, diagnostics: error.diagnostics, inputCount: 0 };
    throw error;
  }
}
