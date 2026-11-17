import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateRulesState } from '../../src/rules-migration.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import { syncRules } from '../../src/rules-operations.js';
import { readRemoteState } from '../../src/remote-state.js';
import { activationRecord, verifyStableFiles } from '../../src/remote-status.js';
import { getRulesStatus } from '../../src/rules-status.js';
import type { RuleWrites } from '../../src/rules-repository.js';
import { historicalEnvironment } from '../fixtures/historical-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
for (const name of ['shared', 'split'] as const) {
  test(`${name}: 固定历史转换保留来源、字节、有效固定及未知时间，预览与重复执行零写入`, { skip: !binary }, async () => {
    const env = await historicalEnvironment(name, binary!);
    const { context } = env;
    const { journal: legacy } = await readRemoteState(env.legacyRepository);
    const stable = await context.repository.snapshot(context.targetBranch);
    const openai = JSON.parse((await stable.read('stable/openai/activation.json'))!.toString());
    const stableBytes = new Map(await Promise.all(stable.paths.filter(path => path.startsWith('stable/') && !path.endsWith('/activation.json'))
      .map(async path => [path, await stable.read(path)] as const)));
    if (name === 'split') {
      const configuration = env.config();
      configuration.ruleSets.find(rule => rule.id === 'openai')!.list = 'openai-alt';
      env.configure(configuration);
    }
    const heads = new Map(env.heads);
    const preview = await migrateRulesState({ context, dryRun: true });
    assert.equal(preview.status, 'planned');
    assert.equal(env.writes.length, 0);
    assert.deepEqual(env.heads, heads);
    assert.equal(preview.migration.pending.length, 3);
    assert.ok(preview.migration.pending.every(message => /historical publication time unavailable/.test(message)));
    if (name === 'split') {
      let interrupt = true;
      env.beforeWrite(files => {
        if (interrupt && files[RULE_STATE_PATH] && JSON.parse(files[RULE_STATE_PATH]!.toString()).schemaVersion === 2) {
          interrupt = false; throw new Error('Interrupted before final journal commit');
        }
      });
      await assert.rejects(migrateRulesState({ context }), /RULE_MIGRATION_PENDING/);
      const checkpoint = JSON.parse((await (await context.repository.snapshot()).read(RULE_STATE_PATH))!.toString());
      assert.equal(checkpoint.schemaVersion, 1);
      assert.equal(checkpoint.maintenance, 'maintenance');
      assert.equal((await getRulesStatus({ context })).status, 'failed');
    }
    assert.equal((await migrateRulesState({ context })).status, 'converted');
    assert.equal(env.writes.length, name === 'split' ? 3 : 1);
    const next = parseRulesJournal((await (await context.repository.snapshot()).read(RULE_STATE_PATH))!);
    assert.equal(next.rules.openai.control.mode, name === 'split' ? 'auto' : 'pinned');
    if (next.rules.openai.control.mode === 'pinned') assert.equal(next.rules.openai.control.candidateId, openai.candidateId);
    assert.equal(next.rules.anthropic.control.mode, 'auto');
    const newStable = await context.repository.snapshot(context.targetBranch);
    for (const [path, bytes] of stableBytes) assert.deepEqual(await newStable.read(path), bytes, path);
    for (const candidate of Object.values(next.candidates)) {
      assert.equal(candidate.publishedAt, undefined);
      assert.equal(candidate.versionId, undefined);
      assert.match(candidate.migrationPending!, /Historical publication time is unavailable/);
      assert.equal(candidate.buildId, legacy.state.candidates[candidate.id].buildId);
      assert.equal(candidate.evidenceUrl, legacy.state.candidates[candidate.id].evidenceUrl);
      const source = JSON.parse((await (await context.repository.snapshot()).read(`candidates/${candidate.id}/source.json`))!.toString());
      assert.deepEqual(candidate.source, source);
      assert.equal(candidate.source.repository, 'v2fly/domain-list-community');
      assert.equal('releaseId' in candidate.source && candidate.source.releaseId, 1);
    }
    const status = await getRulesStatus({ context });
    assert.equal(status.status, 'success', JSON.stringify(status));
    const selected = status.rules!.find(rule => rule.id === 'openai')!;
    assert.equal(selected.deliveryState, 'delivered');
    assert.equal(selected.current!.candidateId, openai.candidateId);
    assert.ok(selected.candidates.length > 0);
    assert.ok(selected.candidates.every(candidate => !candidate.selectable && /Historical publication time/.test(candidate.reason!)));
    if (name === 'split') assert.equal(env.writes.filter(write => write.branch === context.targetBranch).length, 1);
    const convertedHeads = new Map(env.heads);
    assert.equal((await migrateRulesState({ context })).status, 'already-converted');
    assert.equal(env.writes.length, name === 'split' ? 3 : 1);
    assert.deepEqual(env.heads, convertedHeads);
  });
}

