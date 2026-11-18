import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { syncRules, pinRuleVersion } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { RULE_STATE_PATH, type RulesResult } from '../../src/rules-model.js';
import { cleanupEnvironment, fourSetCleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const success = <T extends RulesResult>(result: T) => { assert.equal(result.status, 'success', JSON.stringify(result)); return result; };
const barrier = () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
};

for (const target of ['acceptance-cleanup-guards', 'main']) {
  test(`${target}: 未归属稳定文件阻塞直接 cleanup，文件及当前交付原样保留`, async () => {
    const env = cleanupEnvironment(binary!, target), input = { context: env.context };
    success(await syncRules(input));
    const repository = env.context.repository;
    const stable = await repository.snapshot(target);
    const path = 'stable/untracked/rules.srs', bytes = Buffer.from('untracked stable bytes');
    await repository.commit(target, stable.head, { [path]: bytes }, 'External writer', async () => {});
    const status = success(await getRulesStatus(input));
    const heads = new Map(env.heads), writes = env.writes.length, refs = await env.refs.list();
    for (const dryRun of [true, false]) {
      const result = await cleanupRuleHistory({ ...input, dryRun });
      assert.equal(result.status, 'pending', JSON.stringify(result));
      assert.ok(result.cleanup?.plan.blockers.includes(`Unidentified stable file: ${path}`));
      assert.deepEqual(await (await repository.snapshot(target)).read(path), bytes);
      assert.deepEqual((await getRulesStatus(input)).rules, status.rules);
      assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
      assert.deepEqual(await env.refs.list(), refs); assert.equal(env.stageWrites.length, 0);
    }
  });

  test(`${target}: 有效未决 CIDR 交付阻塞直接 cleanup，sync 回读恢复后才可清理`, async () => {
    const env = fourSetCleanupEnvironment(binary!, target), input = { context: env.context };
    const first = success(await syncRules(input));
    env.changeCidr('198.51.100.0/24\n2001:db8:2::/48\n');
    env.failDownload(url => { if (url.includes('/stable/china-ip/')) throw new Error('Stable HTTPS offline'); });
    assert.equal((await syncRules(input)).status, 'pending');
    const pending = (await env.journal()).pendingDelivery!; assert.equal(pending.logicalId, 'china-ip');
    const status = await getRulesStatus(input);
    assert.equal(status.status, 'pending');
    assert.notEqual(status.rules?.find(rule => rule.id === 'china-ip')?.current?.candidateId, first.results[3].current?.candidateId);
    const heads = new Map(env.heads), writes = env.writes.length;
    for (const dryRun of [true, false]) {
      const blocked = await cleanupRuleHistory({ ...input, dryRun });
      assert.equal(blocked.status, 'pending', JSON.stringify(blocked));
      assert.ok(blocked.cleanup?.plan.blockers.some(item => item.includes(`Unresolved delivery ${pending.id}`)));
      assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes); assert.equal(env.stageWrites.length, 0);
    }
    env.failDownload();
    success(await syncRules({ context: { ...env.context } }));
    assert.equal((await env.journal()).pendingDelivery, undefined);
    assert.equal(env.writes.slice(writes).filter(write => Object.keys(write.files).some(path => path.startsWith('stable/'))).length, 0,
      'Reconciliation must not repeat the applied stable write');
    success(await cleanupRuleHistory(input));
    assert.equal((await getRulesStatus(input)).rules?.find(rule => rule.id === 'china-ip')?.current?.candidateId, pending.record?.candidateId);
  });

  test(`${target}: 旧 pin 回读跨越较新 pin 和 cleanup，迟到会话不覆盖新事实`, { timeout: 90_000 }, async () => {
    const env = cleanupEnvironment(binary!, target), input = { context: env.context };
    const first = success(await syncRules(input)).results[0].current!;
    env.upstream({ openai: 'domain:new-current.example' });
    const latest = success(await syncRules(input)).results[0].current!;
    const reached = barrier(), resume = barrier();
    const repository = env.context.repository, download = repository.download;
    let stalled = false;
    const oldContext = { ...env.context, repository: { ...repository, async download(url: string) {
      if (!stalled && url.includes('/stable/openai/')) { stalled = true; reached.release(); await resume.waiting; }
      return download(url);
    } } };
    const oldPin = pinRuleVersion({ context: oldContext, id: 'openai', version: first.versionId! });
    try {
      await Promise.race([reached.waiting, oldPin.then(result => { throw new Error(`Pin ended before readback barrier: ${result.status}`); })]);
      success(await pinRuleVersion({ ...input, id: 'openai', version: latest.versionId! }));
      success(await cleanupRuleHistory(input));
      const after = success(await getRulesStatus(input));
      const heads = new Map(env.heads), writes = env.writes.length, journal = await env.journal();
      const snapshot = await repository.snapshot(target);
      const stable = new Map(await Promise.all(snapshot.paths.filter(path => path.startsWith('stable/'))
        .map(async path => [path, await snapshot.read(path)] as const)));
      resume.release();
      const late = await oldPin;
      assert.notEqual(late.status, 'success', JSON.stringify(late));
      assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
      assert.deepEqual(await env.journal(), journal);
      assert.deepEqual((await getRulesStatus(input)).rules, after.rules);
      assert.equal(after.rules?.[0].current?.versionId, latest.versionId);
      for (const [path, bytes] of stable) assert.deepEqual(await (await repository.snapshot(target)).read(path), bytes);
    } finally { resume.release(); await oldPin; }
  });

  test(`${target}: sync 在上游等待时 cleanup 改变代次，旧会话不发布或覆盖清理结果`, { timeout: 90_000 }, async () => {
    const env = cleanupEnvironment(binary!, target), input = { context: env.context };
    success(await syncRules(input)); env.upstream({ openai: 'domain:stale.example' });
    const reached = barrier(), resume = barrier(), fetcher = env.context.fetch!;
    let stalled = false;
    const oldSync = syncRules({ context: { ...env.context, fetch: async (url, init) => {
      if (!stalled) { stalled = true; reached.release(); await resume.waiting; }
      return fetcher(url, init);
    } } });
    try {
      await Promise.race([reached.waiting, oldSync.then(result => { throw new Error(`Sync ended before upstream barrier: ${result.status}`); })]);
      success(await cleanupRuleHistory(input));
      const heads = new Map(env.heads), writes = env.writes.length, journal = await env.journal();
      resume.release();
      assert.notEqual((await oldSync).status, 'success');
      assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
      assert.deepEqual(await env.journal(), journal);
    } finally { resume.release(); await oldSync; }
  });

  test(`${target}: 隔离回复丢失、切换拒绝、核验检查点断线及临时引用删除失败均可续做`, { timeout: 90_000 }, async () => {
    const env = cleanupEnvironment(binary!, target), input = { context: env.context };
    success(await syncRules(input));
    const repository = env.context.repository, commit = repository.commit, snapshot = repository.snapshot;
    let fault: 'isolation' | 'checkpoint' | undefined = 'isolation', offline = false;
    repository.snapshot = async (...args) => { if (offline) throw new Error('Checkpoint connection lost'); return snapshot(...args); };
    repository.commit = async (...args) => {
      const head = await commit(...args);
      const state = args[2][RULE_STATE_PATH];
      const journal = state && JSON.parse(state.toString());
      if (fault === 'isolation' && journal?.cleanupRun?.phase === 'isolated' || fault === 'checkpoint' && journal?.cleanupCheckpoint) {
        fault = undefined; offline = true; throw new PublicationWriteError(head, 'Checkpoint response lost');
      }
      return head;
    };
    assert.notEqual((await cleanupRuleHistory(input)).status, 'success'); offline = false;
    const run = (await env.journal()).cleanupRun!; assert.ok(run);
    const stableBefore = await repository.snapshot(target);
    env.beforeRefs(changes => { if (changes.some(change => change.after && change.ref === `refs/heads/${target}`)) throw new Error('Atomic push rejected'); });
    const rejected = await cleanupRuleHistory(input); assert.equal(rejected.status, 'pending', JSON.stringify(rejected));
    assert.match(rejected.error!, /Atomic push rejected/);
    assert.equal((await env.journal()).maintenance, 'maintenance');
    assert.equal(env.refWrites.length, 0);
    for (const path of stableBefore.paths.filter(path => path.startsWith('stable/'))) {
      assert.deepEqual(await (await repository.snapshot(target)).read(path), await stableBefore.read(path));
    }
    env.beforeRefs(); fault = 'checkpoint';
    assert.notEqual((await cleanupRuleHistory(input)).status, 'success'); offline = false;
    assert.ok((await env.journal()).cleanupCheckpoint);
    env.failDownload(() => { throw new Error('Checkpoint must avoid repeated readback'); });
    env.beforeRefs(changes => { if (changes.every(change => !change.after)) throw new Error('Temporary ref deletion interrupted'); });
    const interrupted = await cleanupRuleHistory(input);
    assert.equal(interrupted.status, 'pending', JSON.stringify(interrupted)); assert.match(interrupted.error!, /Temporary ref deletion interrupted/);
    assert.equal((await env.journal()).maintenance, 'maintenance');
    env.beforeRefs(); env.failDownload();
    const completed = success(await cleanupRuleHistory(input));
    assert.equal(completed.cleanup?.maintenanceId, run.id); assert.deepEqual(completed.cleanup?.plan, run.plan);
    assert.equal(env.refWrites.filter(changes => changes.some(change => change.after && change.ref === `refs/heads/${target}`)).length, 1);
    assert.ok(!(await env.refs.list()).some(({ ref }) => ref.startsWith('refs/heads/maintenance-')));
    assert.equal((await env.journal()).maintenance, 'open');
  });
}

