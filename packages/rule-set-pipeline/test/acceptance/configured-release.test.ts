import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildConfiguredRelease } from '../../src/configured-build.js';

test('固定官方 Release 一次读取三集，分别原生验证且重复构建字节一致', { timeout: 180_000 }, async () => {
  const configuration = await readFile(new URL('../../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8');
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(String(input));
    return fetch(input, init);
  };
  const options = { configuration,
    release: { tag: '20261104112839', fetch: fetcher, token: process.env.GITHUB_TOKEN },
    binary: process.env.SING_BOX_TEST_BINARY ?? '' };
  const first = await buildConfiguredRelease(options);
  assert.equal(requests.filter(url => url.endsWith('/assets/' + first.source.yaml.id)).length, 1);
  assert.equal(requests.filter(url => url.endsWith('/assets/' + first.source.checksum.id)).length, 1);
  assert.deepEqual(first.results.map(result => result.id), ['ai-openai', 'ai-anthropic', 'ai-google-deepmind']);
  for (const [index, result] of first.results.entries()) {
    assert.equal(result.status, 'built-validated', JSON.stringify(result.report));
    if (result.status !== 'built-validated') continue;
    assert.equal(result.report.inputCount, [25, 19, 49][index]);
    assert.equal(result.native.tool.version, '1.14.4');
    assert.equal(result.native.validation.status, 'passed');
    assert.deepEqual(result.native.usages.route, result.native.usages['dns-query']);
    assert.deepEqual(result.native.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual(result.native.artifacts.map(artifact => artifact.file), ['domains.json', 'domains.srs']);
    assert.ok(result.native.artifacts.every(artifact => artifact.requiredCapabilities.length === 0));
  }
  const second = await buildConfiguredRelease(options);
  for (let index = 0; index < 3; index++) {
    const a = first.results[index], b = second.results[index];
    assert.equal(a.status, 'built-validated'); assert.equal(b.status, 'built-validated');
    if (a.status !== 'built-validated' || b.status !== 'built-validated') continue;
    assert.equal(a.buildId, b.buildId);
    for (let file = 0; file < 2; file++) assert.deepEqual(a.native.artifacts[file].content, b.native.artifacts[file].content);
  }
  const selected = await buildConfiguredRelease({ ...options, selectedIds: ['ai-anthropic'] });
  assert.deepEqual(selected.results.map(result => result.id), ['ai-anthropic']);
  console.log(JSON.stringify({ release: first.source.tag, sourceSha256: first.source.inputSha256,
    results: first.results.map(result => ({ id: result.id, inputCount: result.report.inputCount,
      status: result.status, buildId: result.status === 'built-validated' ? result.buildId : null })) }));
});
