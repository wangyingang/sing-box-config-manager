import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { encodeRecord, RULE_STATE_PATH, type RulesResult } from '../../src/rules-model.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const success = (result: RulesResult) => { assert.equal(result.status, 'success', JSON.stringify(result)); return result; };
type Environment = ReturnType<typeof cleanupEnvironment>;
const request = (env: Environment) => ({ context: env.context });
const current = (result: RulesResult, id = 'openai') => result.results.find(rule => rule.id === id)!.current!;

async function stableBytes(env: Environment) {
  const snapshot = await env.context.repository.snapshot(env.context.targetBranch);
  return Object.fromEntries(await Promise.all(snapshot.paths.filter(path => path.startsWith('stable/') && !path.endsWith('/activation.json'))
    .map(async path => [path, await snapshot.read(path)])));
}

async function retainedFixture(target: string) {
  const env = cleanupEnvironment(binary!, target);
  env.clock('2026-09-01T00:00:00.000Z');
  const first = success(await syncRules(request(env)));
  const expired = current(first);
  const pinned = current(first, 'anthropic');
  success(await pinRuleVersion({ ...request(env), id: 'anthropic', version: pinned.versionId! }));
  env.clock('2026-10-17T00:00:00.000Z');
  env.upstream({ openai: 'domain:boundary.example' });
  const boundary = current(success(await syncRules(request(env))));
  env.clock('2026-11-01T00:00:00.000Z');
  env.upstream({ openai: 'domain:recent.example' });
  const recent = current(success(await syncRules(request(env))));
  env.clock('2026-11-16T00:00:00.000Z');
  env.upstream({ openai: 'domain:current.example' });
  const latest = current(success(await syncRules(request(env))));
  return { env, expired, pinned, boundary, recent, latest };
}

for (const target of ['acceptance-issue-85', 'main']) {
  test(`${target}: 按首次发布时间保留多版本，两轮清理后旧历史不可用仍可查询和 pin`, { skip: !binary, timeout: 120_000 }, async () => {
    const { env, expired, pinned, boundary, recent, latest } = await retainedFixture(target);
    const beforeBytes = await stableBytes(env);
    const beforeJournal = await env.journal();
    const oldHeads = new Set(env.trees.keys());
    env.heads.set('unrelated-work', env.heads.get(env.context.repository.branch)!);
    env.heads.set('refs/tags/unrelated-tag', env.heads.get(env.context.repository.branch)!);
    const unknownHead = env.heads.get('unrelated-work');
    const writes = env.writes.length, upstream = env.requests.length;
    const refs = await env.refs.list();
    const preview = success(await cleanupRuleHistory({ ...request(env), dryRun: true }));
    assert.equal(preview.cleanup?.phase, 'preview');
    assert.equal(preview.cleanup?.plan.candidateRetentionDays, 30);
    assert.equal(preview.cleanup?.plan.cutoff, '2026-10-17T00:00:00.000Z');
    assert.deepEqual(preview.cleanup?.plan.discard.candidateIds, [expired.candidateId]);
    assert.deepEqual(new Set(preview.cleanup?.plan.retain.candidateIds), new Set([pinned, boundary, recent, latest].map(version => version.candidateId)));
    assert.ok(preview.cleanup!.plan.retainedBytes > 0);
    assert.ok(preview.cleanup!.plan.otherRefs.some(ref => ref.ref === 'refs/heads/unrelated-work'));
    assert.ok(preview.cleanup!.plan.otherRefs.some(ref => ref.ref === 'refs/tags/unrelated-tag'));
    assert.equal(env.writes.length, writes); assert.equal(env.stageWrites.length, 0); assert.equal(env.refWrites.length, 0);
    assert.deepEqual(await env.refs.list(), refs);

    const cleaned = success(await cleanupRuleHistory(request(env)));
    assert.equal(cleaned.cleanup?.phase, 'completed');
    assert.deepEqual(await stableBytes(env), beforeBytes);
    assert.equal(env.requests.length, upstream, 'cleanup must not fetch any upstream input');
    assert.equal(env.heads.get('unrelated-work'), unknownHead);
    assert.equal(env.heads.get('refs/tags/unrelated-tag'), unknownHead);
    assert.ok(![...env.heads.keys()].some(ref => ref.startsWith('maintenance-')));
    for (const head of env.reachable()) assert.ok(!oldHeads.has(head), `Journal still reaches old history: ${head}`);
    for (const head of env.reachable(target)) assert.ok(!oldHeads.has(head), `Stable branch still reaches old history: ${head}`);
    oldHeads.forEach(head => env.blockedHeads.add(head));
    const after = await getRulesStatus(request(env)); success(after);
    assert.equal(after.rules?.find(rule => rule.id === 'openai')?.current?.candidateId, latest.candidateId);
    assert.equal(after.rules?.find(rule => rule.id === 'anthropic')?.current?.candidateId, pinned.candidateId);
    assert.deepEqual(after.rules?.find(rule => rule.id === 'anthropic')?.control, beforeJournal.rules.anthropic.control);
    const kept = await env.journal();
    for (const version of [pinned, boundary, recent, latest]) {
      assert.equal(kept.candidates[version.candidateId].versionId, version.versionId);
      assert.equal(kept.candidates[version.candidateId].publishedAt, version.publishedAt);
    }
    assert.ok(!kept.candidates[expired.candidateId]);
    assert.ok(after.rules?.find(rule => rule.id === 'openai')?.candidates.every(candidate => candidate.selectable));
    const untouched = { heads: new Map(env.heads), stages: env.stageWrites.length, writes: env.writes.length };
    assert.equal(success(await cleanupRuleHistory(request(env))).cleanup?.phase, 'unchanged');
    assert.deepEqual(env.heads, untouched.heads); assert.equal(env.stageWrites.length, untouched.stages); assert.equal(env.writes.length, untouched.writes);

    const selected = success(await pinRuleVersion({ ...request(env), id: 'openai', version: boundary.versionId! }));
    assert.equal(current(selected).candidateId, boundary.candidateId);
    const secondBytes = await stableBytes(env);
    env.clock('2026-11-17T00:00:00.000Z');
    const secondHistory = new Set(env.reachable());
    env.reachable(target).forEach(head => secondHistory.add(head));
    success(await cleanupRuleHistory(request(env)));
    secondHistory.forEach(head => env.blockedHeads.add(head));
    assert.deepEqual(await stableBytes(env), secondBytes);
    const second = await getRulesStatus(request(env)); success(second);
    assert.equal(second.rules?.find(rule => rule.id === 'openai')?.current?.candidateId, boundary.candidateId);
    for (const version of [pinned, boundary, recent, latest]) {
      const retained = (await env.journal()).candidates[version.candidateId];
      assert.equal(retained.versionId, version.versionId); assert.equal(retained.publishedAt, version.publishedAt);
    }
    success(await pinRuleVersion({ ...request(env), id: 'openai', version: latest.versionId! }));
    env.clock('2026-12-18T00:00:00.000Z');
    const aged = success(await cleanupRuleHistory({ ...request(env), dryRun: true }));
    assert.ok(aged.cleanup?.plan.discard.candidateIds.includes(boundary.candidateId), 'Leaving current must not restart candidate age');
  });
}

