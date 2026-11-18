import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runRuleWorkflow, runRuleAutomation } from '../src/rule-workflow.js';
import { getRulesStatus, cleanupRuleHistory } from '../src/index.js';
import { rulesEnvironment } from './fixtures/rules-environment.js';
import { cleanupEnvironment } from './fixtures/cleanup-environment.js';

test('workflow status reads production without acquiring a write capability', async () => {
  const env = rulesEnvironment('/unused', 'main');
  env.context.allowWrites = false;
  const expected = await getRulesStatus({ context: env.context });
  let text = '';
  assert.equal(await runRuleWorkflow({ operation: 'status', target: 'main' }, output => { text = output; }, env.context), 0);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(expected)));
  assert.equal(env.writes.length, 0);
});

test('isolated workflow reports the shared service result and rejects retired operations', async () => {
  const env = rulesEnvironment('/unused');
  const expected = await getRulesStatus({ context: env.context });
  let text = '';
  assert.equal(await runRuleWorkflow({ operation: 'status', target: env.context.targetBranch }, output => { text = output; }, env.context), expected.exitCode);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(expected)));
  for (const operation of ['check', 'schedule-preflight']) {
    assert.equal(await runRuleWorkflow({ operation, target: env.context.targetBranch }, output => { text = output; }, env.context), 1);
  }
  assert.equal(env.writes.length, 0);
});

test('workflow rejects a context that points at another target', async () => {
  const env = rulesEnvironment('/unused', 'main');
  env.context.readConfiguration = async () => assert.fail('A mismatched context cannot read business state');
  let output = '';
  assert.equal(await runRuleWorkflow({ operation: 'sync', target: 'acceptance-different' }, text => { output = text; }, env.context), 1);
  assert.match(JSON.parse(output).error, /disagree/);
  assert.equal(env.writes.length, 0);
});

test('isolated cleanup workflow uses the same read-only plan and rejects stage arguments', async () => {
  const env = cleanupEnvironment('/unused');
  const expected = await cleanupRuleHistory({ context: env.context, dryRun: true });
  assert.equal(expected.status, 'success', JSON.stringify(expected));
  let output = '';
  assert.equal(await runRuleWorkflow({ operation: 'cleanup', target: env.context.targetBranch, dryRun: true },
    text => { output = text; }, env.context), expected.exitCode);
  assert.deepEqual(JSON.parse(output), JSON.parse(JSON.stringify(expected)));
  assert.equal(await runRuleWorkflow({ operation: 'cleanup', target: env.context.targetBranch, id: 'openai' },
    text => { output = text; }, env.context), 1);
  assert.equal(JSON.parse(output).status, 'failed');
  assert.equal(env.writes.length, 0);
  assert.equal(env.stageWrites.length, 0);
  assert.equal(env.refWrites.length, 0);
  assert.equal(env.requests.length, 0);
});


test('workflow rejects unrelated and option-shaped inputs before reading business state', async () => {
  const env = rulesEnvironment('/unused');
  env.context.readConfiguration = async () => assert.fail('Invalid input must fail before reading configuration');
  for (const inputs of [
    { operation: 'status', version: 'a-version' },
    { operation: 'status', dryRun: true },
    { operation: 'sync', id: 'openai' },
    { operation: 'cleanup', version: 'a-version' },
    { operation: 'pin', version: 'a-version' },
    { operation: 'resume', version: 'openai' },
    { operation: 'resume', id: 'openai', version: 'a-version' },
    { operation: 'pin', id: '--help', version: 'a-version' },
  ]) {
    let text = '';
    assert.equal(await runRuleWorkflow({ ...inputs, target: env.context.targetBranch }, output => { text = output; }, env.context), 1);
    assert.match(JSON.parse(text).error, /unrelated inputs/);
  }
  assert.equal(env.writes.length, 0);
});

