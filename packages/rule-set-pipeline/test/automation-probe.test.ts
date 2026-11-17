import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const commit = 'a'.repeat(40);
const branch = 'codex/reviewed-automation';

async function probe(t: test.TestContext, scenario: string, overrides: Record<string, string> = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'automation-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(`${directory}/bin`);
  await copyFile(new URL('./fixtures/automation-gh.mjs', import.meta.url), `${directory}/bin/gh`);
  await chmod(`${directory}/bin/gh`, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`,
    RULE_AUTOMATION_PROBE: '1', RULE_AUTOMATION_BRANCH: branch, RULE_AUTOMATION_COMMIT: commit,
    RULE_AUTOMATION_EVIDENCE: `${directory}/evidence`, AUTOMATION_FAKE_DIRECTORY: directory,
    AUTOMATION_FAKE_SCENARIO: scenario, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  const execution = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--test', 'test/acceptance/rules-automation.test.ts'],
    { cwd: resolve(import.meta.dirname, '..'), env, timeout: 30_000 }).then(
    result => ({ code: 0, output: result.stdout + result.stderr }),
    error => ({ code: error.code, output: error.stdout + error.stderr }));
  const state = await readFile(`${directory}/state.json`, 'utf8').then(JSON.parse, () => ({ requests: [] }));
  const evidence = await readFile(`${directory}/evidence/evidence.json`, 'utf8').then(JSON.parse, () => undefined);
  return { ...execution, state, evidence };
}

test('automation probe requires an explicit reviewed branch before any GitHub access', async t => {
  const result = await probe(t, 'unused', { RULE_AUTOMATION_BRANCH: '' });
  assert.equal(result.code, 1);
  assert.match(result.output, /RULE_AUTOMATION_BRANCH/);
  assert.deepEqual(result.state.requests, []);
});

test('automation probe rejects missing or abbreviated commit identities before GitHub access', async t => {
  for (const value of ['', 'abcdef0']) {
    const result = await probe(t, 'unused', { RULE_AUTOMATION_COMMIT: value });
    assert.equal(result.code, 1);
    assert.match(result.output, /RULE_AUTOMATION_COMMIT/);
    assert.deepEqual(result.state.requests, []);
  }
});

test('automation probe refuses a branch whose head differs from the reviewed commit without creating refs', async t => {
  const result = await probe(t, 'initial-head-moved');
  assert.equal(result.code, 1);
  assert.match(result.output, /Reviewed implementation branch moved/);
  assert.ok(!result.state.requests.some((request: { input?: unknown }) => request.input));
  assert.equal(result.evidence.passed, false);
  assert.deepEqual(result.evidence.before, result.evidence.after);
  assert.deepEqual(result.evidence.remaining, []);
});

test('automation probe stops when the reviewed branch moves during a run and cleans its isolated refs', async t => {
  const result = await probe(t, 'head-moved-during-run');
  assert.equal(result.code, 1);
  assert.match(result.output, /Reviewed implementation branch moved/);
  assert.ok(!result.state.requests.some((request: { args: string[] }) => request.args[1]?.endsWith('/dispatches')));
  assert.ok(!result.state.requests.some((request: { args: string[] }) => request.args[0] === 'run'));
  assert.deepEqual(result.state.refs, {});
  assert.deepEqual(result.evidence.cleanupErrors, []);
  assert.deepEqual(result.evidence.before, result.evidence.after);
});

test('automation probe rejects a mismatched push event SHA without waiting for a different run', async t => {
  const result = await probe(t, 'push-sha-mismatch');
  assert.equal(result.code, 1);
  assert.match(result.output, /Workflow run event SHA differs/);
  assert.deepEqual(result.state.refs, {});
});

test('automation probe rejects a dispatch that runs a different implementation SHA', async t => {
  const result = await probe(t, 'dispatch-sha-mismatch');
  assert.equal(result.code, 1);
  assert.match(result.output, /Workflow run event SHA differs/);
  assert.deepEqual(result.state.refs, {});
});

test('automation probe rejects an artifact from a different workflow SHA', async t => {
  const result = await probe(t, 'workflow-sha-mismatch');
  assert.equal(result.code, 1);
  assert.match(result.output, /Actual workflow SHA differs/);
  assert.deepEqual(result.state.refs, {});
});

test('automation probe rejects checkout code that differs from the expected implementation', async t => {
  const result = await probe(t, 'checkout-sha-mismatch');
  assert.equal(result.code, 1);
  assert.match(result.output, /Actual checkout SHA differs/);
  assert.deepEqual(result.state.refs, {});
});