for (const phase of ['before-switch', 'after-switch'] as const) {
  test(`${phase}: 一个 cleanup 恢复同一维护计划，跨日及保留期变更不扩大删除集合`, { skip: !binary, timeout: 90_000 }, async () => {
    const { env, boundary, latest } = await retainedFixture(phase === 'before-switch' ? 'acceptance-issue-85-recovery' : 'main');
    const stable = await stableBytes(env);
    let interrupted = false;
    if (phase === 'before-switch') {
      env.failStage(ref => { if (ref.endsWith('-journal')) { interrupted = true; throw new Error('Interrupted before baseline journal'); } });
    } else {
      env.afterRefs(changes => {
        if (changes.some(change => change.ref === `refs/heads/${env.context.repository.branch}` && change.after)) throw new Error('Switch reply lost');
      });
      env.failDownload(url => {
        const ref = new URL(url).pathname.split('/')[3];
        if (ref === env.context.targetBranch && url.endsWith('.srs')) { interrupted = true; throw new Error('Interrupted stable readback'); }
      });
    }
    const failed = await cleanupRuleHistory(request(env));
    assert.ok(interrupted, JSON.stringify(failed)); assert.notEqual(failed.status, 'success', JSON.stringify(failed));
    assert.equal(failed.cleanup?.continueWith, 'cleanup');
    assert.equal((await env.journal()).maintenance, 'maintenance');
    assert.deepEqual(await stableBytes(env), stable);
    const plan = failed.cleanup!.plan;
    const id = failed.cleanup!.maintenanceId;
    const writes = env.writes.length;
    env.upstream({ openai: 'domain:blocked-by-maintenance.example' });
    assert.notEqual((await syncRules(request(env))).status, 'success');
    assert.notEqual((await pinRuleVersion({ ...request(env), id: 'openai', version: latest.versionId! })).status, 'success');
    assert.notEqual((await resumeRuleUpdates({ ...request(env), id: 'anthropic' })).status, 'success');
    assert.equal(env.writes.length, writes, 'Rule operations may not write through maintenance isolation');
    env.clock('2026-12-31T00:00:00.000Z');
    const configuration = env.config(); configuration.candidateRetentionDays = 1; env.configure(configuration);
    const heads = new Map(env.heads), stages = env.stageWrites.length, transactions = env.refWrites.length;
    const preview = await cleanupRuleHistory({ ...request(env), dryRun: true });
    assert.deepEqual(preview.cleanup?.plan, plan); assert.equal(preview.cleanup?.maintenanceId, id);
    assert.deepEqual(env.heads, heads); assert.equal(env.stageWrites.length, stages); assert.equal(env.refWrites.length, transactions);
    env.failStage(); env.failDownload(); env.afterRefs();
    const recovered = success(await cleanupRuleHistory(request(env)));
    assert.equal(recovered.cleanup?.maintenanceId, id); assert.deepEqual(recovered.cleanup?.plan, plan);
    assert.equal((await env.journal()).candidates[boundary.candidateId].publishedAt, boundary.publishedAt);
    assert.equal((await env.journal()).maintenance, 'open');
    assert.deepEqual(await stableBytes(env), stable);
    assert.equal(env.refWrites.filter(changes => changes.some(change => change.ref === `refs/heads/${env.context.repository.branch}`)).length, 1,
      'A resumed cleanup must not switch a second baseline');
  });
}