function scenario(responses: { operation: string; status: string; exitCode: number;
  error?: string; results?: { status: string; error?: string }[] }[]) {
  const context = rulesEnvironment('/unused').context;
  const calls: string[] = [];
  const reports: unknown[] = [];
  const execute: NonNullable<Parameters<typeof runRuleAutomation>[3]> = async (request, report) => {
    calls.push(request.operation);
    const next = responses[calls.length - 1];
    assert.ok(next, `Unexpected operation ${request.operation}`);
    assert.equal(request.operation, next.operation);
    report(JSON.stringify({ target: { branch: context.targetBranch }, configurationRevision: (await context.readConfiguration()).revision, ...next }));
    return next.exitCode;
  };
  return { context, calls, reports, run: (event: 'push' | 'schedule' = 'schedule') =>
    runRuleAutomation({ event, target: context.targetBranch }, text => reports.push(JSON.parse(text)), context, execute) };
}

const syncSuccess = { operation: 'sync', status: 'success', exitCode: 0, results: [{ status: 'unchanged' }, { status: 'pinned-skipped' }] };
const cleanupSuccess = { operation: 'cleanup', status: 'success', exitCode: 0 };

test('configuration push only synchronizes; daily sync and cleanup keep separate results', async () => {
  const pushed = scenario([syncSuccess]);
  pushed.context.repository.snapshot = async () => assert.fail('Push must not run schedule preflight');
  assert.equal(await pushed.run('push'), 0);
  assert.deepEqual(pushed.calls, ['sync']);
  const daily = scenario([syncSuccess, cleanupSuccess]);
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['sync', 'cleanup']);
  const reports = daily.reports as { operation: string; configurationRevision: string }[];
  assert.deepEqual(reports.map(report => report.operation), ['schedule-preflight', 'sync', 'cleanup']);
  assert.ok(reports.every(report => report.configurationRevision === reports[0].configurationRevision));
});

test('ordinary per-rule failure still permits cleanup and cannot be hidden by cleanup success', async () => {
  const daily = scenario([
    { ...syncSuccess, status: 'partial', exitCode: 1, results: [{ status: 'delivered' }, { status: 'failed', error: 'Upstream unavailable' }] },
    cleanupSuccess,
  ]);
  assert.equal(await daily.run(), 1);
  assert.deepEqual(daily.calls, ['sync', 'cleanup']);
  assert.equal((daily.reports[1] as { status: string }).status, 'partial');
});

test('shared pending, unverified state and concurrent configuration changes stop subsequent writes', async () => {
  for (const failed of [
    { ...syncSuccess, status: 'pending', exitCode: 1 },
    { ...syncSuccess, status: 'failed', exitCode: 1, error: 'Cannot verify current delivery' },
    { ...syncSuccess, status: 'partial', exitCode: 1, results: [{ status: 'superseded', error: 'RULE_INTENT_SUPERSEDED' }] },
    { ...syncSuccess, status: 'failed', exitCode: 1, results: [{ status: 'failed', error: 'RULE_WRITE_CONFLICT' }] },
  ]) {
    const daily = scenario([failed]);
    assert.equal(await daily.run(), 1);
    assert.deepEqual(daily.calls, ['sync']);
  }
  for (const message of ['Cannot confirm current Git state', '']) {
    const unreadable = scenario([]);
    unreadable.context.repository.snapshot = async () => { throw new Error(message); };
    assert.equal(await unreadable.run(), 1);
    assert.deepEqual(unreadable.calls, []);
    assert.equal((unreadable.reports[0] as { error: string }).error, message);
  }
});

test('disabled update does not prevent independently enabled cleanup', async () => {
  const daily = scenario([{ ...syncSuccess, status: 'disabled', error: 'Not applied: updates disabled' }, cleanupSuccess]);
  daily.context.allowWrites = false;
  daily.context.allowCleanupWrites = true;
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['sync', 'cleanup']);
});

