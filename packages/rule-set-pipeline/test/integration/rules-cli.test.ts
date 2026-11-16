import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { runRulesCli } from '../../src/cli.js';
import { runRuleWorkflow } from '../../src/rule-workflow.js';
import { getRulesStatus, cleanupRuleHistory } from '../../src/index.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
test('五个 CLI 操作使用同一服务：预览零写入，pin/resume 和 Action 结果与实际交付一致', { skip: !binary }, async t => {
  const env = cleanupEnvironment(binary!);
  async function run(...args: string[]) {
    let output = '';
    const code = await runRulesCli([...args, '--json'], text => { output = text; }, env.context);
    return { code, result: JSON.parse(output) };
  }
  const preview = await run('sync', '--dry-run');
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(env.writes.length, 0);
  const first = await run('sync');
  assert.equal(first.code, 0, JSON.stringify(first.result));
  const version = first.result.results.find((entry: { id: string }) => entry.id === 'openai').current.versionId;
  const beforePreview = env.writes.length;
  assert.equal((await run('pin', 'openai', version, '--dry-run')).code, 0);
  assert.equal((await run('resume', 'openai', '--dry-run')).code, 0);
  assert.equal(env.writes.length, beforePreview);
  const pinned = await run('pin', 'openai', version);
  assert.equal(pinned.code, 0, JSON.stringify(pinned.result));
  assert.equal(pinned.result.results[0].control.mode, 'pinned');
  env.upstream({ openai: 'domain:cli-new.example' });
  const resumed = await run('resume', 'openai');
  assert.equal(resumed.code, 0, JSON.stringify(resumed.result));
  assert.equal(resumed.result.results[0].control.mode, 'auto');
  assert.notEqual(resumed.result.results[0].current.versionId, version);
  const status = await run('status', 'openai');
  const api = await getRulesStatus({ context: env.context, id: 'openai' });
  assert.deepEqual(status.result, JSON.parse(JSON.stringify(api)));
  let actionOutput = '';
  assert.equal(await runRuleWorkflow({ operation: 'sync', target: env.context.targetBranch }, text => { actionOutput = text; }, env.context), 0);
  assert.ok(JSON.parse(actionOutput).results.every((entry: { status: string }) => entry.status === 'unchanged'));
  const beforeCleanup = { writes: env.writes.length, stages: env.stageWrites.length,
    refs: env.refWrites.length, upstream: env.requests.length };
  const cleanup = await run('cleanup', '--dry-run');
  assert.equal(cleanup.code, 0, JSON.stringify(cleanup.result));
  const apiCleanup = await cleanupRuleHistory({ context: env.context, dryRun: true });
  assert.deepEqual(cleanup.result, JSON.parse(JSON.stringify(apiCleanup)));
  assert.ok(cleanup.result.cleanup.plan.retain.candidateIds.length >= 2);
  assert.equal(await runRuleWorkflow({ operation: 'cleanup', dryRun: true, target: env.context.targetBranch },
    text => { actionOutput = text; }, env.context), 0);
  assert.deepEqual(JSON.parse(actionOutput), cleanup.result);
  assert.deepEqual({ writes: env.writes.length, stages: env.stageWrites.length,
    refs: env.refWrites.length, upstream: env.requests.length }, beforeCleanup);
  const draftDirectory = await mkdtemp(join(tmpdir(), 'rules-cli-draft-'));
  t.after(() => rm(draftDirectory, { recursive: true, force: true }));
  const config = env.config();
  config.ruleSets = [];
  config.sources = {} as typeof config.sources;
  const path = join(draftDirectory, 'rules.yml');
  await writeFile(path, stringify(config));
  const beforeDraft = env.writes.length;
  const deleted = await run('sync', '--dry-run', '--config', path);
  assert.equal(deleted.code, 0, JSON.stringify(deleted.result));
  assert.equal(deleted.result.configurationOrigin, 'local-draft');
  assert.ok(deleted.result.results.every((entry: { changes: string[] }) => entry.changes.includes('delete-stable-entry')));
  assert.equal(env.writes.length, beforeDraft);
});
