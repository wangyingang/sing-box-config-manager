import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { runRulesCli } from '../src/cli.js';
import * as api from '../src/index.js';
import { rulesEnvironment } from './fixtures/rules-environment.js';
import { cleanupEnvironment } from './fixtures/cleanup-environment.js';

const exec = promisify(execFile);

test('root command exposes only the five manager operations', async () => {
  const { stdout } = await exec('corepack', ['pnpm', '--silent', 'rules', '--help'], { cwd: '../..' });
  for (const operation of ['status', 'sync', 'pin', 'resume', 'cleanup']) assert.match(stdout, new RegExp(`pnpm rules ${operation}`));
  for (const old of ['update', 'rebuild', 'check-now', 'activate', 'rollback', 'initialize', 'maintenance-enter', 'maintenance-prepare', 'maintenance-switch', 'maintenance-resume', 'maintenance-abort']) {
    assert.ok(!stdout.includes(`pnpm rules ${old}`));
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', old, '--json']),
      (error: { code?: number; stdout?: string }) => error.code === 1 && JSON.parse(error.stdout!).status === 'failed');
  }
  assert.deepEqual(Object.keys(api).sort(), ['cleanupRuleHistory', 'getRulesStatus', 'pinRuleVersion', 'resumeRuleUpdates', 'syncRules']);
});

test('CLI invalid arguments and draft writes fail before accessing the remote context', async () => {
  const env = rulesEnvironment('/unused');
  env.context.readConfiguration = async () => assert.fail('Invalid arguments must not read remote configuration');
  for (const args of [['sync', 'openai'], ['pin', 'openai'], ['resume'], ['status', '--dry-run'],
    ['sync', '--config', '/missing'], ['status', '--config', '/missing'], ['sync', '--id', 'openai'],
    ['cleanup', 'openai'], ['cleanup', '--period-days', '30'], ['cleanup', '--maintenance-id', 'old'],
    ['cleanup', '--dry-run', '--config', '/missing']]) {
    let value = '';
    assert.equal(await runRulesCli([...args, '--json'], text => { value = text; }, env.context), 1);
    assert.equal(JSON.parse(value).status, 'failed');
    assert.equal(env.writes.length, 0);
  }
});

test('CLI status and Node API expose the same facts without writes', async () => {
  const env = rulesEnvironment('/unused');
  const expected = await api.getRulesStatus({ context: env.context, id: 'openai' });
  let output = '';
  const code = await runRulesCli(['status', 'openai', '--json'], text => { output = text; }, env.context);
  const actual = JSON.parse(output);
  assert.equal(code, expected.exitCode);
  assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
  assert.equal(await runRulesCli(['status', 'openai'], text => { output = text; }, env.context), expected.exitCode);
  assert.match(output, /openai:.*not delivered/);
  assert.match(output, /Expected source:/);
  assert.equal(env.writes.length, 0);
});

test('CLI ordinary source failure returns nonzero and preserves not-delivered facts', async () => {
  const env = rulesEnvironment('/unused');
  env.failSource(true);
  let output = '';
  assert.equal(await runRulesCli(['sync', '--json'], text => { output = text; }, env.context), 1);
  const result = JSON.parse(output);
  assert.equal(result.status, 'failed');
  assert.ok(result.results.every((entry: { status: string; current?: unknown }) => entry.status === 'failed' && !entry.current));
  const status = await api.getRulesStatus({ context: env.context });
  assert.ok(status.rules?.every(rule => rule.deliveryState === 'not-delivered'));
});

test('root --config resolves relative to the invocation directory', async t => {
  const directory = await mkdtemp(resolve('../../.rules-cli-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = resolve(directory, 'invalid.yml');
  await writeFile(config, 'schemaVersion: 999\n');
  await assert.rejects(exec('corepack', ['pnpm', '--silent', 'rules', 'sync', '--dry-run', '--config',
    relative(resolve('../..'), config), '--json'], { cwd: '../..' }),
    (error: { code?: number; stdout?: string }) => error.code === 1
      && /configuration|schemaVersion/.test(error.stdout ?? '') && !/ENOENT/.test(error.stdout ?? ''));
});

test('cleanup CLI renders its retention plan and shares the API dry-run result without writes', async () => {
  const env = cleanupEnvironment('/unused');
  const expected = await api.cleanupRuleHistory({ context: env.context, dryRun: true });
  assert.equal(expected.status, 'success', JSON.stringify(expected));
  let output = '';
  const code = await runRulesCli(['cleanup', '--dry-run', '--json'], text => { output = text; }, env.context);
  assert.equal(code, expected.exitCode);
  assert.deepEqual(JSON.parse(output), JSON.parse(JSON.stringify(expected)));
  assert.equal(await runRulesCli(['cleanup', '--dry-run'], text => { output = text; }, env.context), 0);
  assert.match(output, /Retention: 30 days; observed=.*; cutoff=/);
  assert.match(output, /Candidates: retain=0; discard=0; retained bytes=/);
  assert.equal(env.writes.length, 0);
  assert.equal(env.stageWrites.length, 0);
  assert.equal(env.refWrites.length, 0);
  assert.equal(env.requests.length, 0);
});
