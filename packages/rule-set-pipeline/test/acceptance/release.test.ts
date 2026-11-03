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
    const run = (out: string, extra: string[] = []) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts',
      'build', '--release', '20261102130044', '--out', out, ...extra], { timeout: 110_000 });
    await run(first);
    await run(second, ['--expected-source', join(first, 'source.json')]);
    const a = await readFile(join(first, 'domains.json'));
    const b = await readFile(join(second, 'domains.json'));
    assert.deepEqual(a, b);
    assert.equal(a.toString(), await readFile(new URL('../fixtures/20261102130044.domains.json', import.meta.url), 'utf8'));
    const source = JSON.parse(await readFile(join(first, 'source.json'), 'utf8'));
    const expectedSource = JSON.parse(await readFile(new URL('../fixtures/20261102130044.source.json', import.meta.url), 'utf8'));
    assert.deepEqual(source, expectedSource);
    const record = JSON.parse(await readFile(join(first, 'build.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(first, 'conversion-report.json'), 'utf8'));
    assert.equal(record.status, 'built-unvalidated');
    assert.equal(record.artifact.sha256, createHash('sha256').update(a).digest('hex'));
    assert.equal(record.artifact.bytes, a.byteLength);
    assert.equal(record.artifact.termCount, 214);
    assert.equal(report.inputCount, 214);
    assert.equal(report.convertedCount, 214);
    assert.equal(report.attributeRecordCount, 13);
    assert.deepEqual(record.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual((await readdir(first)).sort(), ['build.json', 'conversion-report.json', 'domains.json', 'source.json']);
    console.log(JSON.stringify({ source, artifact: record.artifact, tools: record.tools, report }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
