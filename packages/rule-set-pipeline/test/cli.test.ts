import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('CLI 批次与逐集记录保留已校验目标分支', { skip: !process.env.SING_BOX_TEST_BINARY }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rule-config-target-'));
  try {
    const tag = '20261104112839', input = JSON.stringify({ lists: [{ name: 'anthropic', length: 1, rules: ['domain:anthropic.com'] }] });
    const checksum = createHash('sha256').update(input).digest('hex');
    const preload = join(temporary, 'source.mjs'), config = join(temporary, 'config.yml'), out = join(temporary, 'out');
    await writeFile(preload, `globalThis.fetch = async url => {
  const path = String(url);
  if (path.endsWith('/releases/tags/${tag}')) return Response.json({ id: 42, tag_name: '${tag}', assets:
    ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, index) => ({ id: index + 11, name,
      browser_download_url: 'https://github.com/v2fly/domain-list-community/releases/download/${tag}/' + name })) });
  if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
  if (path.endsWith('/assets/11')) return new Response(${JSON.stringify(input)});
  if (path.endsWith('/assets/12')) return new Response(${JSON.stringify(checksum + '  dlc.dat_plain.yml\n')});
  throw new Error('unexpected source request ' + path);
};`);
    const sample = await readFile(new URL('../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8');
    await writeFile(config, sample.replace('branch: main', 'branch: acceptance-issue-36'));
    await exec(process.execPath, ['--import', 'tsx', '--import', preload, 'src/cli.ts', 'build', '--release', tag,
      '--config', config, '--id', 'ai-anthropic', '--out', out, '--binary', process.env.SING_BOX_TEST_BINARY!]);
    const batch = JSON.parse(await readFile(join(out, 'batch.json'), 'utf8'));
    const record = JSON.parse(await readFile(join(out, 'ai-anthropic', 'build.json'), 'utf8'));
    assert.deepEqual(batch.configuration.target, { repository: 'wangyingang/sing-box-rule-artifacts', branch: 'acceptance-issue-36' });
    assert.deepEqual(record.target, batch.configuration.target);
    assert.equal(record.buildId, batch.results[0].buildId);
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

for (const operation of ['update', 'rebuild']) {
test(`CLI ${operation} 报告逐集失败并返回非零，status 在新进程读取逐集状态`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-update-cli-'));
  try {
    const config = join(directory, 'config.yml'), state = join(directory, 'state');
    const module = join(directory, 'update.mjs'), preload = join(directory, 'preload.mjs');
    await writeFile(config, await readFile(new URL('../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8'));
    await writeFile(module, `async function process(options) {
  if (!options.configuration.includes('ai-anthropic') || options.selectedIds?.[0] !== 'ai-anthropic' ||
      options.${operation === 'update' ? 'retryRelease' : 'release'} !== '20261104112839') throw new Error('configuration missing');
  return { status: 'partial', results: [{ id: 'ai-anthropic', status: 'failed', error: 'readback failed' },
    { id: 'ai-openai', status: 'processed' }] };
}
export async function readUpdateState() { return { state: { configuredProcessed: { 'ai-openai': { '42': { candidateId: 'fixed' } } } } }; }
export const updateRules = process;
export const rebuildRules = process;`);
    await writeFile(preload, `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/cli.ts') && specifier === './update.js')
    return { url: pathToFileURL(${JSON.stringify(module)}).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });`);
    const run = (operation: string, extra: string[] = []) => exec(process.execPath, ['--import', 'tsx', '--import', preload,
      'src/cli.ts', operation, '--state', state, ...extra]);
    await assert.rejects(run(operation, ['--config', config, '--id', 'ai-anthropic', '--release', '20261104112839', '--binary', '/unused']),
      (error: { code?: number; stdout?: string }) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout ?? '{}').results[0].id, 'ai-anthropic');
        return true;
      });
    const { stdout } = await run('status');
    assert.equal(JSON.parse(stdout).state.configuredProcessed['ai-openai']['42'].candidateId, 'fixed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
}
