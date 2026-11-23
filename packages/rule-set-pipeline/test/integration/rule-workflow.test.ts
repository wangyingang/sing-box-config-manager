import assert from 'node:assert/strict';
import test from 'node:test';
import { runRuleAutomation, runRuleWorkflow } from '../../src/rule-workflow.js';
import type { readSchedulePreflight } from '../../src/rules-status.js';
import type { RulesResult } from '../../src/rules-model.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;

test('自动编排沿用固定与恢复控制，续做清理后才访问上游，部分失败保留成功交付', {
  skip: !binary, timeout: 120_000,
}, async () => {
  const env = cleanupEnvironment(binary!, 'acceptance-issue-86');
  async function automatic(event: 'push' | 'schedule') {
    const results: (RulesResult | Awaited<ReturnType<typeof readSchedulePreflight>>)[] = [];
    const code = await runRuleAutomation({ event, target: env.context.targetBranch }, text => results.push(JSON.parse(text)), env.context);
    return { code, results };
  }
  async function manual(operation: string, id?: string, version?: string) {
    let result: RulesResult | undefined;
    const code = await runRuleWorkflow({ operation, target: env.context.targetBranch, id, version },
      text => { result = JSON.parse(text); }, env.context);
    assert.equal(code, 0, JSON.stringify(result));
    return result!;
  }
  const first = await automatic('push');
  assert.equal(first.code, 0, JSON.stringify(first));
  assert.deepEqual(first.results.map(result => result.operation), ['sync']);
  const pushedSync = first.results[0];
  assert.ok(pushedSync.operation === 'sync');
  const original = pushedSync.results.find(row => row.id === 'openai')!.current!.versionId!;
  await manual('pin', 'openai', original);
  env.upstream({ openai: 'domain:automatic-new.example', anthropic: 'domain:automatic-anthropic.example' });
  const daily = await automatic('schedule');
  assert.equal(daily.code, 0, JSON.stringify(daily));
  assert.deepEqual(daily.results.map(result => result.operation), ['schedule-preflight', 'sync', 'cleanup']);
  const sync = daily.results[1];
  assert.ok(sync.operation === 'sync');
  const pinned = sync.results.find(row => row.id === 'openai')!;
  assert.equal(pinned.status, 'pinned-skipped');
  assert.equal(pinned.current!.versionId, original);
  assert.equal(sync.results.find(row => row.id === 'anthropic')!.status, 'delivered');
  const resumed = await manual('resume', 'openai');
  assert.equal(resumed.results[0].control!.mode, 'auto');
  assert.notEqual(resumed.results[0].current!.versionId, original);

  env.clock('2026-12-17T00:00:00.000Z');
  env.failStage(() => { throw new Error('Simulated interrupted cleanup'); });
  let interrupted: RulesResult | undefined;
  assert.equal(await runRuleWorkflow({ operation: 'cleanup', target: env.context.targetBranch },
    text => { interrupted = JSON.parse(text); }, env.context), 1);
  assert.equal((await env.journal()).maintenance, 'maintenance', JSON.stringify(interrupted));
  const frozen = (await env.journal()).cleanupRun!.plan;
  assert.equal(frozen.discard.candidateIds.length, 2);
  env.failStage();
  const fetcher = env.context.fetch!;
  env.context.fetch = async (...args) => {
    assert.equal((await env.journal()).maintenance, 'open', 'Upstream processing must wait until maintenance recovery finishes');
    return fetcher(...args);
  };
  env.clock('2026-12-18T00:00:00.000Z');
  const recovered = await automatic('schedule');
  assert.equal(recovered.code, 0, JSON.stringify(recovered));
  assert.deepEqual(recovered.results.map(result => result.operation), ['schedule-preflight', 'cleanup', 'sync', 'cleanup']);
  assert.deepEqual(recovered.results[1].cleanup!.plan, frozen);
  assert.equal((await env.journal()).maintenance, 'open');

  const config = env.config();
  const dlc = config.sources.dlc; assert.equal(dlc.version, 'url');
  config.sources.failing = { ...dlc, input: { ...dlc.input, url: 'https://rules.example.test/failing/source/dlc.dat_plain.yml' } };
  config.ruleSets.find(rule => rule.id === 'anthropic')!.source = 'failing';
  env.configure(config);
  env.failSource('failing/source');
  env.upstream({ openai: 'domain:successful-peer.example' });
  const failed = await automatic('schedule');
  assert.equal(failed.code, 1, JSON.stringify(failed));
  assert.deepEqual(failed.results.map(result => result.operation), ['schedule-preflight', 'sync', 'cleanup']);
  const failedSync = failed.results[1];
  assert.ok(failedSync.operation === 'sync');
  assert.equal(failedSync.status, 'partial');
  assert.equal(failedSync.results.find(row => row.id === 'openai')!.status, 'delivered');
  assert.equal(failedSync.results.find(row => row.id === 'anthropic')!.status, 'failed');
  assert.equal(failed.results[2].status, 'success');
  assert.equal((await env.journal()).maintenance, 'open');

  env.failSource(false);
  const retry = await automatic('schedule');
  assert.equal(retry.code, 0, JSON.stringify(retry));
  const preflight = retry.results.find(result => result.operation === 'schedule-preflight')!;
  assert.equal(preflight.status, 'success');
  assert.equal(preflight.exitCode, 0);
  const observed = preflight.results.find(row => row.id === 'anthropic')!;
  assert.match(observed.lastFailure ?? '', /Upstream unavailable/);
  assert.ok(!('status' in observed));
});
