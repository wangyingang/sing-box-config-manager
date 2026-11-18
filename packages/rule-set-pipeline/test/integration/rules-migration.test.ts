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
for (const name of ['shared', 'split', 'srs-only'] as const) {
  test(`${name}: 旧策略候选不能转换或覆盖，首次 sync 要求空目标`, { skip: !binary }, async () => {
    const env = await historicalEnvironment(name, binary!);
    const { context } = env;
    const stable = await context.repository.snapshot(context.targetBranch);
    const path = 'stable/openai/activation.json';
    const { record } = activationRecord(JSON.parse((await stable.read(path))!.toString()), path, context.targetBranch);
    await verifyStableFiles(record, file => stable.read(file));
    if (name === 'srs-only') assert.deepEqual(Object.keys(record.files), ['stable/openai/domains.srs']);

    const heads = new Map(env.heads);
    for (const dryRun of [true, false]) {
      const result = await syncRules({ context, dryRun });
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /RULE_STATE_MIGRATION_REQUIRED.*empty artifact target/);
    }
    await assert.rejects(migrateRulesState({ context, dryRun: true }), /Missing complete remote candidate verification/);
    await assert.rejects(migrateRulesState({ context }), /Missing complete remote candidate verification/);
    assert.deepEqual(env.heads, heads);
    assert.equal(env.writes.length, 0);
  });
}

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
