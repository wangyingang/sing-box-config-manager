import { sha256 } from '../../src/release.js';
import { parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { runRuleAutomation } from '../../src/rule-workflow.js';
import { cleanupEnvironment, publishReplacementForCleanup } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
test('schedule 从登记的稳定交付恢复，失败与关闭更新门禁不进入 cleanup', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  assert.equal((await syncRules({ context: env.context })).status, 'success');
  env.upstream({ openai: 'domain:next.example' });
  env.failDownload(url => { if (url.includes('/stable/')) throw new Error('temporary HTTPS failure'); });
  assert.equal((await syncRules({ context: env.context })).status, 'pending');
  const pending = (await env.journal()).pendingDelivery!; assert.ok(pending);
  const stableWrites = env.writes.filter(write => write.branch === 'main').length;
  const reports: any[] = [];
  const run = (context = { ...env.context }) => runRuleAutomation({ event: 'schedule', target: 'main' }, text => reports.push(JSON.parse(text)), context);
  assert.equal(await run(), 1); assert.deepEqual(reports.map(row => row.operation), ['schedule-preflight', 'sync']);
  assert.equal(reports[0].continueWith, 'sync');
  assert.equal(reports[0].results[0].pendingOperation, pending.id);
  assert.equal((await env.journal()).pendingDelivery?.id, pending.id);
  reports.length = 0;
  assert.equal(await run({ ...env.context, allowWrites: false, allowCleanupWrites: true }), 1);
  assert.deepEqual(reports.map(row => row.operation), ['schedule-preflight', 'sync']);
  env.failDownload(); reports.length = 0;
  assert.equal(await run(), 0, JSON.stringify(reports));
  assert.deepEqual(reports.map(row => row.operation), ['schedule-preflight', 'sync', 'cleanup']);
  assert.equal((await env.journal()).pendingDelivery, undefined);
  assert.equal(env.writes.filter(write => write.branch === 'main').length, stableWrites);
  assert.equal((await getRulesStatus({ context: { ...env.context } })).rules?.[0].current?.candidateId, pending.record?.candidateId);
});

for (const target of ['acceptance-issue-90', 'main']) test(`${target}: building 检查点恢复原候选并解除真实清理阻塞`, { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, target);
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  env.beforeWrite(async files => {
    const bytes = files['pipeline/state.json'];
    if (bytes && Object.values(JSON.parse(bytes.toString()).candidates).some((candidate: any) => candidate.status === 'publishing')) {
      throw new Error('RULE_WRITE_CONFLICT: process stopped before publishing checkpoint');
    }
  });
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  const candidate = Object.values((await env.journal()).candidates)[0]; assert.equal(candidate.status, 'building');
  assert.equal(candidate.versionId, undefined); assert.equal(candidate.publishedAt, undefined);
  assert.equal((await cleanupRuleHistory({ context: env.context })).status, 'pending');
  env.beforeWrite(); env.clock('2026-11-17T00:00:00.000Z');
  const resumed = await syncRules({ context: { ...env.context } });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  const journal = await env.journal();
  assert.deepEqual(Object.keys(journal.candidates), [candidate.id]);
  assert.equal(journal.candidates[candidate.id].status, 'verified');
  assert.equal(journal.candidates[candidate.id].publishedAt, '2026-11-17T00:00:00.000Z');
  assert.equal(resumed.results[0].current?.candidateId, candidate.id);
  assert.ok((await getRulesStatus({ context: env.context })).rules?.[0].candidates[0].selectable);
  const cleaned = await cleanupRuleHistory({ context: { ...env.context } });
  assert.equal(cleaned.status, 'success', JSON.stringify(cleaned));
  assert.equal(cleaned.cleanup?.phase, 'unchanged');
  const identity = (await env.journal()).candidates[candidate.id];
  const count = env.writes.length;
  assert.equal((await syncRules({ context: { ...env.context } })).status, 'success');
  assert.equal((await cleanupRuleHistory({ context: { ...env.context } })).status, 'success');
  assert.equal(env.writes.length, count);
  assert.equal((await env.journal()).candidates[candidate.id].versionId, identity.versionId);
  assert.equal((await env.journal()).candidates[candidate.id].publishedAt, identity.publishedAt);
});

