import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { syncRules } from '../../src/rules-operations.js';
import { parseRulesJournal } from '../../src/rules-model.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { pinRuleVersion } from '../../src/rules-operations.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';

const binary = process.env.SING_BOX_TEST_BINARY;
test('正式四集首次交付只需 29 次提交，七个持久阶段保留恢复边界', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!, 'main');
  env.configure(parseBuildConfiguration(readOfficialConfiguration()));
  const fetcher = env.context.fetch!;
  env.context.fetch = async (address, init) => {
    const url = String(address);
    if (url.includes('gaoyifan/china-operator-ip')) return url.includes('/branches/')
      ? Response.json({ name: 'ip-lists', commit: { sha: 'b'.repeat(40) } })
      : new Response('192.0.2.0/24\n2001:db8::/32\n');
    return fetcher(address, init);
  };
  const result = await syncRules({ context: env.context });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(env.writes.length, 29);
  assert.equal(env.writes.filter(write => write.branch === 'main').length, 4);
  for (const [index, rule] of result.results.entries()) {
    const id = rule.current!.candidateId;
    const stages = env.writes.slice(1 + index * 7, 8 + index * 7);
    const journals = stages.map(write => write.files['pipeline/state.json'])
      .map(bytes => bytes ? parseRulesJournal(bytes) : undefined);
    assert.equal(journals[0]!.candidates[id].status, 'building');
    assert.equal(journals[1]!.candidates[id].status, 'publishing');
    assert.ok(Object.keys(stages[1].files).some(path => path.endsWith('.srs')));
    assert.ok(journals[2]!.candidates[id].filesCommit);
    assert.ok(stages[2].files[`candidates/${id}/manifest.json`]);
    assert.ok(journals[3]!.candidates[id].metadataCommit);
    assert.ok(journals[3]!.candidates[id].manifestUrl);
    assert.ok(stages[3].files[`candidates/${id}/readback.json`]);
    assert.equal(journals[4]!.candidates[id].status, 'verified');
    assert.equal(journals[4]!.pendingDelivery?.record?.candidateId, id);
    assert.equal(stages[5].branch, 'main');
    assert.ok(stages[5].files['pipeline/rule-operation.json']);
    assert.equal(journals[6]!.pendingDelivery, undefined);
    assert.equal(journals[6]!.candidates[id].versionId, rule.current!.versionId);
  }
});

for (const target of ['main', 'acceptance-performance']) for (const stage of [1, 2, 3, 4, 5, 6, 7]) {
  test(`${target}: 第 ${stage} 阶段提交后中断，换会话恢复原候选与已登记版本`, { skip: !binary }, async () => {
    const env = cleanupEnvironment(binary!, target);
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    const repo = env.context.repository, commit = repo.commit, snapshot = repo.snapshot;
    let interrupted = false;
    repo.snapshot = async branch => {
      if (interrupted) throw new Error('RULE_WRITE_CONFLICT: process interrupted');
      return snapshot(branch);
    };
    repo.commit = async (...args) => {
      const head = await commit(...args);
      if (env.writes.length === stage + 1) { interrupted = true; throw new Error('RULE_WRITE_CONFLICT: process interrupted'); }
      return head;
    };
    assert.notEqual((await syncRules({ context: env.context })).status, 'success');
    repo.commit = commit; repo.snapshot = snapshot;
    const before = await env.journal(), candidate = Object.values(before.candidates)[0];
    const retained = await snapshot();
    const bytes = new Map(await Promise.all(retained.paths.filter(path => path.startsWith(`candidates/${candidate.id}/`))
      .map(async path => [path, await retained.read(path)] as const)));
    const stableWrites = env.writes.filter(write => Object.keys(write.files).some(path => path.startsWith('stable/'))).length;
    env.clock('2026-11-19T00:00:00.000Z');
    const result = await syncRules({ context: { ...env.context } });
    assert.equal(result.status, 'success', JSON.stringify(result));
    const after = await env.journal(), recovered = after.candidates[candidate.id];
    assert.deepEqual(Object.keys(after.candidates), [candidate.id]);
    assert.equal(recovered.buildId, candidate.buildId); assert.deepEqual(recovered.source, candidate.source);
    if (candidate.versionId) {
      assert.equal(recovered.versionId, candidate.versionId); assert.equal(recovered.publishedAt, candidate.publishedAt);
    }
    for (const [path, original] of bytes) assert.deepEqual(await (await snapshot()).read(path), original, path);
    assert.equal(result.results[0].current?.candidateId, candidate.id);
    assert.equal(after.pendingDelivery, undefined);
    if (stableWrites) assert.equal(env.writes.filter(write => Object.keys(write.files).some(path => path.startsWith('stable/'))).length, stableWrites);
    const count = env.writes.length;
    assert.equal((await syncRules({ context: { ...env.context } })).status, 'success');
    assert.equal(env.writes.length, count);
  });

  test(`${target}: 第 ${stage} 阶段提交成功但响应丢失，核实原写入且不重复提交`, { skip: !binary }, async () => {
    const env = rulesEnvironment(binary!, target);
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    const repo = env.context.repository, commit = repo.commit;
    let lost = false;
    repo.commit = async (...args) => {
      const head = await commit(...args);
      if (!lost && env.writes.length === stage + 1) { lost = true; throw new PublicationWriteError(head, new Error('response lost')); }
      return head;
    };
    const result = await syncRules({ context: env.context });
    assert.equal(result.status, 'success', JSON.stringify(result)); assert.ok(lost);
    assert.equal(env.writes.length, 8);
    assert.equal((await getRulesStatus({ context: env.context })).rules?.[0].candidateCount, 1);
  });
}

