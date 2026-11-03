import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { convertRules, readTargetList, renderDomainJson } from '../src/index.js';

test('固定官方目标列表的 214 条记录全部转换，覆盖 13 条属性记录', async () => {
  // This fixture is an exact list excerpt, not the complete checksummed asset.
  const input = await readFile(new URL('./fixtures/20261102130044.category-ai-not-cn.yml', import.meta.url));
  const parsed = readTargetList(input);
  assert.ok(parsed.ok);
  const result = convertRules(parsed.rules);
  assert.ok(result.ok, JSON.stringify(result.report));
  assert.equal(result.report.inputCount, 214);
  assert.equal(result.report.convertedCount, 214);
  assert.equal(result.report.outputTermCount, 214);
  assert.equal(result.report.duplicateCount, 0);
  assert.equal(result.report.unsupportedCount, 0);
  assert.equal(result.report.invalidCount, 0);
  assert.equal(result.report.attributeRecordCount, 13);
  assert.deepEqual(result.report.typeCounts, {
    domain_suffix: { input: 179, converted: 179, output: 179 },
    domain: { input: 34, converted: 34, output: 34 },
    domain_keyword: { input: 0, converted: 0, output: 0 },
    domain_regex: { input: 1, converted: 1, output: 1 },
  });
  assert.equal(renderDomainJson(result.terms), await readFile(new URL('./fixtures/20261102130044.domains.json', import.meta.url), 'utf8'));
  assert.ok(result.terms.some((term) => term.value === 'cici.com'));
  assert.ok(result.terms.some((term) => term.value === 'browser-intake-datadoghq.com'));
  assert.ok(result.terms.some((term) => term.value === '^chatgpt-async-webps-prod-\\S+-\\d+\\.webpubsub\\.azure\\.com$'));
});
