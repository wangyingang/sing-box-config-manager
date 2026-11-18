import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildRelease } from '../../src/release-build.js';
import { buildNative } from '../../src/native.js';
import { readSourceTerms } from '../../src/projection.js';

test('内部固定 Release 两次下载、校验、构建，字节一致且来源可追溯', { timeout: 240_000 }, async () => {
  const first = await buildRelease({ tag: '20261102130044', token: process.env.GITHUB_TOKEN });
  assert.ok(first.ok, JSON.stringify(first.report));
  const second = await buildRelease({ tag: '20261102130044', expectedSource: first.source, token: process.env.GITHUB_TOKEN });
  assert.ok(second.ok, JSON.stringify(second.report));
  assert.equal(first.json, second.json);
  assert.equal(first.json, await readFile(new URL('../fixtures/20261102130044.domains.json', import.meta.url), 'utf8'));
  assert.deepEqual(first.source, JSON.parse(await readFile(new URL('../fixtures/20261102130044.source.json', import.meta.url), 'utf8')));
  assert.deepEqual(first.source, second.source);
  const terms = readSourceTerms(JSON.parse(first.json));
  await assert.rejects(buildNative(terms, '/missing-issue16-binary'));
  const a = await buildNative(terms, process.env.SING_BOX_TEST_BINARY ?? '');
  const b = await buildNative(readSourceTerms(JSON.parse(second.json)), process.env.SING_BOX_TEST_BINARY ?? '');
  assert.equal(a.status, 'built-validated');
  assert.equal(a.validation.status, 'passed');
  assert.equal(a.tool.version, '1.14.4');
  assert.deepEqual(a.usages.route, a.usages['dns-query']);
  assert.deepEqual(a.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
  assert.equal(first.report.inputCount, 214);
  assert.equal(first.report.convertedCount, 214);
  assert.equal(first.report.attributeRecordCount, 13);
  for (const artifact of a.artifacts) {
    assert.deepEqual(artifact.content, b.artifacts.find(item => item.file === artifact.file)!.content);
    assert.equal(artifact.sha256, createHash('sha256').update(artifact.content).digest('hex'));
    assert.equal(artifact.bytes, artifact.content.length);
    if (artifact.format === 'source') assert.equal(artifact.termCount, 214);
    else assert.ok(!Object.hasOwn(artifact, 'termCount'));
  }
  assert.equal(a.buildId, b.buildId);
  console.log(JSON.stringify({ source: first.source, tools: first.tools, tool: a.tool,
    buildId: a.buildId, validation: a.validation, report: first.report }));
});