test('SRS-only 历史订阅读取与转换保留；现行定义要求双格式时零写入拒绝', { skip: !binary }, async () => {
  const env = await historicalEnvironment('srs-only', binary!);
  const { context } = env;
  const stable = await context.repository.snapshot(context.targetBranch);
  const path = 'stable/openai/activation.json';
  const { record } = activationRecord(JSON.parse((await stable.read(path))!.toString()), path, context.targetBranch);
  assert.deepEqual(Object.keys(record.files), ['stable/openai/domains.srs']);
  await verifyStableFiles(record, file => stable.read(file));
  assert.equal(await stable.read('stable/openai/domains.json'), undefined);
  const heads = new Map(env.heads);
  await assert.rejects(migrateRulesState({ context }), /subscription contract changed/);
  assert.equal(env.writes.length, 0);
  assert.deepEqual(env.heads, heads);
  // Absent current definitions retain their actual historical subscription.
  const configuration = env.config(); configuration.ruleSets = []; configuration.sources = {};
  env.configure(configuration);
  assert.equal((await migrateRulesState({ context, dryRun: true })).status, 'planned');
  assert.equal(env.writes.length, 0);
  assert.equal((await migrateRulesState({ context })).status, 'converted');
  const converted = await context.repository.snapshot(context.targetBranch);
  const delivery = JSON.parse((await converted.read(path))!.toString());
  assert.equal(delivery.schemaVersion, 2);
  assert.equal(delivery.candidateId, record.candidateId);
  assert.deepEqual(delivery.subscription, record.subscription);
  assert.deepEqual(delivery.source, record.source);
  assert.deepEqual(await converted.read('stable/openai/domains.srs'), await stable.read('stable/openai/domains.srs'));
  assert.equal(await converted.read('stable/openai/domains.json'), undefined);
  assert.equal((await migrateRulesState({ context })).status, 'already-converted');
});

test('真实文件阶段中断样本被隔离，定义删除回收；无法归属时保留待处理', { skip: !binary }, async () => {
  for (const unknown of [false, true]) {
    const env = await historicalEnvironment('incomplete', binary!);
    const { context } = env;
    const { snapshot, journal } = await readRemoteState(env.legacyRepository);
    const original = Object.values(journal.state.candidates)[0];
    const partialPath = `candidates/${original.id}/domains.json`;
    const originalBytes = await snapshot.read(partialPath);
    assert.ok(originalBytes);
    if (unknown) {
      // Explicit fault: ownership metadata was lost from a real captured publication.
      delete journal.state.candidates[original.id].logicalId;
      delete journal.state.candidates[original.id].definition;
      delete journal.state.pendingOperation;
      await context.repository.commit(context.repository.branch, snapshot.head, { [RULE_STATE_PATH]: encodeRecord(journal) }, 'fault: lost ownership', async () => {});
    }
    await migrateRulesState({ context });
    const status = await getRulesStatus({ context });
    assert.equal(status.quarantinedCandidates![original.id].logicalId, unknown ? undefined : 'openai');
    assert.match(status.quarantinedCandidates![original.id].reason, unknown ? /ownership.*unresolved/ : /Incomplete historical publication/);
    if (!unknown) {
      const partial = status.rules!.find(rule => rule.id === 'openai')!.candidates.find(candidate => candidate.id === original.id)!;
      assert.equal(partial.selectable, false);
      assert.match(partial.reason!, /Incomplete historical publication/);
    }
    const configuration = env.config(); configuration.sources = {}; configuration.ruleSets = [];
    env.configure(configuration);
    const deleted = await syncRules({ context });
    const final = await context.repository.snapshot();
    const next = parseRulesJournal((await final.read(RULE_STATE_PATH))!);
    if (unknown) {
      assert.equal(deleted.status, 'pending');
      assert.match(deleted.error!, /ownership.*unresolved/);
      assert.equal((await getRulesStatus({ context })).status, 'pending');
      assert.deepEqual(await final.read(partialPath), originalBytes);
      assert.ok(next.quarantinedCandidates?.[original.id]);
    } else {
      assert.equal(deleted.status, 'success', JSON.stringify(deleted));
      assert.equal(await final.read(partialPath), undefined);
      assert.equal(next.quarantinedCandidates?.[original.id], undefined);
      assert.equal(next.rules.openai.lifecycle, 'deleted');
    }
  }
});

for (const fault of ['stable-bytes', 'candidate-evidence', 'missing-current-file', 'journal-json', 'source-identity'] as const) {
  test(`历史转换遇到 ${fault} 拒绝且不写入`, { skip: !binary }, async () => {
    const env = await historicalEnvironment('shared', binary!);
    const { context } = env;
    const { snapshot, journal } = await readRemoteState(env.legacyRepository);
    const id = Object.values(journal.state.candidates).find(candidate => candidate.logicalId === 'openai')!.id;
    const files: RuleWrites = fault === 'stable-bytes' ? { 'stable/openai/domains.srs': Buffer.from('corrupt') }
      : fault === 'candidate-evidence' ? { [`candidates/${id}/readback.json`]: Buffer.from('{}') }
      : fault === 'missing-current-file' ? { [`candidates/${id}/domains.srs`]: null }
      : fault === 'journal-json' ? { [RULE_STATE_PATH]: Buffer.from('{broken-json') }
      : (() => {
        Object.values(journal.state.pinned)[0].identity!.yaml.id = -1;
        return { [RULE_STATE_PATH]: encodeRecord(journal) };
      })();
    await context.repository.commit(context.repository.branch, snapshot.head, files, `fault: ${fault}`, async () => {});
    const heads = new Map(env.heads), writes = env.writes.length;
    await assert.rejects(migrateRulesState({ context }), fault === 'stable-bytes' ? /Stable file integrity/
      : fault === 'journal-json' ? /JSON/ : fault === 'source-identity' ? /STATE_CORRUPT/ : /evidence|Candidate|candidate|retained|readback/i);
    assert.equal(env.writes.length, writes);
    assert.deepEqual(env.heads, heads);
  });
}