for (const stage of ['files', 'metadata', 'evidence'] as const) test(`${stage} 在途候选阻塞直接 cleanup，原登记和文件不变`, async () => {
  const env = cleanupEnvironment(binary!), input = { context: env.context };
  success(await syncRules(input)); env.upstream({ openai: 'domain:interrupted.example' });
  env.beforeWrite(async files => {
    const paths = Object.keys(files);
    const stop = stage === 'files' ? paths.some(path => path.endsWith('/domains.json'))
      : stage === 'metadata' ? paths.some(path => path.endsWith('/manifest.json')) : paths.some(path => path.endsWith('/readback.json'));
    if (stop) throw new Error('RULE_WRITE_CONFLICT: interrupted candidate stage');
  });
  assert.notEqual((await syncRules(input)).status, 'success'); env.beforeWrite();
  const journal = await env.journal(), heads = new Map(env.heads), writes = env.writes.length;
  assert.ok(Object.values(journal.candidates).some(candidate => candidate.status !== 'verified'));
  const result = await cleanupRuleHistory(input);
  assert.equal(result.status, 'pending', JSON.stringify(result)); assert.ok(result.cleanup?.plan.blockers.length);
  assert.deepEqual(await env.journal(), journal); assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
  assert.equal(env.stageWrites.length, 0);
});