test('已有交付时离线上游只完成完整证据恢复，latest 失败保留当前版本', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  env.upstream({ openai: 'domain:second.example' });
  // The evidence commit contains the journal before the returned evidence
  // pointer/version checkpoint. Simulate process termination immediately after
  // that remote commit; do not manufacture a journal.
  const repository = env.context.repository, commit = repository.commit;
  repository.commit = async (...args) => {
    const head = await commit(...args);
    if (Object.keys(args[2]).some(path => path.endsWith('/readback.json'))) throw new Error('RULE_WRITE_CONFLICT: process stopped after evidence commit');
    return head;
  };
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  const before = await env.journal();
  const candidate = Object.values(before.candidates).find(candidate => candidate.status === 'publishing')!;
  assert.ok(candidate); assert.ok(candidate.versionId); assert.ok(candidate.publishedAt);
  const snapshot = await repository.snapshot();
  const evidence = JSON.parse((await snapshot.read(`candidates/${candidate.id}/readback.json`))!.toString());
  assert.ok(evidence.versionId); assert.ok(evidence.publishedAt);
  repository.commit = commit; env.failSource(true); env.requests.length = 0; env.clock('2026-11-18T00:00:00.000Z');
  const resumed = await syncRules({ context: { ...env.context } });
  assert.equal(resumed.status, 'failed', JSON.stringify(resumed));
  assert.match(resumed.results[0].error!, /Upstream unavailable/);
  assert.equal(env.requests.length, 1); assert.ok(env.requests[0].endsWith('/dlc.dat_plain.yml.sha256sum'));
  assert.deepEqual(resumed.results[0].current, first.results[0].current);
  assert.equal((await env.journal()).candidates[candidate.id].status, 'verified');
  assert.equal((await env.journal()).candidates[candidate.id].versionId, evidence.versionId);
  assert.equal((await env.journal()).candidates[candidate.id].publishedAt, evidence.publishedAt);
  env.failSource(false);
  const selected = await syncRules({ context: { ...env.context } });
  assert.equal(selected.status, 'success', JSON.stringify(selected));
  assert.equal(selected.results[0].current?.candidateId, candidate.id);
  assert.equal(selected.results[0].current?.versionId, evidence.versionId);
});

