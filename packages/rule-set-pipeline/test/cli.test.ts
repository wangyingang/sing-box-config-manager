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
    const official = await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8');
    await writeFile(config, official.replace('wangyingang/sing-box-rule-artifacts', 'other/repository'));
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
    const sample = await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8');
    await writeFile(config, sample.replace('branch: main', 'branch: acceptance-issue-36'));
    await exec(process.execPath, ['--import', 'tsx', '--import', preload, 'src/cli.ts', 'build', '--release', tag,
      '--config', config, '--id', 'anthropic', '--out', out, '--binary', process.env.SING_BOX_TEST_BINARY!]);
    const batch = JSON.parse(await readFile(join(out, 'batch.json'), 'utf8'));
    const record = JSON.parse(await readFile(join(out, 'anthropic', 'build.json'), 'utf8'));
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
test(`CLI ${operation} 报告逐集失败并返回非零`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-update-cli-'));
  try {
    const config = join(directory, 'config.yml'), state = join(directory, 'state');
    const module = join(directory, 'update.mjs'), preload = join(directory, 'preload.mjs');
    await writeFile(config, await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8'));
    await writeFile(module, `async function process(options) {
  if (!options.configuration.includes('anthropic') || options.selectedIds?.[0] !== 'anthropic' ||
      options.${operation === 'update' ? 'retryRelease' : 'release'} !== '20261104112839') throw new Error('configuration missing');
  return { status: 'partial', results: [{ id: 'anthropic', status: 'failed', error: 'readback failed' },
    { id: 'openai', status: 'processed' }] };
}
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
    await assert.rejects(run(operation, ['--config', config, '--id', 'anthropic', '--release', '20261104112839', '--binary', '/unused']),
      (error: { code?: number; stdout?: string }) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout ?? '{}').results[0].id, 'anthropic');
        return true;
      });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
}


async function remoteStateCli(directory: string, failure?: string) {
  const module = join(directory, 'remote-state-fixture.mjs'), preload = join(directory, 'remote-preload.mjs');
  const calls = join(directory, 'remote-call.json');
  await writeFile(module, `import { writeFile } from 'node:fs/promises';
export function githubPublication(_request, branch) {
  return { repository: { branch, async snapshot() {
    return { head: 'a'.repeat(40), paths: [], async read() { return undefined; } };
  } }, async commit() { throw new Error('External writes are disabled'); },
    async download() { throw new Error('External reads are disabled'); } };
}
export function immutableUrl() { throw new Error('External reads are disabled'); }
export async function readRemoteStatus(options) {
  await writeFile(${JSON.stringify(calls)}, JSON.stringify({ operation: 'status', branch: options.repository.branch, binary: options.binary }));
  ${failure ? `throw new Error(${JSON.stringify(failure)});` : ''}
  return { authority: 'remote', head: 'a'.repeat(40), generation: 7, maintenance: 'open',
    activeRuleVersions: { 'openai': { candidateId: 'remote-version' } }, pendingOperations: [] };
}
export async function manageMaintenance({ repository, ...options }) {
  await writeFile(${JSON.stringify(calls)}, JSON.stringify({ branch: repository.branch, ...options }));
  return { status: 'ready' };
}
export async function initializeRemoteState(repository, targetBranch) {
  await writeFile(${JSON.stringify(calls)}, JSON.stringify({ operation: 'initialize', branch: repository.branch, targetBranch }));
  ${failure ? `throw new Error(${JSON.stringify(failure)});` : ''}
  return { head: 'b'.repeat(40), journal: { generation: 1, targetBranch } };
}`);
  await writeFile(preload, `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
globalThis.fetch = async () => { throw new Error('External network is disabled'); };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/cli.ts') && ['./remote-status.js', './remote-state.js', './publication.js', './maintenance.js'].includes(specifier)
    || context.parentURL?.endsWith('/src/configured-update.ts') && specifier === './publication.js')
    return { url: pathToFileURL(${JSON.stringify(module)}).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });`);
  return { calls, run: (...args: string[]) => exec(process.execPath, ['--import', 'tsx', '--import', preload, 'src/cli.ts', ...args],
    { env: { ...process.env, GITHUB_TOKEN: 'controlled-cli-fixture' } }) };
}

test('维护 CLI 校验稳定目标和周期参数，按显式隔离分支路由', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-maintenance-cli-'));
  try {
    const fixture = await remoteStateCli(directory);
    for (const args of [['maintenance-enter', '--branch', 'candidates', '--manual'],
      ['maintenance-enter', '--branch', '', '--manual'], ['maintenance-enter', '--period-days', '7'],
      ['maintenance-abort', '--branch', 'acceptance-issue-52']]) {
      await assert.rejects(fixture.run(...args), (error: { code?: number }) => error.code === 1);
    }
    await assert.rejects(stat(fixture.calls), { code: 'ENOENT' });
    const startAt = '2026-11-01T00:00:00Z';
    const { stdout } = await fixture.run('maintenance-preview', '--branch', 'acceptance-issue-52',
      '--period-days', '7', '--start-at', startAt);
    assert.equal(JSON.parse(stdout).status, 'ready');
    assert.deepEqual(JSON.parse(await readFile(fixture.calls, 'utf8')), {
      action: 'preview', branch: 'acceptance-issue-52', schedule: { periodDays: 7, startAt },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI status 默认查询远端 candidates，忽略过期本地状态且无需本地目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-remote-status-cli-'));
  try {
    const fixture = await remoteStateCli(directory), stale = join(directory, 'update-state.json');
    await writeFile(stale, 'invalid local state');
    for (const extra of [[], ['--state', stale], ['--state', join(directory, 'missing')]]) {
      const { stdout } = await fixture.run('status', ...extra), result = JSON.parse(stdout);
      assert.equal(result.authority, 'remote');
      assert.equal(result.generation, 7);
      assert.equal(result.activeRuleVersions['openai'].candidateId, 'remote-version');
      assert.deepEqual(JSON.parse(await readFile(fixture.calls, 'utf8')), { operation: 'status', branch: 'candidates' });
    }
    await assert.rejects(stat(join(directory, 'missing')), { code: 'ENOENT' });
    assert.equal(await readFile(stale, 'utf8'), 'invalid local state');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const operation of ['initialize', 'status']) {
  test(`CLI ${operation} 按显式 branch 或配置目标选择候选状态仓库`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rule-remote-routing-cli-'));
    try {
      const fixture = await remoteStateCli(directory), config = join(directory, 'config.yml');
      const branch = 'acceptance-issue-48-cli';
      await writeFile(config, (await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8')).replace('branch: main', `branch: ${branch}`));
      for (const args of [[], ['--branch', 'main'], ['--branch', branch], ['--config', config], ['--config', config, '--branch', branch]]) {
        const target = args.length && !args.includes('main') ? branch : 'main';
        const { stdout } = await fixture.run(operation, ...args);
        const expected = operation === 'initialize' ? { operation, branch: target === 'main' ? 'candidates' : target, targetBranch: target }
          : { operation, branch: target === 'main' ? 'candidates' : target };
        assert.deepEqual(JSON.parse(await readFile(fixture.calls, 'utf8')), expected);
        if (operation === 'initialize') assert.equal(JSON.parse(stdout).journal.targetBranch, target);
        else assert.equal(JSON.parse(stdout).authority, 'remote');
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('CLI 从 Git 来源配置初始化候选仓库，并要求重建提供完整 commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-remote-git-cli-'));
  try {
    const fixture = await remoteStateCli(directory);
    const config = ['--config', 'config/china-ip.yml'];
    const { stdout } = await fixture.run('initialize', ...config);
    assert.equal(JSON.parse(stdout).journal.targetBranch, 'main');
    assert.deepEqual(JSON.parse(await readFile(fixture.calls, 'utf8')), { operation: 'initialize', branch: 'candidates', targetBranch: 'main' });
    const rebuild = ['rebuild', ...config, '--id', 'china-ip', '--state', join(directory, 'state'), '--binary', '/unused'];
    for (const [extra, expected] of [
      [['--commit', 'abc'], /Expected a full lowercase commit SHA/],
      [['--release', '20261104112839'], /fixed version matching the configured source/],
      [['--commit', 'a'.repeat(40)], /REMOTE_NOT_INITIALIZED/],
    ] as const) {
      await assert.rejects(fixture.run(...rebuild, ...extra), (error: { code?: number; stderr?: string }) =>
        error.code === 1 && expected.test(error.stderr ?? ''));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI status 显式 binary 交给远端验证入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-remote-native-cli-'));
  try {
    const fixture = await remoteStateCli(directory);
    await fixture.run('status', '--binary', '/controlled/sing-box-1.14.4');
    assert.deepEqual(JSON.parse(await readFile(fixture.calls, 'utf8')),
      { operation: 'status', branch: 'candidates', binary: '/controlled/sing-box-1.14.4' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const operation of ['initialize', 'status']) {
  test(`CLI ${operation} 拒绝冲突目标与无关参数，未调用远端入口`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rule-remote-options-cli-'));
    try {
      const fixture = await remoteStateCli(directory), config = join(directory, 'config.yml');
      await writeFile(config, await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8'));
      const invalid = [['--config', config, '--branch', 'acceptance-other'], ['--id', 'openai'], ['--release', '20261104112839'], ['--expected-head', 'a'.repeat(40)],
        ...(operation === 'initialize' ? [['--binary', '/unused']] : [])];
      for (const args of invalid) await assert.rejects(fixture.run(operation, ...args), (error: { code?: number }) => error.code === 1);
      await assert.rejects(stat(fixture.calls), { code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test(`CLI ${operation} 远端状态异常退出非零并保留明确错误`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rule-remote-failure-cli-'));
    try {
      const fixture = await remoteStateCli(directory, operation === 'initialize' ? 'REMOTE_ALREADY_INITIALIZED' : 'REMOTE_STATE_CORRUPT');
      await assert.rejects(fixture.run(operation), (error: { code?: number; stderr?: string; stdout?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? '', operation === 'initialize' ? /REMOTE_ALREADY_INITIALIZED/ : /REMOTE_STATE_CORRUPT/);
        assert.equal(error.stdout, '');
        return true;
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('CLI 从可信配置生成订阅，也接受显式订阅映射并返回逐集结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-check-cli-'));
  try {
    const config = join(directory, 'config.yml'), subscriptions = join(directory, 'subscriptions.json');
    const preload = join(directory, 'preload.mjs'), implementation = join(directory, 'check.mjs');
    await writeFile(config, await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8'));
    await writeFile(subscriptions, '{"anthropic":{"schemaVersion":2}}');
    await writeFile(implementation, `export async function checkRules(options) {
      if (!options.configuration.includes('anthropic') || options.subscriptions['anthropic'].schemaVersion !== 2) {
        throw new Error('Missing trusted inputs');
      }
      const status = options.selectedIds?.length ? 'verification-pending' : 'paused';
      return { exitCode: status === 'paused' ? 0 : 1, results: [{ id: 'anthropic', status }] };
    }
    export async function resumeRules(options) {
      if (options.logicalId !== 'anthropic' || !options.configuration.includes(options.logicalId)
        || options.subscriptions[options.logicalId].schemaVersion !== 2) throw new Error('Missing trusted resume inputs');
      return { exitCode: 1, results: [{ id: options.logicalId, status: 'failed', control: { reason: 'manual-resume' } }] };
    }`);
    await writeFile(preload, `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/cli.ts') && specifier === './check-rules.js')
    return { url: pathToFileURL(${JSON.stringify(implementation)}).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });`);
    const run = (command: string, ...args: string[]) => exec(process.execPath, ['--import', 'tsx', '--import', preload, 'src/cli.ts', command,
      '--state', directory, '--binary', '/unused', '--config', config, ...args],
      { env: { ...process.env, GITHUB_TOKEN: 'controlled-cli-fixture' } });
    const configured = await run('check-now');
    assert.equal(JSON.parse(configured.stdout).results[0].status, 'paused');
    const paused = await run('check-now', '--subscription', subscriptions);
    assert.equal(JSON.parse(paused.stdout).results[0].status, 'paused');
    await assert.rejects(run('check-now', '--subscription', subscriptions, '--id', 'anthropic'), (error: { code?: number; stdout?: string }) =>
      error.code === 1 && JSON.parse(error.stdout ?? '').results[0].status === 'verification-pending');
    for (const selection of [[], ['--id', 'anthropic', '--id', 'openai']]) {
      await assert.rejects(run('resume', '--subscription', subscriptions, ...selection),
        (error: { code?: number; stderr?: string }) => error.code === 1 && /exactly one --id/.test(error.stderr ?? ''));
    }
    await assert.rejects(run('resume', '--subscription', subscriptions, '--id', 'anthropic'), (error: { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stdout ?? '').results, [{ id: 'anthropic', status: 'failed', control: { reason: 'manual-resume' } }]);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