for (const target of ['acceptance-cleanup-conflict', 'main']) test(`${target}: 新基线 HTTPS 失败不切换，外部 head 改变后原计划保持隔离`, async () => {
  const env = cleanupEnvironment(binary!, target), input = { context: env.context };
  success(await syncRules(input));
  const before = new Map(env.heads), writesBefore = env.writes.length;
  const missingTool = await cleanupRuleHistory({ context: { ...env.context, binary: undefined } });
  assert.notEqual(missingTool.status, 'success');
  assert.deepEqual(env.heads, before); assert.equal(env.writes.length, writesBefore); assert.equal(env.stageWrites.length, 0);
  env.failDownload(url => {
    const ref = new URL(url).pathname.split('/')[3];
    if (env.stageWrites.some(branch => branch.endsWith('-files') && env.heads.get(branch) === ref) && url.endsWith('.srs')) throw new Error('New baseline HTTPS unavailable');
  });
  const failed = await cleanupRuleHistory(input);
  assert.equal(failed.status, 'pending', JSON.stringify(failed)); assert.match(failed.error!, /New baseline HTTPS unavailable/);
  assert.equal(env.refWrites.length, 0);
  const run = (await env.journal()).cleanupRun!;
  assert.ok(run); assert.equal((await env.journal()).maintenance, 'maintenance');
  if (target === 'main') assert.equal(env.heads.get(target), before.get(target));
  env.failDownload();
  const repository = env.context.repository, snapshot = await repository.snapshot(target);
  await repository.commit(target, snapshot.head, { 'README.external': Buffer.from('newer external fact') }, 'External writer', async () => {});
  const heads = new Map(env.heads), writes = env.writes.length;
  const conflict = await cleanupRuleHistory(input);
  assert.notEqual(conflict.status, 'success', JSON.stringify(conflict));
  assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes); assert.equal(env.refWrites.length, 0);
  assert.equal((await env.journal()).cleanupRun?.id, run.id);
  assert.equal((await env.journal()).maintenance, 'maintenance');
});
