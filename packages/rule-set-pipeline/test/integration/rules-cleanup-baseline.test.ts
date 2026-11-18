import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupEnvironment, publishReplacementForCleanup } from '../fixtures/cleanup-environment.js';
import { syncRules } from '../../src/rules-operations.js';
import { prepareRulesBaseline } from '../../src/rules-cleanup-baseline.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import type { CleanupPlan } from '../../src/rules-cleanup-model.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import { sha256 } from '../../src/release.js';

const binary = process.env.SING_BOX_TEST_BINARY;
test('清理保留迁移恢复的发布时间和版本，不要求旧证据已有 versionId', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!);
  const configuration = env.config(); configuration.ruleSets = [configuration.ruleSets[0]]; env.configure(configuration);
  const delivered = await syncRules({ context: env.context });
  assert.equal(delivered.status, 'success', JSON.stringify(delivered));
  const current = delivered.results[0].current!;
  const journal = await env.journal(), candidate = journal.candidates[current.candidateId];
  const path = `candidates/${candidate.id}/readback.json`;
  const snapshot = await env.context.repository.snapshot();
  const legacy = JSON.parse((await snapshot.read(path))!.toString());
  delete legacy.versionId;
  const evidence = encodeRecord(legacy);
  // Model the existing one-time conversion: the trusted original time exists,
  // while migration assigns its deterministic version without editing old bytes.
  for (const tree of env.trees.values()) if (tree.has(path)) tree.set(path, evidence);
  candidate.operation = 'migration';
  candidate.versionId = `${candidate.publishedAt}~${candidate.id.replaceAll('-', '')}`;
  candidate.evidenceSha256 = sha256(evidence);
  const record = { ...current, versionId: candidate.versionId };
  const recordPath = `${candidate.definition.stablePath}/activation.json`;
  env.trees.get(snapshot.head)!.set(RULE_STATE_PATH, encodeRecord(journal));
  env.trees.get(snapshot.head)!.set(recordPath, encodeRecord(record));
  const plan: CleanupPlan = { candidateRetentionDays: 30, cleanupObservedAt: '2026-11-16T00:00:00.000Z',
    cutoff: '2026-10-17T00:00:00.000Z', retain: { candidateIds: [candidate.id], active: [{ recordPath, record }] },
    discard: { candidateIds: [] }, decisions: [], blockers: [], retainedBytes: 0, otherRefs: [], hasCleanup: true };
  const prepared = await prepareRulesBaseline({ transport: env.baseline, repository: env.context.repository,
    binary: binary!, targetBranch: env.context.targetBranch, plan, runId: randomUUID(), journal,
    source: snapshot, stable: snapshot, now: new Date(plan.cleanupObservedAt) });
  const result = await env.baseline.snapshot(prepared.stages.journal.ref);
  const rebuilt = parseRulesJournal((await result!.read(RULE_STATE_PATH))!);
  assert.equal(rebuilt.candidates[candidate.id].versionId, candidate.versionId);
  assert.equal(rebuilt.candidates[candidate.id].publishedAt, candidate.publishedAt);
  assert.equal(JSON.parse((await result!.read(path))!.toString()).versionId, candidate.versionId);
  assert.equal(JSON.parse((await snapshot.read(path))!.toString()).versionId, undefined);
});

for (const target of ['acceptance-issue-85-other-host', 'main']) {
  test(`${target}: 证据已提交后换用不同工具 SHA 恢复，复验保留证据而不重建字节`, { skip: !binary }, async t => {
    const env = cleanupEnvironment(binary!, target);
    assert.equal((await syncRules({ context: env.context })).status, 'success');
    const expired = await publishReplacementForCleanup(env);
    const before = await env.journal();
    env.failStage(ref => { if (ref.endsWith('-journal')) throw new Error('Interrupted after evidence'); });
    const interrupted = await cleanupRuleHistory({ context: env.context });
    assert.equal(interrupted.status, 'pending', JSON.stringify(interrupted));
    const evidenceRef = env.stageWrites.find(ref => ref.endsWith('-evidence'))!;
    assert.ok(evidenceRef);
    const retained = await env.baseline.snapshot(evidenceRef);
    const evidence = Object.fromEntries(await Promise.all(Object.keys(before.candidates).filter(id => id !== expired).map(async id =>
      [id, (await retained!.read(`candidates/${id}/readback.json`))!] as const)));
    const directory = await mkdtemp(join(tmpdir(), 'cleanup-other-host-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const wrapper = join(directory, 'sing-box');
    const quoted = "'" + binary!.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(wrapper, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 });
    env.context.binary = wrapper; env.failStage();
    const resumed = await cleanupRuleHistory({ context: env.context });
    assert.equal(resumed.status, 'success', JSON.stringify(resumed));
    assert.equal(resumed.cleanup?.maintenanceId, interrupted.cleanup?.maintenanceId);
    const snapshot = await env.context.repository.snapshot(), after = await env.journal();
    for (const [id, bytes] of Object.entries(evidence)) {
      assert.deepEqual(await snapshot.read(`candidates/${id}/readback.json`), bytes);
      assert.equal(after.candidates[id].versionId, before.candidates[id].versionId);
      assert.equal(after.candidates[id].publishedAt, before.candidates[id].publishedAt);
    }
  });
}
