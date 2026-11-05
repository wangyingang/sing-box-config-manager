import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

test('CLI 在创建输出目录前拒绝不可信的多集配置', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rule-config-cli-'));
  try {
    const config = join(temporary, 'bad.yml'), out = join(temporary, 'out');
    await writeFile(config, `schemaVersion: 1\nsource: v2fly/domain-list-community\ntarget:\n  repository: other/repository\n  branch: main\nruleSets:\n  - id: ai-openai\n    list: openai\n    stablePath: stable/ai-openai\n`);
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', '--release', '20261104112839',
      '--config', config, '--out', out, '--binary', '/unused']), (error: { code?: number; stderr?: string }) =>
      error.code === 1 && !!error.stderr?.includes('trusted publication target'));
    await assert.rejects(stat(out), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

// Run the real CLI and receipt filesystem operations. Only remote activation is
// replaced; its journal proves the remote commit was applied before the failure.
async function activationCli(directory: string, state: string, operation = 'activate') {
  const commit = 'c'.repeat(40), applied = join(directory, 'applied.json');
  const activationModule = join(directory, 'activation.mjs'), preload = join(directory, 'preload.mjs');
  const subscription = join(directory, 'subscription.json');
  await writeFile(subscription, '{}');
  await writeFile(activationModule, `import { writeFile } from 'node:fs/promises';
export async function activateRules() {
  const result = { status: 'activated', commit: ${JSON.stringify(commit)}, activation: { id: 'receipt-test' } };
  await writeFile(${JSON.stringify(applied)}, JSON.stringify(result));
  return result;
}
export const rollbackRules = activateRules;`);
  await writeFile(preload, `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/cli.ts') && specifier === './activation.js')
    return { url: pathToFileURL(${JSON.stringify(activationModule)}).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });`);
  return { commit, applied, run: () => exec(process.execPath, ['--import', 'tsx', '--import', preload,
    'src/cli.ts', operation, '--state', state, operation === 'rollback' ? '--activation' : '--candidate', 'controlled-fixture',
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

test('CLI 回滚保存独立激活回执且不改变 Release 成功记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-rollback-receipt-'));
  try {
    const state = join(directory, 'state');
    const fixture = await activationCli(directory, state, 'rollback');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(state);
    const success = Buffer.from('{"release":"newer-success"}\n');
    await writeFile(join(state, 'update-state.json'), success);
    const { stdout } = await fixture.run();
    assert.equal(JSON.parse(stdout).commit, fixture.commit);
    assert.deepEqual(await readFile(join(state, 'update-state.json')), success);
    assert.equal(JSON.parse(await readFile(join(state, 'active-version.json'), 'utf8')).commit, fixture.commit);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI 回滚拒绝缺失目标、candidate 混用和非回滚命令上的历史参数', async () => {
  for (const args of [['rollback'], ['activate', '--activation', 'a'.repeat(40)], ['status', '--activation', 'a'.repeat(40)]]) {
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args]), (error: { code?: number }) => error.code === 1);
  }
});
