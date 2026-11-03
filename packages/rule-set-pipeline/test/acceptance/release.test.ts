import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('真实固定 Release CLI 两次下载、校验、构建，输出字节一致且来源可追溯', { timeout: 240_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rule-pipeline-release-'));
  const first = join(temporary, 'first');
  const second = join(temporary, 'second');
  try {
    const run = (out: string, extra: string[] = [], nativeBinary = process.env.SING_BOX_TEST_BINARY ?? '') => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts',
      'build', '--binary', nativeBinary, '--release', '20261102130044', '--out', out, ...extra], { timeout: 110_000 });
    await run(first);
    await run(second, ['--expected-source', join(first, 'source.json')]);
    const failed = join(temporary, 'failed-native');
    await assert.rejects(run(failed, [], '/missing-issue16-binary'));
    assert.deepEqual((await readdir(failed)).sort(), ['conversion-report.json', 'failure.json', 'source.json']);
    const a = await readFile(join(first, 'domains.json'));
    const b = await readFile(join(second, 'domains.json'));
    assert.deepEqual(a, b);
    assert.equal(a.toString(), await readFile(new URL('../fixtures/20261102130044.domains.json', import.meta.url), 'utf8'));
    const source = JSON.parse(await readFile(join(first, 'source.json'), 'utf8'));
    const expectedSource = JSON.parse(await readFile(new URL('../fixtures/20261102130044.source.json', import.meta.url), 'utf8'));
    assert.deepEqual(source, expectedSource);
    const record = JSON.parse(await readFile(join(first, 'build.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(first, 'conversion-report.json'), 'utf8'));
    assert.equal(record.status, 'built-validated');
    assert.equal(record.validation.status, 'passed');
    assert.equal(record.tool.version, '1.14.4');
    assert.deepEqual(record.usages.route, record.usages['dns-query']);
    assert.equal(record.artifacts[0].sha256, createHash('sha256').update(a).digest('hex'));
    assert.equal(record.artifacts[0].bytes, a.byteLength);
    assert.equal(record.artifacts[0].termCount, 214);
    assert.equal(report.inputCount, 214);
    assert.equal(report.convertedCount, 214);
    assert.equal(report.attributeRecordCount, 13);
    assert.deepEqual(record.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual((await readdir(first)).sort(), ['build.json', 'conversion-report.json', 'domains.json', 'domains.srs', 'source.json']);
    for (const artifact of record.artifacts) {
      const bytes = await readFile(join(first, artifact.file));
      assert.deepEqual(bytes, await readFile(join(second, artifact.file)));
      assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(artifact.bytes, bytes.length);
      assert.equal(artifact.termCount, 214);
    }
    const secondRecord = JSON.parse(await readFile(join(second, 'build.json'), 'utf8'));
    assert.equal(record.buildId, secondRecord.buildId);
    console.log(JSON.stringify({ source, artifacts: record.artifacts, tools: record.tools, tool: record.tool,
      buildId: record.buildId, validation: record.validation, report }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