test('双分支同源两个 publishing 全部恢复原身份，不漏掉第二个规则', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  assert.equal((await syncRules({ context: env.context })).status, 'success');
  env.upstream({ openai: 'domain:new-openai.example', anthropic: 'domain:new-anthropic.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('temporary metadata outage'); });
  assert.equal((await syncRules({ context: env.context })).status, 'failed');
  const before = await env.journal();
  const pending = Object.values(before.candidates).filter(candidate => candidate.status === 'publishing');
  assert.equal(pending.length, 2); env.beforeWrite();
  const recovered = await syncRules({ context: { ...env.context } });
  assert.equal(recovered.status, 'success', JSON.stringify(recovered));
  const after = await env.journal();
  assert.equal(Object.keys(after.candidates).length, Object.keys(before.candidates).length);
  for (const candidate of pending) {
    assert.equal(after.candidates[candidate.id].status, 'verified');
    assert.equal(recovered.results.find(row => row.id === candidate.logicalId)?.current?.candidateId, candidate.id);
  }
  const clean = await cleanupRuleHistory({ context: { ...env.context } });
  assert.equal(clean.status, 'success', JSON.stringify(clean)); assert.equal(clean.cleanup?.phase, 'unchanged');
});

async function persistJournal(env: ReturnType<typeof cleanupEnvironment>, journal: Awaited<ReturnType<typeof env.journal>>) {
  const snapshot = await env.context.repository.snapshot();
  await env.context.repository.commit(env.context.repository.branch, snapshot.head,
    { 'pipeline/state.json': Buffer.from(JSON.stringify(journal)) }, '合法历史检查点样本', async () => {});
}

/** Baseline-equivalent historical state: the old sync ignored building and
 * skipped a second publishing record, allowing a replacement/current candidate
 * to succeed. Keep real interrupted candidates and their immutable stages, but
 * temporarily hide the incomplete index while producing that later delivery.
 * Recombining these schema-valid records models that baseline outcome without
 * retaining a second implementation of sync in the fixture.
 */
async function historicalResidues(env: ReturnType<typeof cleanupEnvironment>, currentInput?: string) {
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const residual = [];
  for (const stage of ['building', 'publishing']) {
    env.beforeWrite(async files => {
      if (stage === 'publishing' && Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata unavailable');
      const bytes = files['pipeline/state.json'];
      if (stage === 'building' && bytes && Object.values(JSON.parse(bytes.toString()).candidates).some((candidate: any) => candidate.status === 'publishing')) {
        throw new Error('RULE_WRITE_CONFLICT: publishing checkpoint interrupted');
      }
    });
    assert.notEqual((await syncRules({ context: env.context })).status, 'success');
    const journal = await env.journal(), candidate = Object.values(journal.candidates)[0];
    assert.equal(candidate.status, stage); residual.push(candidate); env.beforeWrite();
    delete journal.candidates[candidate.id]; await persistJournal(env, journal);
  }
  if (currentInput) env.upstream({ openai: currentInput });
  assert.equal((await syncRules({ context: env.context })).status, 'success');
  const journal = await env.journal();
  for (const candidate of residual) journal.candidates[candidate.id] = candidate;
  await persistJournal(env, journal);
  return residual;
}

test('历史同内容 building/publishing 全部收尾，unchanged 保持当前身份与字节且清理真正解除阻塞', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const residual = await historicalResidues(env);
  const before = await getRulesStatus({ context: env.context }), current = before.rules![0].current!;
  assert.equal(before.rules![0].candidates.filter(candidate => !candidate.selectable).length, 2);
  const writes = env.writes.length, refs = env.refWrites.length;
  await getRulesStatus({ context: { ...env.context } });
  await syncRules({ context: { ...env.context }, dryRun: true });
  await pinRuleVersion({ context: { ...env.context }, id: 'openai', version: current.versionId!, dryRun: true });
  await resumeRuleUpdates({ context: { ...env.context }, id: 'openai', dryRun: true });
  const preview = await cleanupRuleHistory({ context: { ...env.context }, dryRun: true });
  assert.equal(preview.status, 'pending'); assert.equal(env.writes.length, writes); assert.equal(env.refWrites.length, refs);
  const stableHead = env.heads.get('main');
  const resumed = await syncRules({ context: { ...env.context } });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].status, 'unchanged'); assert.deepEqual(resumed.results[0].current, current);
  assert.equal(env.heads.get('main'), stableHead, 'historical recovery must not transiently switch stable delivery');
  const after = await env.journal(); assert.equal(Object.keys(after.candidates).length, 3);
  for (const candidate of residual) {
    assert.equal(after.candidates[candidate.id].status, 'verified'); assert.equal(after.candidates[candidate.id].buildId, candidate.buildId);
    assert.deepEqual(after.candidates[candidate.id].source, candidate.source);
  }
  assert.equal((await getRulesStatus({ context: env.context })).rules![0].candidateCount, 3);
  const clean = await cleanupRuleHistory({ context: { ...env.context } });
  assert.equal(clean.status, 'success', JSON.stringify(clean)); assert.equal(clean.cleanup?.phase, 'unchanged');
  env.clock('2026-12-18T00:00:00.000Z');
  const expired = await cleanupRuleHistory({ context: { ...env.context } });
  assert.equal(expired.status, 'success', JSON.stringify(expired)); assert.equal(expired.cleanup?.removedCandidateCount, 2);
  assert.deepEqual(Object.keys((await env.journal()).candidates), [current.candidateId]);
  assert.equal((await getRulesStatus({ context: env.context })).rules![0].candidates[0].selectable, true);
  const repeated = env.writes.length;
  assert.equal((await syncRules({ context: { ...env.context } })).status, 'success');
  assert.equal((await cleanupRuleHistory({ context: { ...env.context } })).status, 'success'); assert.equal(env.writes.length, repeated);
});

