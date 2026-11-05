import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules, rollbackRules } from '../../src/activation.js';
import { readUpdateState } from '../../src/update.js';
import { configuredEnvironment } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
async function isolated(run: (env: Awaited<ReturnType<typeof configuredEnvironment>>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'configured-rollback-'));
  try { await run(await configuredEnvironment(binary!, directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('逐集回滚恢复历史字节，兄弟集的稳定文件、版本和历史不变', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = await env.candidates(), second = await env.candidates();
  const historical = new Map<string, string>();
  for (const id of env.ids) historical.set(id, (await activateRules(env.options(id, first[id].evidenceUrl!))).commit);
  for (const id of env.ids) await activateRules(env.options(id, second[id].evidenceUrl!));
  const immutable = new Map(env.stored);
  const historySnapshots = new Map([...env.snapshots].map(([commit, files]) => [commit, { ...files }]));
  for (const id of env.ids) {
    const before = env.snapshots.get(env.head())!, state = await readUpdateState(directory);
    const commit = historical.get(id)!;
    const result = await rollbackRules({ ...env.options(id, ''), historicalActivationCommit: commit });
    assert.equal(result.activation.operation, 'rollback');
    assert.equal(result.activation.candidateId, first[id].id);
    assert.equal(result.activation.historicalActivationCommit, commit);
    const after = env.snapshots.get(env.head())!;
    const status = await readUpdateState(directory);
    assert.equal(status.activeRuleVersions[id].activation.candidateId, first[id].id);
    assert.equal(status.activeRuleVersions[id].activation.history.length, 2);
    for (const file of ['domains.json', 'domains.srs']) {
      const path = `stable/${id}/${file}`;
      assert.notDeepEqual(after[path], before[path]);
      assert.deepEqual(after[path], env.snapshots.get(commit)![path]);
    }
    for (const sibling of env.ids.filter(other => other !== id)) {
      assert.deepEqual(status.activeRuleVersions[sibling], state.activeRuleVersions[sibling]);
      for (const file of ['domains.json', 'domains.srs', 'activation.json']) {
        const path = `stable/${sibling}/${file}`;
        assert.deepEqual(after[path], before[path]);
      }
    }
  }
  assert.deepEqual(env.stored, immutable);
  for (const [commit, files] of historySnapshots) assert.deepEqual(env.snapshots.get(commit), files);
}));

for (const fault of ['other-set', 'wrong-identity', 'history-json', 'history-bytes', 'missing-candidate', 'candidate-bytes', 'subscription', 'historical-candidate', 'native', 'stale-head']) {
  test(`回滚 ${fault} 在写入前拒绝，三集继续交付各自当前版本`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const first = await env.candidates(), second = await env.candidates();
    const history: Record<string, string> = {};
    for (const id of env.ids) history[id] = (await activateRules(env.options(id, first[id].evidenceUrl!))).commit;
    const id = env.ids[0];
    await activateRules(env.options(id, second[id].evidenceUrl!));
    const options = { ...env.options(id, ''), historicalActivationCommit: history[id] };
    const path = `stable/${id}/activation.json`;
    if (fault === 'other-set') Object.assign(options, env.options(env.ids[1], ''));
    if (fault === 'wrong-identity') {
      const snapshot = env.snapshots.get(history[id])!;
      const record = JSON.parse(snapshot[path].toString()); record.logicalId = env.ids[1];
      snapshot[path] = Buffer.from(JSON.stringify(record));
    }
    if (fault === 'historical-candidate') {
      const snapshot = env.snapshots.get(history[id])!;
      const record = JSON.parse(snapshot[path].toString()); record.candidateId = second[id].id;
      snapshot[path] = Buffer.from(JSON.stringify(record));
    }
    if (fault === 'history-json') env.snapshots.get(history[id])![path] = Buffer.from('{');
    if (fault === 'history-bytes') env.snapshots.get(history[id])![`stable/${id}/domains.srs`] = Buffer.from('damaged history');
    if (fault === 'missing-candidate') env.stored.delete(first[id].evidenceUrl!);
    if (fault === 'candidate-bytes') {
      const evidence = JSON.parse(env.stored.get(first[id].evidenceUrl!)!.toString());
      env.stored.set(evidence.readback.find((entry: any) => entry.url.endsWith('/domains.srs')).url, Buffer.from('damaged candidate'));
    }
    if (fault === 'subscription') options.subscription.targetVersion = '1.15.0';
    if (fault === 'native') options.binary = '/missing/sing-box';
    if (fault === 'stale-head') options.expectedHead = history[id];
    const head = env.head(), writes = env.writes(), snapshot = { ...env.snapshots.get(head) };
    const status = await readUpdateState(directory);
    const candidates = new Map(env.stored);
    await assert.rejects(rollbackRules(options));
    assert.equal(env.head(), head); assert.equal(env.writes(), writes);
    assert.deepEqual(env.snapshots.get(head), snapshot);
    assert.deepEqual(await readUpdateState(directory), status);
    assert.deepEqual(env.stored, candidates, 'Rollback must not rewrite immutable candidates');
  }));
}
