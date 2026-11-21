import assert from 'node:assert/strict';
import test from 'node:test';
import { pinRuleVersion, syncRules } from '../../src/rules-operations.js';
import type { RuleWrites } from '../../src/rules-repository.js';
import { encodeRecord, RULE_RECEIPT_PATH, RULE_STATE_PATH } from '../../src/rules-model.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;

for (const target of ['acceptance-stable-check', 'main']) {
  test(`一次 sync 只在同一稳定提交上核验一次已固定规则的产物，下一次重新核验（${target}）`, { skip: !binary }, async () => {
    const { context } = rulesEnvironment(binary!, target);
    const first = await syncRules({ context });
    assert.equal(first.exitCode, 0);
    const version = first.results.find(row => row.id === 'anthropic')!.current!.versionId;
    assert.ok(version);
    assert.equal((await pinRuleVersion({ context, id: 'anthropic', version })).exitCode, 0);
    const original = context.repository.snapshot;
    const head = (await original(target)).head;
    const reads: string[] = [];
    context.repository.snapshot = async (...args) => {
      const snapshot = await original(...args);
      return { ...snapshot, read(path) {
        if (path === 'stable/anthropic/domains.srs') reads.push(snapshot.head);
        return snapshot.read(path);
      } };
    };
    for (let i = 0; i < 2; i++) {
      reads.length = 0;
      const result = await syncRules({ context });
      assert.equal(result.exitCode, 0);
      assert.equal(result.results.find(row => row.id === 'anthropic')?.status, 'pinned-skipped');
      assert.equal((await original(target)).head, head);
      assert.deepEqual(reads, [head]);
    }
  });
}

test('双分支交付只对通过路径检查的稳定提交登记写入', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!, 'main');
  const { context } = env;
  assert.equal((await syncRules({ context })).exitCode, 0);
  env.upstream({ openai: 'domain:changed.example' });
  const repo = context.repository;
  const original = repo.snapshot;
  const stable = await original('main');
  const receipt = await stable.read(RULE_RECEIPT_PATH);
  let prepared = false;
  let external: string | undefined;
  repo.snapshot = async (...args) => {
    const view = await original(...args);
    if (prepared && args[0] === 'main' && !external) {
      external = await repo.commit('main', view.head, { 'stable/openai/note.txt': Buffer.from('external') },
        '模拟检查后并发写入', async () => {});
    }
    return view;
  };
  const result = await syncRules({ context, onProgress(event) {
    if (event.stage === 'prepare-delivery' && event.logicalId === 'openai') prepared = true;
  } });
  assert.ok(external);
  assert.equal(result.exitCode, 1);
  const final = await original('main');
  assert.equal(final.head, external);
  assert.deepEqual(await final.read(RULE_RECEIPT_PATH), receipt);
});

test('完整校验失败后在同一提交上重读文件并报告持久化状态', { skip: !binary }, async () => {
  const { context, writes } = rulesEnvironment(binary!, 'main');
  assert.equal((await syncRules({ context })).exitCode, 0);
  const before = writes.length;
  const original = context.repository.snapshot;
  let attempts = 0;
  context.repository.snapshot = async (...args) => {
    const view = await original(...args);
    return { ...view, async read(path) {
      if (path === 'stable/anthropic/domains.srs' && ++attempts === 1) throw new Error('transient stable read');
      return view.read(path);
    } };
  };
  const failed = await syncRules({ context });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.error ?? '', /transient stable read/);
  assert.ok(failed.observedHeads?.stable);
  assert.equal(attempts, 2);
  assert.equal(writes.length, before);
  assert.equal((await syncRules({ context })).exitCode, 0);
});