test('候选合格但交付准备失败时单独保存 verified，不登记 pending 或切换 current', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const repo = env.context.repository, snapshot = repo.snapshot;
  let failPreparation = false;
  env.beforeWrite(async files => {
    if (Object.keys(files).some(path => path.endsWith('/readback.json'))) failPreparation = true;
  });
  repo.snapshot = async branch => {
    if (branch === 'main' && failPreparation) throw new Error('delivery preparation unavailable');
    return snapshot(branch);
  };
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  repo.snapshot = snapshot; env.beforeWrite();
  const journal = await env.journal(); const candidate = Object.values(journal.candidates)[0];
  assert.equal(candidate.status, 'verified'); assert.ok(candidate.evidenceUrl);
  assert.equal(journal.pendingDelivery, undefined);
  assert.equal(env.writes.filter(write => write.branch === 'main').length, 0);
  assert.equal((await getRulesStatus({ context: env.context })).rules?.[0].candidateCount, 1);
  assert.equal((await syncRules({ context: { ...env.context } })).results[0].current?.candidateId, candidate.id);
});

for (const rival of ['sync', 'pin', 'change-source', 'delete', 'cleanup'] as const) {
  // Exercise later actual writes in the existing concurrency matrix as well:
  // metadata must retain the pin/CAS guard, evidence the configuration guard.
  const stage = rival === 'pin' ? 'manifest.json' : rival === 'change-source' ? 'readback.json' : '.srs';
  test(`候选 ${stage} 阶段与 ${rival} 并发时，迟到写入不覆盖最新状态`, { skip: !binary }, async () => {
    const env = cleanupEnvironment(binary!, 'main');
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
    const version = first.results[0].current!.versionId!;
    env.upstream({ openai: 'domain:next.example' });
    let rivalResult: unknown; let afterRival = '';
    env.beforeWrite(async files => {
      const registering = files['pipeline/state.json'] && Object.values(parseRulesJournal(files['pipeline/state.json']!).candidates)
        .some(candidate => candidate.status === 'building');
      if (rival === 'cleanup' ? !registering : !Object.keys(files).some(path => path.endsWith(stage))) return;
      env.beforeWrite();
      const request = { context: { ...env.context } };
      if (rival === 'pin') rivalResult = await pinRuleVersion({ ...request, id: 'openai', version });
      else if (rival === 'cleanup') {
        rivalResult = await cleanupRuleHistory(request);
        assert.equal((rivalResult as { status: string }).status, 'success', JSON.stringify(rivalResult));
        assert.ok(env.refWrites.length);
      } else {
        if (rival === 'change-source') { const next = env.config(); next.ruleSets[0].list = 'other'; env.configure(next); }
        if (rival === 'delete') env.configure({ ...env.config(), ruleSets: [], sources: {} });
        rivalResult = await syncRules(request);
      }
      afterRival = env.heads.get('candidates')!;
    });
    const result = await syncRules({ context: env.context });
    assert.ok(rivalResult); assert.notEqual(result.status, 'success', JSON.stringify(result));
    assert.equal(env.heads.get('candidates'), afterRival);
    if (rival === 'pin') assert.equal((await env.journal()).rules.openai.control.mode, 'pinned');
    if (rival === 'delete') assert.equal((await env.journal()).rules.openai.lifecycle, 'deleted');
    if (rival === 'cleanup') assert.equal((await env.journal()).maintenance, 'open');
  });
}
