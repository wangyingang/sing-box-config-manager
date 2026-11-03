import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('CLI 失败退出只保留诊断，拒绝覆盖已有构建目录', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rule-pipeline-cli-'));
  const out = join(temporary, 'failed');
  const run = () => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', '--release', 'latest', '--out', out]);
  try {
    await assert.rejects(run(), (error: { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes('INVALID_TAG'));
    assert.deepEqual(await readdir(out), ['conversion-report.json', 'failure.json']);
    const report = JSON.parse(await readFile(join(out, 'conversion-report.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    await writeFile(join(out, 'sentinel'), 'previous result');
    await assert.rejects(run(), (error: { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes('EEXIST'));
    assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'previous result');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('CLI 缺少固定 Release 或存在未知参数时明确退出', async () => {
  for (const args of [['build'], ['build', '--latest'], ['unknown']]) {
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args]), (error: { code?: number }) => error.code === 1);
  }
});