test('交付前重新观察到新提交时检查全部文件、路径归属及当前交付', { skip: !binary }, async t => {
  const seed = rulesEnvironment(binary!, 'main');
  const config = seed.config();
  config.ruleSets = config.ruleSets.filter(rule => rule.id === 'openai');
  seed.configure(config);
  const first = await syncRules({ context: seed.context });
  assert.equal(first.exitCode, 0);
  const record = first.results[0].current!;
  const checkpoint = seed.checkpoint();
  for (const fault of ['invalid-bytes', 'unmanaged-file', 'overlapping-root', 'replaced-delivery']) await t.test(fault, async () => {
    const env = rulesEnvironment(binary!, 'main', checkpoint());
    env.upstream({ openai: 'domain:changed.example' });
    const repo = env.context.repository;
    const original = repo.snapshot;
    const stable = await original('main');
    const recordPath = 'stable/openai/activation.json';
    const files: RuleWrites = {};
    if (fault === 'invalid-bytes') files['stable/openai/domains.srs'] = Buffer.from('broken');
    if (fault === 'unmanaged-file') files['stable/openai/notes.txt'] = Buffer.from('external');
    if (fault === 'overlapping-root') {
      const child = 'stable/openai/another';
      const path = 'stable/openai/domains.srs';
      files[child + '/domains.srs'] = (await stable.read(path))!;
      files[child + '/activation.json'] = encodeRecord({ ...record, logicalId: 'another',
        files: { [child + '/domains.srs']: record.files[path] } });
    }
    if (fault === 'replaced-delivery') files[recordPath] = encodeRecord({ ...record, id: 'external-delivery' });
    let prepare = false;
    let external: string | undefined;
    repo.snapshot = async (...args) => {
      if (prepare && !external && args[0] === 'main') external = await repo.commit('main', stable.head, files, '模拟稳定提交变化', async () => {});
      return original(...args);
    };
    const result = await syncRules({ context: env.context, onProgress(event) {
      if (event.stage === 'prepare-delivery') prepare = true;
    } });
    assert.ok(external);
    assert.equal(result.exitCode, 1);
    assert.match(result.results[0].error ?? '', /RULE_DELIVERY_CORRUPT|SUBSCRIPTION_PATH_CONFLICT|RULE_WRITE_CONFLICT/);
    assert.equal((await original('main')).head, external);
  });
});

test('删除已下线的规则前核验新稳定提交上的文件', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!, 'main');
  const { context } = env;
  assert.equal((await syncRules({ context })).exitCode, 0);
  const config = env.config();
  config.ruleSets = config.ruleSets.filter(rule => rule.id !== 'openai');
  env.configure(config);
  let deleting = false;
  env.beforeWrite(async files => {
    const journal = files[RULE_STATE_PATH];
    if (journal && JSON.parse(journal.toString()).rules.openai.lifecycle === 'deleting') deleting = true;
  });
  const repo = context.repository;
  const original = repo.snapshot;
  let external: string | undefined;
  repo.snapshot = async (...args) => {
    const stable = await original(...args);
    if (deleting && !external && args[0] === 'main') {
      external = await repo.commit('main', stable.head, { 'stable/openai/domains.srs': Buffer.from('external change') },
        '模拟删除前的稳定提交变化', async () => {});
    }
    return stable;
  };
  const result = await syncRules({ context });
  assert.ok(external);
  assert.equal(result.exitCode, 1);
  assert.equal((await original('main')).head, external);
  assert.ok(await (await original('main')).read('stable/openai/activation.json'));
});

test('单分支从已登记的交付恢复时保留后来写入的稳定文件', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!);
  const { context } = env;
  const repo = context.repository;
  env.beforeWrite(async files => {
    if (files['stable/openai/activation.json']) throw new Error('模拟稳定写入中断');
  });
  const interrupted = await syncRules({ context });
  assert.equal(interrupted.status, 'pending');
  env.beforeWrite();
  const registration = await repo.snapshot();
  const file = 'stable/openai/domains.srs';
  const external = await repo.commit(repo.branch, registration.head, { [file]: Buffer.from('external') }, '模拟登记后写入', async () => {});
  const result = await syncRules({ context });
  assert.equal(result.status, 'pending');
  const observed = await repo.snapshot();
  assert.equal(observed.head, external);
  assert.equal((await observed.read(file))!.toString(), 'external');
});