test('有效证据中的 version/time 可补回缺失检查点，既有版本冲突明确失败', { skip: !binary }, async () => {
  for (const conflict of [false, true]) {
    const env = cleanupEnvironment(binary!);
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    env.beforeWrite(async files => {
      const state = files[RULE_STATE_PATH];
      if (state && parseRulesJournal(state).pendingDelivery) throw new Error('RULE_WRITE_CONFLICT: interrupted after evidence');
    });
    assert.notEqual((await syncRules({ context: env.context })).status, 'success');
    env.beforeWrite();
    const journal = await env.journal(), candidate = Object.values(journal.candidates)[0];
    const identity = { versionId: candidate.versionId, publishedAt: candidate.publishedAt };
    // Legal compatibility sample, not a naturally atomic current publisher
    // outcome: retain genuine immutable evidence with a missing version checkpoint.
    if (conflict) {
      candidate.publishedAt = '2026-11-15T00:00:00.000Z'; candidate.versionId = `${candidate.publishedAt}~${candidate.id.replaceAll('-', '').slice(0, 8)}`;
    } else { delete candidate.versionId; delete candidate.publishedAt; }
    await persistJournal(env, journal); env.failDownload(); env.failSource(true); env.clock('2026-11-18T00:00:00.000Z');
    const resumed = await syncRules({ context: { ...env.context } });
    if (conflict) {
      assert.equal(resumed.status, 'failed'); assert.match(resumed.results[0].error!, /does not match the registered version/);
      assert.equal(resumed.results[0].current, undefined); assert.equal((await env.journal()).candidates[candidate.id].status, 'publishing');
    } else {
      assert.equal(resumed.status, 'success', JSON.stringify(resumed));
      assert.equal(resumed.results[0].current?.versionId, identity.versionId);
      assert.equal((await env.journal()).candidates[candidate.id].publishedAt, identity.publishedAt);
    }
  }
});

test('恢复固定输入不跟随新的上游；缺失原输入明确失败并保留当前交付', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  env.upstream({ openai: 'domain:fixed-v2.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata unavailable'); });
  assert.equal((await syncRules({ context: env.context })).status, 'failed'); env.beforeWrite();
  const candidate = Object.values((await env.journal()).candidates).find(candidate => candidate.status === 'publishing')!;
  env.upstream({ openai: 'domain:latest-v3.example' });
  const snapshotPath = `candidates/${candidate.id}/input.source.yml`;
  const tree = env.trees.get(env.heads.get(env.context.repository.branch)!)!;
  const originalInput = tree.get(snapshotPath);
  assert.ok(originalInput);
  tree.delete(snapshotPath);
  const failed = await syncRules({ context: { ...env.context } });
  assert.equal(failed.status, 'failed'); assert.match(failed.results[0].error!, /recorded digest or length/);
  assert.match(failed.results[0].error!, new RegExp(candidate.id)); assert.equal(failed.results[0].continueWith, 'sync');
  assert.deepEqual(failed.results[0].current, first.results[0].current);
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(snapshotPath, originalInput);
  env.requests.length = 0;
  const stableWrites = env.writes.filter(write => write.branch === 'main').length;
  const resumed = await syncRules({ context: { ...env.context } });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.notEqual(resumed.results[0].current?.candidateId, candidate.id);
  assert.equal(resumed.results[0].current?.source.inputSha256, sha256(env.dlcInput()));
  assert.equal(env.writes.filter(write => write.branch === 'main').length, stableWrites + 1, 'only latest is delivered, never the restored intermediate candidate');
  assert.deepEqual((await env.journal()).candidates[candidate.id].source, candidate.source);
  assert.deepEqual(env.requests.map(url => url.split('/').at(-1)), ['dlc.dat_plain.yml.sha256sum', 'dlc.dat_plain.yml']);
  const latest = await syncRules({ context: { ...env.context } });
  assert.equal(latest.status, 'success'); assert.equal(latest.results[0].status, 'unchanged');
  assert.deepEqual(latest.results[0].current, resumed.results[0].current);
});

