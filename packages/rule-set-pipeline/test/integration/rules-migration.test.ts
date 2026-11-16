import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { activateRules } from '../../src/activation.js';
import { checkRules } from '../../src/check-rules.js';
import { parseBuildConfiguration } from '../../src/configuration.js';
import type { RulesContext } from '../../src/rules-context.js';
import { migrateRulesState } from '../../src/rules-migration.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import { syncRules } from '../../src/rules-operations.js';
import { readRemoteState } from '../../src/remote-state.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { configuredEnvironment, upstream } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
for (const target of ['acceptance-issue-84-migration', 'main']) {
  test(`${target}: 旧状态转换保留稳定字节和有效固定，缺失时间不编造，预览零写入`, { skip: !binary }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rule-migration-'));
    try {
      const env = await configuredEnvironment(binary!, directory, target);
      const built = await checkRules({ binary: binary!, configuration: env.configuration, stateDirectory: directory,
        fetch: upstream(1).fetcher, publication: { repository: env.repository, commit: env.publish, download: env.transport.download },
        activation: env.transport, subscriptions: Object.fromEntries(env.ids.map(id => [id, env.subscription(id)])) });
      assert.equal(built.exitCode, 0, JSON.stringify(built));
      const oldStable = await env.repository.snapshot(target);
      const openai = JSON.parse((await oldStable.read('stable/openai/activation.json'))!.toString());
      await activateRules(env.options('openai', openai.candidateEvidenceUrl));
      const currentStable = await env.repository.snapshot(target);
      const stableBytes = new Map(await Promise.all(currentStable.paths.filter(path => path.startsWith('stable/') && !path.endsWith('/activation.json'))
        .map(async path => [path, await currentStable.read(path)] as const)));
      let writes = 0;
      let interruptFinal = target === 'main';
      let content = env.configuration;
      const context: RulesContext = { binary: binary!, targetBranch: target, allowWrites: true,
        readConfiguration: async () => ({ revision: 'f'.repeat(40), origin: 'migration-fixture', content }),
        repository: { branch: env.repository.branch, snapshot: env.repository.snapshot,
          lastChange: env.repository.lastChange!, download: env.transport.download,
          async commit(branch, expected, files, message, guard) {
            await guard(); writes++;
            assert.ok(Object.values(files).every(Buffer.isBuffer));
            if (interruptFinal && files[RULE_STATE_PATH] && JSON.parse(files[RULE_STATE_PATH]!.toString()).schemaVersion === 2) {
              interruptFinal = false; throw new Error('Interrupted before final journal commit');
            }
            return branch === env.repository.branch
              ? env.repository.commit(expected, files as Record<string, Buffer>, message)
              : env.transport.commit(expected, files as Record<string, Buffer>, message);
          } } };
      if (target === 'main') {
        const configuration = parseBuildConfiguration(content);
        configuration.ruleSets.find(rule => rule.id === 'openai')!.list = 'openai-alt';
        content = stringify(configuration);
      }
      const beforeHead = (await context.repository.snapshot()).head;
      const preview = await migrateRulesState({ context, dryRun: true });
      assert.equal(preview.status, 'planned');
      assert.equal(writes, 0);
      assert.equal((await context.repository.snapshot()).head, beforeHead);
      assert.equal((await context.repository.snapshot(target)).head, currentStable.head);
      assert.ok(preview.migration.pending.every(message => /historical publication time unavailable/.test(message)));
      if (target === 'main') {
        await assert.rejects(migrateRulesState({ context }), /RULE_MIGRATION_PENDING/);
        const checkpoint = JSON.parse((await (await context.repository.snapshot()).read(RULE_STATE_PATH))!.toString());
        assert.equal(checkpoint.schemaVersion, 1);
        assert.equal(checkpoint.maintenance, 'maintenance');
        const blocked = await getRulesStatus({ context });
        assert.equal(blocked.status, 'failed');
      }
      const migrated = await migrateRulesState({ context });
      assert.equal(migrated.status, 'converted');
      assert.equal(writes, target === 'main' ? 4 : 1);
      const next = parseRulesJournal((await (await context.repository.snapshot()).read(RULE_STATE_PATH))!);
      assert.equal(next.rules.openai.control.mode, target === 'main' ? 'auto' : 'pinned');
      assert.equal(next.rules.anthropic.control.mode, 'auto');
      const newStable = await context.repository.snapshot(target);
      for (const [path, bytes] of stableBytes) assert.deepEqual(await newStable.read(path), bytes, path);
      for (const candidate of Object.values(next.candidates)) {
        assert.equal(candidate.publishedAt, undefined);
        assert.equal(candidate.versionId, undefined);
        assert.match(candidate.migrationPending!, /Historical publication time is unavailable/);
      }
      const status = await getRulesStatus({ context });
      assert.equal(status.status, 'success', JSON.stringify(status));
      const selected = status.rules!.find(rule => rule.id === 'openai')!;
      assert.equal(selected.deliveryState, 'delivered');
      assert.equal(selected.current!.candidateId, openai.candidateId);
      assert.ok(selected.candidates.every(candidate => !candidate.selectable && /Historical publication time/.test(candidate.reason!)));
      assert.equal((await migrateRulesState({ context })).status, 'already-converted');
      assert.equal(writes, target === 'main' ? 4 : 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}


test('迁移隔离的未完成候选随定义删除；未知归属保持 pending', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-quarantine-'));
  try {
    const target = 'acceptance-issue-84-quarantine';
    const env = await configuredEnvironment(binary!, directory, target);
    const built = await checkRules({ binary: binary!, configuration: env.configuration, stateDirectory: directory, selectedIds: ['openai'],
      fetch: upstream(1).fetcher, publication: { repository: env.repository, commit: env.publish, download: env.transport.download },
      activation: env.transport, subscriptions: Object.fromEntries(env.ids.map(id => [id, env.subscription(id)])) });
    assert.equal(built.exitCode, 0, JSON.stringify(built));
    const { snapshot, journal } = await readRemoteState(env.repository);
    const original = Object.values(journal.state.candidates).find(candidate => candidate.logicalId === 'openai')!;
    const candidateId = randomUUID(), operationId = randomUUID();
    const incomplete = { ...original, id: candidateId, operationId, status: 'building' as const, phase: 'registered' as const };
    for (const key of ['buildId', 'filesCommit', 'metadataCommit', 'evidenceCommit', 'manifestUrl', 'evidenceUrl', 'evidenceSha256'] as const) delete incomplete[key];
    journal.state.candidates[candidateId] = incomplete;
    journal.state.pendingOperation = { ...journal.state.pendingOperation!, id: operationId, status: 'pending', candidateIds: [candidateId] };
    const partialPath = `candidates/${candidateId}/domains.json`;
    await env.repository.commit(snapshot.head, { [RULE_STATE_PATH]: encodeRecord(journal), [partialPath]: Buffer.from('partial') }, 'fixture: incomplete legacy publication');
    let content = env.configuration;
    const context: RulesContext = { binary: binary!, targetBranch: target, allowWrites: true,
      readConfiguration: async () => ({ revision: 'e'.repeat(40), origin: 'migration-fixture', content }),
      repository: { branch: env.repository.branch, snapshot: env.repository.snapshot, lastChange: env.repository.lastChange!, download: env.transport.download,
        async commit(_branch, expected, files, message, guard) {
          await guard();
          // The old fixture supports additive writes. Extend its stored tree to
          // exercise the same explicit path deletion as RulesRepository.
          const kept = Object.fromEntries(Object.entries(files).filter((entry): entry is [string, Buffer] => entry[1] !== null));
          const head = await env.repository.commit(expected, kept, message);
          const tree = env.snapshots.get(head)!;
          for (const [path, bytes] of Object.entries(files)) if (bytes === null) delete tree[path];
          return head;
        } } };
    await migrateRulesState({ context });
    const status = await getRulesStatus({ context, id: 'openai' });
    const partial = status.rules![0].candidates.find(candidate => candidate.id === candidateId)!;
    assert.equal(partial.selectable, false);
    assert.match(partial.reason!, /Incomplete historical publication/);
    assert.equal(status.quarantinedCandidates![candidateId].logicalId, 'openai');
    const configuration = parseBuildConfiguration(content);
    content = stringify({ ...configuration, sources: {}, ruleSets: [] });
    const deleted = await syncRules({ context });
    assert.equal(deleted.status, 'success', JSON.stringify(deleted));
    const final = await context.repository.snapshot();
    assert.equal(await final.read(partialPath), undefined);
    const next = parseRulesJournal((await final.read(RULE_STATE_PATH))!);
    assert.equal(next.quarantinedCandidates?.[candidateId], undefined);
    assert.equal(next.rules.openai.lifecycle, 'deleted');
    const orphan = randomUUID();
    next.quarantinedCandidates = { [orphan]: { id: orphan, reason: 'Historical candidate ownership is unresolved' } };
    await context.repository.commit(target, final.head, { [RULE_STATE_PATH]: encodeRecord(next), [`candidates/${orphan}/domains.json`]: Buffer.from('unowned') }, 'fixture: unknown owner', async () => {});
    const pending = await syncRules({ context });
    assert.equal(pending.status, 'pending');
    assert.match(pending.error!, /ownership is unresolved/);
    assert.equal((await getRulesStatus({ context })).status, 'pending');
    assert.ok(await (await context.repository.snapshot()).read(`candidates/${orphan}/domains.json`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
