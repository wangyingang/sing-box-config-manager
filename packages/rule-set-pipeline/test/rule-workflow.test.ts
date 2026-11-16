import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(await runRuleWorkflow({ operation: 'check', target: env.context.targetBranch }, output => { text = output; }, env.context), 1);
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

function scenario(responses: { operation: string; status: string; exitCode: number; maintenance?: string;
  error?: string; results?: { status: string; error?: string }[] }[]) {
  const context = rulesEnvironment('/unused').context;
  const calls: string[] = [];
  const reports: unknown[] = [];
  const execute: NonNullable<Parameters<typeof runRuleAutomation>[3]> = async (request, report) => {
    calls.push(request.operation);
    const next = responses[calls.length - 1];
    assert.ok(next, `Unexpected operation ${request.operation}`);
    assert.equal(request.operation, next.operation);
    report(JSON.stringify({ target: { branch: context.targetBranch }, configurationRevision: 'current-config', ...next }));
    return next.exitCode;
  };
  return { context, calls, reports, run: (event: 'push' | 'schedule' = 'schedule') =>
    runRuleAutomation({ event, target: context.targetBranch }, text => reports.push(JSON.parse(text)), context, execute) };
}

const statusOpen = { operation: 'status', status: 'success', exitCode: 0, maintenance: 'open' };
const syncSuccess = { operation: 'sync', status: 'success', exitCode: 0, results: [{ status: 'unchanged' }, { status: 'pinned-skipped' }] };
const cleanupSuccess = { operation: 'cleanup', status: 'success', exitCode: 0 };

test('configuration push only synchronizes; daily sync and cleanup keep separate results', async () => {
  const pushed = scenario([syncSuccess]);
  assert.equal(await pushed.run('push'), 0);
  assert.deepEqual(pushed.calls, ['sync']);
  const daily = scenario([statusOpen, syncSuccess, cleanupSuccess]);
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['status', 'sync', 'cleanup']);
  assert.equal(daily.reports.length, 3);
});

test('daily recovers active maintenance before synchronizing and reports each stage', async () => {
  const daily = scenario([
    { ...statusOpen, status: 'pending', exitCode: 1, maintenance: 'maintenance' },
    cleanupSuccess, syncSuccess, cleanupSuccess,
  ]);
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['status', 'cleanup', 'sync', 'cleanup']);
});

test('disabled or unresolved maintenance cannot masquerade as recovered or start sync', async () => {
  for (const cleanup of [
    { ...cleanupSuccess, status: 'disabled', error: 'RULE_CLEANUP_ENABLED is false' },
    { ...cleanupSuccess, status: 'pending', exitCode: 1 },
  ]) {
    const daily = scenario([{ ...statusOpen, status: 'pending', exitCode: 1, maintenance: 'maintenance' }, cleanup]);
    assert.equal(await daily.run(), 1);
    assert.deepEqual(daily.calls, ['status', 'cleanup']);
  }
});

test('ordinary per-rule failure still permits cleanup and cannot be hidden by cleanup success', async () => {
  const daily = scenario([
    { ...statusOpen, status: 'failed', exitCode: 1, results: [{ status: 'failed', error: 'Previous upstream failure' }] },
    { ...syncSuccess, status: 'partial', exitCode: 1, results: [{ status: 'delivered' }, { status: 'failed', error: 'Upstream unavailable' }] },
    cleanupSuccess,
  ]);
  assert.equal(await daily.run(), 1);
  assert.deepEqual(daily.calls, ['status', 'sync', 'cleanup']);
  assert.equal((daily.reports[1] as { status: string }).status, 'partial');
});

test('shared pending, unverified state and concurrent configuration changes stop subsequent writes', async () => {
  for (const failed of [
    { ...syncSuccess, status: 'pending', exitCode: 1 },
    { ...syncSuccess, status: 'failed', exitCode: 1, error: 'Cannot verify current delivery' },
    { ...syncSuccess, status: 'partial', exitCode: 1, results: [{ status: 'superseded', error: 'RULE_INTENT_SUPERSEDED' }] },
    { ...syncSuccess, status: 'failed', exitCode: 1, results: [{ status: 'failed', error: 'RULE_WRITE_CONFLICT' }] },
  ]) {
    const daily = scenario([statusOpen, failed]);
    assert.equal(await daily.run(), 1);
    assert.deepEqual(daily.calls, ['status', 'sync']);
  }
  const unreadable = scenario([{ ...statusOpen, status: 'failed', exitCode: 1, error: 'RULE_STATE_MIGRATION_REQUIRED' }]);
  assert.equal(await unreadable.run(), 1);
  assert.deepEqual(unreadable.calls, ['status']);
});

test('disabled update does not prevent independently enabled cleanup', async () => {
  const daily = scenario([statusOpen, { ...syncSuccess, status: 'disabled', error: 'Not applied: updates disabled' }, cleanupSuccess]);
  daily.context.allowWrites = false;
  daily.context.allowCleanupWrites = true;
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['status', 'sync', 'cleanup']);
});

test('default-off automation reports disabled operations without reading old production state', async () => {
  const daily = scenario([
    { ...syncSuccess, status: 'disabled' },
    { ...cleanupSuccess, status: 'disabled' },
  ]);
  daily.context.allowWrites = false;
  daily.context.allowCleanupWrites = false;
  assert.equal(await daily.run(), 0);
  assert.deepEqual(daily.calls, ['sync', 'cleanup']);
  assert.ok(daily.reports.every(report => (report as { status: string; configurationRevision: string }).status === 'disabled'
    && (report as { configurationRevision: string }).configurationRevision === 'current-config'));
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