test('schedule 不放行损坏、不可读、目标不符、无登记依据或混合共享异常的 pending', { skip: !binary }, async () => {
  for (const fault of ['corrupt', 'unreadable', 'target', 'unregistered', 'mixed', 'stable-corrupt']) {
    const env = cleanupEnvironment(binary!, 'main');
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    env.failDownload(url => { if (url.includes('/stable/')) throw new Error('temporary readback failure'); });
    assert.equal((await syncRules({ context: env.context })).status, 'pending');
    const journal = await env.journal();
    if (fault === 'target') journal.targetBranch = 'acceptance-other';
    if (fault === 'unregistered') {
      delete journal.pendingDelivery;
      const id = '11111111-1111-1111-1111-111111111111';
      journal.quarantinedCandidates = { [id]: { id, reason: 'ownership unknown' } };
    }
    if (fault === 'mixed') journal.pendingDelivery!.afterRule.lastFailure = 'RULE_WRITE_CONFLICT: unrelated shared head';
    if (fault !== 'unreadable') await persistJournal(env, journal);
    if (fault === 'corrupt') {
      const snapshot = await env.context.repository.snapshot(); env.trees.get(snapshot.head)!.set('pipeline/state.json', Buffer.from('{'));
    }
    if (fault === 'stable-corrupt') {
      const snapshot = await env.context.repository.snapshot('main');
      const stableSrs = snapshot.paths.find(path => path.startsWith('stable/') && path.endsWith('.srs'));
      assert.ok(stableSrs);
      env.trees.get(snapshot.head)!.set(stableSrs, Buffer.from('corrupt stable artifact'));
    }
    if (fault === 'unreadable') {
      const snapshot = env.context.repository.snapshot;
      env.context.repository.snapshot = async (...args) => {
        const result = await snapshot(...args);
        return { ...result, read: async path => { if (path === 'pipeline/state.json') throw new Error('journal unreadable'); return result.read(path); } };
      };
    }
    const writes = env.writes.length, reports: { operation: string }[] = [];
    assert.equal(await runRuleAutomation({ event: 'schedule', target: 'main' }, text => reports.push(JSON.parse(text)), { ...env.context }), 1, fault);
    assert.deepEqual(reports.map(row => row.operation), ['schedule-preflight'], fault);
    assert.equal(env.writes.length, writes); assert.equal(env.refWrites.length, 0);
  }
});

test('活动维护未完成或 cleanup 门禁关闭时，schedule 不开放上游与普通写入', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  assert.equal((await syncRules({ context: env.context })).status, 'success');
  await publishReplacementForCleanup(env);
  env.failStage(() => { throw new Error('maintenance stage unavailable'); });
  assert.notEqual((await cleanupRuleHistory({ context: env.context })).status, 'success');
  const frozen = (await env.journal()).cleanupRun!.plan;
  const writes = env.writes.length; env.requests.length = 0;
  for (const allowCleanupWrites of [false, true]) {
    const reports: { operation: string }[] = [];
    assert.equal(await runRuleAutomation({ event: 'schedule', target: 'main' }, text => reports.push(JSON.parse(text)), { ...env.context, allowCleanupWrites }), 1);
    assert.deepEqual(reports.map(row => row.operation), ['schedule-preflight', 'cleanup']);
    assert.deepEqual((await env.journal()).cleanupRun!.plan, frozen);
  }
  assert.equal(env.writes.length, writes); assert.equal(env.requests.length, 0);
});

test('多个旧候选补齐证据后 latest 检查失败，保留较新交付且不按候选顺序切换', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const residual = await historicalResidues(env, 'domain:correct-current.example');
  const current = (await getRulesStatus({ context: env.context })).rules![0].current!;
  const stableHead = env.heads.get('main');
  const fetcher = env.context.fetch!;
  env.context.fetch = async (...args) => { if (String(args[0]).endsWith('/dlc.dat_plain.yml.sha256sum')) throw new Error('latest unavailable'); return fetcher(...args); };
  const failed = await syncRules({ context: { ...env.context } });
  assert.equal(failed.status, 'failed'); assert.match(failed.results[0].error!, /latest unavailable/);
  assert.deepEqual(failed.results[0].current, current); assert.equal(env.heads.get('main'), stableHead);
  const after = await env.journal();
  assert.equal(Object.keys(after.candidates).length, 3);
  for (const candidate of residual) {
    assert.equal(after.candidates[candidate.id].status, 'verified'); assert.deepEqual(after.candidates[candidate.id].source, candidate.source);
  }
  env.context.fetch = fetcher;
  const repeat = await syncRules({ context: { ...env.context } });
  assert.equal(repeat.status, 'success'); assert.equal(repeat.results[0].status, 'unchanged'); assert.deepEqual(repeat.results[0].current, current);
  assert.equal(env.heads.get('main'), stableHead);
  assert.equal((await cleanupRuleHistory({ context: { ...env.context } })).status, 'success');
});

