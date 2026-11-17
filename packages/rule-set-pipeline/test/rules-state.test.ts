import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules } from '../src/rules-operations.js';
import { encodeRecord, RULE_STATE_PATH } from '../src/rules-model.js';
import { rulesEnvironment } from './fixtures/rules-environment.js';

for (const fault of ['missing-state', 'corrupt-state', 'read-error', 'snapshot-error', 'wrong-target']) {
  test(`sync 遇到当前 ${fault} 时不读上游、不写入或重新初始化`, async () => {
    const env = rulesEnvironment('/must-not-run');
    env.failSource(true);
    assert.equal((await syncRules({ context: env.context })).status, 'failed');
    const repository = env.context.repository, snapshot = await repository.snapshot();
    const tree = env.trees.get(snapshot.head)!;
    assert.ok(tree.has('pipeline/identity.json'));
    if (fault === 'missing-state') tree.delete(RULE_STATE_PATH);
    if (fault === 'corrupt-state') tree.set(RULE_STATE_PATH, Buffer.from('{invalid-json'));
    if (fault === 'wrong-target') {
      const state = JSON.parse(tree.get(RULE_STATE_PATH)!.toString()); state.targetBranch = 'acceptance-other';
      tree.set(RULE_STATE_PATH, encodeRecord(state));
    }
    const readSnapshot = repository.snapshot;
    if (fault === 'read-error') repository.snapshot = async (...args) => {
      const current = await readSnapshot(...args);
      return { ...current, async read(path) { if (path === RULE_STATE_PATH) throw new Error('State HTTP 503'); return current.read(path); } };
    };
    if (fault === 'snapshot-error') repository.snapshot = async () => { throw new Error('Snapshot HTTP 503'); };
    const writes = env.writes.length, heads = new Map(env.heads), bytes = new Map(tree);
    let reads = 0;
    const result = await syncRules({ context: { ...env.context, fetch: async () => { reads++; throw new Error('Must not read upstream'); } } });
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.match(result.error!, fault === 'missing-state' ? /RULE_STATE_MIGRATION_REQUIRED/
      : fault === 'wrong-target' ? /RULE_TARGET_MISMATCH/ : fault.endsWith('error') ? /HTTP 503/ : /JSON/);
    assert.equal(reads, 0); assert.equal(env.writes.length, writes);
    assert.deepEqual(env.heads, heads); assert.deepEqual(tree, bytes);
  });
}
