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

// Run the real CLI and receipt filesystem operations. Only remote activation is
// replaced; its journal proves the remote commit was applied before the failure.
async function activationCli(directory: string, state: string) {
  const commit = 'c'.repeat(40), applied = join(directory, 'applied.json');
  const activationModule = join(directory, 'activation.mjs'), preload = join(directory, 'preload.mjs');
  const subscription = join(directory, 'subscription.json');
  await writeFile(subscription, '{}');
  await writeFile(activationModule, `import { writeFile } from 'node:fs/promises';
export async function activateRules() {
  const result = { status: 'activated', commit: ${JSON.stringify(commit)}, activation: { id: 'receipt-test' } };
  await writeFile(${JSON.stringify(applied)}, JSON.stringify(result));
  return result;
}`);
  await writeFile(preload, `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/cli.ts') && specifier === './activation.js')
    return { url: pathToFileURL(${JSON.stringify(activationModule)}).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });`);
  return { commit, applied, run: () => exec(process.execPath, ['--import', 'tsx', '--import', preload,
    'src/cli.ts', 'activate', '--state', state, '--candidate', 'controlled-fixture',
    '--subscription', subscription, '--expected-head', 'a'.repeat(40), '--binary', '/unused-controlled-fixture']) };
}

for (const failure of ['existing-file', 'parent-is-file']) {
  test(`CLI 激活已生效但回执目录 ${failure} 时报告已应用 commit`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rule-activation-receipt-'));
    try {
      const blocker = join(directory, 'blocker'); await writeFile(blocker, 'existing content');
      const state = failure === 'existing-file' ? blocker : join(blocker, 'state');
      const fixture = await activationCli(directory, state);
      await assert.rejects(fixture.run(), (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? '', /ACTIVATION_APPLIED_LOCAL_RECEIPT_PENDING/);
        assert.ok(error.stderr?.includes(fixture.commit), 'Applied remote commit must remain visible');
        return true;
      });
      assert.equal(JSON.parse(await readFile(fixture.applied, 'utf8')).commit, fixture.commit);
      assert.equal(await readFile(blocker, 'utf8'), 'existing content');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('CLI 激活成功后创建缺失的状态目录并保存可恢复回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-activation-receipt-'));
  try {
    const state = join(directory, 'new', 'state'), fixture = await activationCli(directory, state);
    const { stdout } = await fixture.run(), result = JSON.parse(stdout);
    assert.equal(result.commit, fixture.commit);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'active-version.json'), 'utf8')), result);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