test('恢复时工具内容改变不能改写原候选构建身份', { skip: !binary }, async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'rules-recovery-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Delegate every native command to the real binary, while deliberately
  // changing the executable's content identity, unlike a mere path move.
  const wrapper = join(directory, 'sing-box');
  await writeFile(wrapper, `#!/bin/sh\nexec '${binary!.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  env.upstream({ openai: 'domain:new-build.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata unavailable'); });
  assert.equal((await syncRules({ context: env.context })).status, 'failed'); env.beforeWrite();
  const before = await env.journal(); const candidate = Object.values(before.candidates).find(candidate => candidate.status === 'publishing')!;
  const resumed = await syncRules({ context: { ...env.context, binary: wrapper } });
  assert.equal(resumed.status, 'failed'); assert.match(resumed.results[0].error!, /RECOVERY_BUILD_CHANGED/);
  assert.deepEqual(resumed.results[0].current, first.results[0].current);
  const after = await env.journal(); assert.equal(Object.keys(after.candidates).length, Object.keys(before.candidates).length);
  assert.deepEqual(after.candidates[candidate.id], candidate);
});

test('候选恢复与新 pin 争用 journal 时 CAS 保留新控制，不重放迟到候选', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  const original = first.results[0].current!;
  env.upstream({ openai: 'domain:late-update.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata unavailable'); });
  assert.equal((await syncRules({ context: env.context })).status, 'failed');
  const candidate = Object.values((await env.journal()).candidates).find(candidate => candidate.status === 'publishing')!;
  let pinned = false;
  env.beforeWrite(async files => {
    if (!Object.keys(files).some(path => path.endsWith('/manifest.json'))) return;
    env.beforeWrite();
    assert.equal((await pinRuleVersion({ context: { ...env.context }, id: 'openai', version: original.versionId! })).status, 'success');
    pinned = true;
  });
  const late = await syncRules({ context: { ...env.context } });
  assert.ok(pinned); assert.notEqual(late.status, 'success'); assert.match(late.results[0].error!, /RULE_WRITE_CONFLICT/);
  assert.equal(late.results[0].control?.mode, 'pinned'); assert.equal(late.results[0].current?.candidateId, original.candidateId);
  assert.equal((await env.journal()).candidates[candidate.id].status, 'publishing');
  env.requests.length = 0;
  assert.equal((await syncRules({ context: { ...env.context } })).results[0].status, 'pinned-skipped'); assert.equal(env.requests.length, 0);
  const clean = await cleanupRuleHistory({ context: { ...env.context } });
  assert.equal(clean.status, 'success', JSON.stringify(clean));
  assert.equal((await env.journal()).candidates[candidate.id], undefined);
  assert.equal((await getRulesStatus({ context: env.context })).rules![0].current?.candidateId, original.candidateId);
});

test('A 当前、B 中断后上游回退 A，旧 unchanged 遗留的 B 只补证据而不回切', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  const currentA = first.results[0].current!;
  env.upstream({ openai: 'domain:withdrawn-b.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('B metadata interrupted'); });
  assert.equal((await syncRules({ context: env.context })).status, 'failed'); env.beforeWrite();
  const journal = await env.journal(); const candidateB = Object.values(journal.candidates).find(candidate => candidate.status === 'publishing')!;
  env.upstream({ openai: 'domain:openai.example' });
  // Baseline-equivalent unchanged checkpoint: the old grouped recovery could
  // skip this publishing record and clear its lastFailure after observing A.
  // There is no durable delivery-selection marker distinguishing that state.
  delete journal.rules.openai.lastFailure; await persistJournal(env, journal);
  const headA = env.heads.get('main');
  const resumed = await syncRules({ context: { ...env.context } });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed)); assert.equal(resumed.results[0].status, 'unchanged');
  assert.deepEqual(resumed.results[0].current, currentA);
  assert.equal(env.heads.get('main'), headA, 'B must never transiently replace the correct current A');
  assert.equal((await env.journal()).candidates[candidateB.id].status, 'verified');
  assert.deepEqual((await env.journal()).candidates[candidateB.id].source, candidateB.source);
  assert.equal(Object.keys((await env.journal()).candidates).length, 2);
  assert.equal((await cleanupRuleHistory({ context: { ...env.context } })).status, 'success');
});