test('default-off automation reports disabled operations without reading old production state', async () => {
  const daily = scenario([
    { ...syncSuccess, status: 'disabled' },
    { ...cleanupSuccess, status: 'disabled' },
  ]);
  daily.context.allowWrites = false;
  daily.context.allowCleanupWrites = false;
  daily.context.repository.snapshot = async () => assert.fail('Both gates are disabled');
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['sync', 'cleanup']);
  assert.ok(daily.reports.every(report => (report as { status: string; configurationRevision: string }).status === 'disabled'
    && (report as { configurationRevision: string }).configurationRevision !== 'unavailable'));
});

test('production manual and scheduled writes share disabled gates and retain the current configuration revision', async () => {
  const env = rulesEnvironment('/unused', 'main');
  env.context.allowWrites = false;
  env.context.allowCleanupWrites = false;
  env.context.repository.snapshot = async () => assert.fail('Disabled operations must not read or migrate production state');
  for (const request of [
    { operation: 'sync' },
    { operation: 'pin', id: 'openai', version: 'retained-version' },
    { operation: 'resume', id: 'openai' },
    { operation: 'cleanup' },
  ]) {
    let output = '';
    assert.equal(await runRuleWorkflow({ ...request, target: 'main' }, text => { output = text; }, env.context), 0);
    const result = JSON.parse(output);
    assert.equal(result.status, 'disabled');
    assert.equal(result.configurationRevision, (await env.context.readConfiguration()).revision);
    assert.equal(result.target.branch, 'main');
  }
  const reports: { status: string; configurationRevision: string }[] = [];
  assert.equal(await runRuleAutomation({ event: 'schedule', target: 'main' }, text => reports.push(JSON.parse(text)), env.context), 0);
  assert.equal(reports.length, 2);
  assert.ok(reports.every(result => result.status === 'disabled' && result.configurationRevision !== 'unavailable'));
  assert.equal(env.writes.length, 0);
  assert.equal(env.requests.length, 0);
});

test('Actions entry writes the schedule preflight failure to the summary and JSON artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rules-actions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuration = await rulesEnvironment('/unused', 'main').context.readConfiguration();
  const response = join(directory, 'configuration.json');
  await writeFile(response, JSON.stringify({ encoding: 'base64', content: Buffer.from(configuration.content).toString('base64') }));
  await writeFile(join(directory, 'gh'), `#!/bin/sh
case "$2" in
  repos/wangyingang/sing-box-config-manager/commits/main) printf '%s' '{"sha":"${configuration.revision}"}' ;;
  repos/wangyingang/sing-box-config-manager/contents/*) cat "$RULE_TEST_CONFIGURATION" ;;
  repos/wangyingang/sing-box-rule-artifacts) printf '%s' '{"private":false}' ;;
  repos/wangyingang/sing-box-rule-artifacts/git/ref/heads/candidates) echo 'journal is unreadable' >&2; exit 1 ;;
  *) echo "unexpected gh request: $2" >&2; exit 1 ;;
esac
`, { mode: 0o700 });
  const summaryPath = join(directory, 'summary.md'), resultPath = join(directory, 'result.json');
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'src/rule-workflow.ts'], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RULE_TEST_CONFIGURATION: response,
      RULE_EVENT_NAME: 'schedule', RULE_TARGET: 'main', RULE_CONFIG_BRANCH: 'main', RULE_UPDATE_ENABLED: 'true', RULE_CLEANUP_ENABLED: 'false',
      RULE_RESULT_PATH: resultPath, GITHUB_STEP_SUMMARY: summaryPath, SING_BOX_BINARY: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
  }), { code: 1 });
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.event, 'schedule');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results.map((row: { operation: string }) => row.operation), ['schedule-preflight']);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].configurationRevision, configuration.revision);
  assert.match(result.results[0].error, /journal is unreadable/);
  assert.equal(result.results[0].verified, undefined);
  const summary = await readFile(summaryPath, 'utf8');
  const report = summary.split('```json\n')[1].split('\n```')[0];
  assert.deepEqual(JSON.parse(report), result.results[0]);
  assert.match(summary, /Overall result: failed/);
});