test('换源失败的旧交付按当前版本保护，未知发布时间及未完成候选阻塞年龄清理', { skip: !binary, timeout: 90_000 }, async () => {
  const { env, expired, latest } = await retainedFixture('acceptance-issue-85-pending');
  const configuration = env.config();
  configuration.sources.other = { ...configuration.sources.dlc, repository: 'failing/source' };
  configuration.ruleSets[0].source = 'other'; env.configure(configuration); env.failSource('failing/source');
  assert.equal((await syncRules(request(env))).status, 'partial');
  env.clock('2027-01-01T00:00:00.000Z');
  const preview = success(await cleanupRuleHistory({ ...request(env), dryRun: true }));
  assert.ok(preview.cleanup?.plan.retain.candidateIds.includes(latest.candidateId));
  assert.ok(preview.cleanup?.plan.discard.candidateIds.includes(expired.candidateId));
  const journal = await env.journal();
  const old = journal.candidates[expired.candidateId];
  delete old.publishedAt; delete old.versionId; old.migrationPending = 'Original publication time unavailable';
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  const writes = env.writes.length, heads = new Map(env.heads);
  const unknown = await cleanupRuleHistory(request(env));
  assert.notEqual(unknown.status, 'success'); assert.ok(unknown.cleanup?.plan.blockers.length);
  assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes); assert.equal(env.stageWrites.length, 0);
  delete old.migrationPending; old.status = 'publishing';
  const owner = journal.rules[old.logicalId];
  old.controlRevision = owner.control.revision; old.definitionGeneration = owner.generation;
  old.definition = owner.definition; old.sourceInput = owner.source; old.inputBindingRevision = owner.inputBindingRevision;
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  const incomplete = await cleanupRuleHistory(request(env));
  assert.notEqual(incomplete.status, 'success'); assert.ok(incomplete.cleanup?.plan.blockers.length);
  assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
});

test('被新控制明确取代的在途候选可回收，未知控制记录不会授权删除其他 refs', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!);
  const first = success(await syncRules(request(env)));
  const original = current(first);
  env.upstream({ openai: 'domain:next.example' });
  success(await syncRules(request(env)));
  const journal = await env.journal();
  const abandoned = journal.candidates[original.candidateId];
  abandoned.status = 'publishing'; delete abandoned.versionId; delete abandoned.publishedAt;
  abandoned.controlRevision = '00000000-0000-0000-0000-000000000000';
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  const result = success(await cleanupRuleHistory(request(env)));
  assert.ok(result.cleanup?.plan.decisions.some(item => item.candidateId === abandoned.id
    && item.action === 'discard' && item.reasons.includes('invalidated-operation')));
  assert.ok(!(await env.journal()).candidates[abandoned.id]);
  const writes = env.writes.length;
  assert.equal((await cleanupRuleHistory({ ...request(env), dryRun: true, draft: 'schemaVersion: 3' })).status, 'failed');
  assert.equal(env.writes.length, writes);
  const corrupt = await env.journal();
  corrupt.maintenance = 'maintenance';
  corrupt.cleanupCheckpoint = { id: result.cleanup!.maintenanceId!, plan: result.cleanup!.plan,
    stableHead: env.heads.get(env.context.targetBranch)!, verifiedAt: '2026-11-16T00:00:00.000Z',
    refs: { 'refs/heads/main': env.heads.get(env.context.targetBranch)! } };
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(corrupt));
  const refs = await env.refs.list(), count = env.refWrites.length;
  const refused = await cleanupRuleHistory(request(env));
  assert.equal(refused.status, 'failed'); assert.match(refused.error!, /RULE_STATE_CORRUPT/);
  assert.deepEqual(await env.refs.list(), refs); assert.equal(env.refWrites.length, count); assert.equal(env.writes.length, writes);
});
