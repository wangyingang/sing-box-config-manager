import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
for (const target of ['acceptance-issue-84', 'main']) {
  test(`${target}: 新增、更新、固定、恢复和删除保持同一稳定订阅`, { skip: !binary }, async () => {
    const env = rulesEnvironment(binary!, target);
    const request = { context: env.context };
    const first = await syncRules(request);
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.deepEqual(first.results.map(result => result.status), ['delivered', 'delivered']);
    const original = first.results.find(result => result.id === 'openai')!.current!.versionId!;
    const stableFiles = Object.keys(first.results[0].current!.files);
    const beforeUnchanged = env.writes.length;
    const unchanged = await syncRules(request);
    assert.deepEqual(unchanged.results.map(result => result.status), ['unchanged', 'unchanged']);
    assert.equal(env.writes.length, beforeUnchanged);
    env.upstream({ openai: 'domain:new.example' });
    const updated = await syncRules(request);
    assert.deepEqual(updated.results.map(result => result.status), ['delivered', 'unchanged']);
    const pin = await pinRuleVersion({ ...request, id: 'openai', version: original });
    assert.equal(pin.status, 'success', JSON.stringify(pin));
    assert.equal(pin.results[0].control?.mode, 'pinned');
    assert.equal(pin.results[0].current?.versionId, original);
    const pinnedCheck = await syncRules(request);
    assert.equal(pinnedCheck.results.find(result => result.id === 'openai')!.status, 'pinned-skipped');
    const resumed = await resumeRuleUpdates({ ...request, id: 'openai' });
    assert.equal(resumed.status, 'success', JSON.stringify(resumed));
    assert.equal(resumed.results[0].control?.mode, 'auto');
    assert.notEqual(resumed.results[0].current?.versionId, original);
    assert.deepEqual(Object.keys(resumed.results[0].current!.files), stableFiles);
    const configuration = env.config();
    configuration.ruleSets = configuration.ruleSets.filter(rule => rule.id !== 'openai');
    env.configure(configuration);
    const removed = await syncRules(request);
    assert.equal(removed.status, 'success', JSON.stringify(removed));
    assert.equal(removed.results.find(result => result.id === 'openai')!.status, 'deleted');
    const snapshot = await env.context.repository.snapshot(target);
    assert.ok(!snapshot.paths.some(path => path.startsWith('stable/openai/')));
    const status = await getRulesStatus(request);
    assert.deepEqual(status.rules?.map(rule => rule.id), ['anthropic']);
  });
}

test('换源失败保留交付但撤销 pin；别名保持 pin；旧来源可明确重选', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  const first = await syncRules(request); const old = first.results[0].current!;
  assert.equal((await pinRuleVersion({ ...request, id: 'openai', version: old.versionId! })).status, 'success');
  let config = env.config(); config.sources.alias = config.sources.dlc;
  config.ruleSets[0].source = 'alias'; env.configure(config);
  assert.equal((await syncRules(request)).results.find(x => x.id === 'openai')?.status, 'pinned-skipped');
  config = env.config();
  const alias = config.sources.alias; assert.equal(alias.version, 'latest-release');
  config.sources.alias = { ...alias, repository: 'another/rules' }; env.configure(config);
  env.failSource('another/rules'); const changed = await syncRules(request);
  assert.equal(changed.status, 'partial', JSON.stringify(changed));
  const failed = changed.results.find(x => x.id === 'openai')!;
  assert.equal(failed.control?.mode, 'auto'); assert.equal(failed.current?.versionId, old.versionId);
  assert.ok(failed.expectedSource?.version === 'latest-release'); assert.equal(failed.expectedSource.repository, 'another/rules');
  const selectedSource = (await getRulesStatus({ ...request, id: 'openai' })).rules?.[0].current?.source;
  assert.ok(selectedSource && 'repository' in selectedSource && 'repository' in old.source);
  assert.equal(selectedSource.repository, old.source.repository);
  env.failSource(false); assert.equal((await syncRules(request)).status, 'success');
  const repin = await pinRuleVersion({ ...request, id: 'openai', version: old.versionId! });
  assert.equal(repin.status, 'success', JSON.stringify(repin)); const count = env.writes.length;
  assert.equal((await pinRuleVersion({ ...request, id: 'openai', version: old.versionId! })).status, 'success');
  assert.equal(env.writes.length, count);
  env.failSource(true); const resumed = await resumeRuleUpdates({ ...request, id: 'openai' });
  assert.equal(resumed.status, 'failed'); assert.equal(resumed.results[0].control?.mode, 'auto');
  assert.equal(resumed.results[0].current?.versionId, old.versionId);
});

test('混合新增换源删除独立完成；空集合删除全部；重加不继承固定', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  const first = await syncRules(request);
  await pinRuleVersion({ ...request, id: 'openai', version: first.results[0].current!.versionId! });
  const config = env.config(); const dlc = config.sources.dlc; assert.equal(dlc.version, 'latest-release');
  config.sources.failing = { ...dlc, repository: 'failing/source' };
  config.ruleSets = [{ ...config.ruleSets[0], source: 'failing' },
    { ...config.ruleSets[1], id: 'new-rule', list: 'other', stablePath: 'stable/new-rule' }];
  env.configure(config); env.failSource('failing/source'); const mixed = await syncRules(request);
  assert.equal(mixed.status, 'partial', JSON.stringify(mixed));
  assert.deepEqual(Object.fromEntries(mixed.results.map(x => [x.id, x.status])), { anthropic: 'deleted', openai: 'failed', 'new-rule': 'delivered' });
  env.failSource(false); assert.equal((await syncRules(request)).status, 'success');
  env.configure({ ...config, ruleSets: [], sources: {} });
  assert.equal((await syncRules(request)).status, 'success'); assert.equal((await syncRules(request)).results.length, 0);
  const snapshot = await env.context.repository.snapshot();
  assert.ok(!snapshot.paths.some(path => /^(stable|candidates)\//.test(path)));
  env.configure(config); const added = await syncRules(request); assert.equal(added.results[0].control?.mode, 'auto');
  assert.equal((await pinRuleVersion({ ...request, id: 'openai', version: first.results[0].current!.versionId! })).status, 'failed');
});

test('查询、三个 dry-run 和无效 pin 零写入；草稿不能写；首次失败未交付', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  assert.equal((await syncRules({ ...request, dryRun: true })).status, 'success'); assert.equal(env.writes.length, 0);
  env.failSource(true); assert.equal((await syncRules(request)).status, 'failed');
  assert.equal((await getRulesStatus(request)).rules?.[0].deliveryState, 'not-delivered');
  env.failSource(false); const first = await syncRules(request); const version = first.results[0].current!.versionId!;
  const before = env.writes.length; const status = await getRulesStatus(request); assert.equal(status.rules?.[0].candidateCount, 1);
  assert.equal((await pinRuleVersion({ ...request, id: 'openai', version, dryRun: true })).status, 'success');
  assert.equal((await resumeRuleUpdates({ ...request, id: 'openai', dryRun: true })).status, 'success');
  assert.equal((await syncRules({ ...request, dryRun: true })).status, 'success');
  assert.equal((await pinRuleVersion({ ...request, id: 'openai', version: 'missing' })).status, 'failed');
  assert.equal((await syncRules({ ...request, draft: (await env.context.readConfiguration()).content })).status, 'failed');
  assert.equal((await syncRules({ ...request, dryRun: true, draft: 'ruleSets: []' })).status, 'failed');
  assert.equal(env.writes.length, before);
  const previous = env.context.readConfiguration;
  env.context.readConfiguration = async () => ({ ...await previous(), content: 'ruleSets: []' });
  assert.equal((await syncRules(request)).status, 'failed'); assert.equal(env.writes.length, before);
});

test('固定目标不请求其独立上游，其他集继续；旧配置在写前失效', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  const config = env.config(); const dlc = config.sources.dlc; assert.equal(dlc.version, 'latest-release');
  config.sources.independent = { ...dlc, repository: 'separate/rules' };
  config.ruleSets[0].source = 'independent'; env.configure(config);
  const first = await syncRules(request);
  await pinRuleVersion({ ...request, id: 'openai', version: first.results[0].current!.versionId! });
  env.requests.length = 0; env.upstream({ anthropic: 'domain:changed.example' });
  assert.equal((await syncRules(request)).status, 'success'); assert.ok(!env.requests.some(url => url.includes('separate/rules')));
  const before = env.writes.length; env.beforeWrite(async () => { env.configure(env.config()); });
  const raced = await resumeRuleUpdates({ ...request, id: 'openai' });
  assert.equal(raced.status, 'failed'); assert.equal(env.writes.length, before);
  assert.equal(raced.results[0].control?.mode, 'pinned');
  assert.equal((await getRulesStatus({ ...request, id: 'openai' })).rules?.[0].control?.mode, 'pinned');
});

test('双分支写回复丢失采用已提交结果；HTTPS待核实显示真实交付且换机续做不重复发布', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const repository = env.context.repository; const commit = repository.commit;
  const { PublicationWriteError } = await import('../../src/publication-repository.js');
  let lost = false;
  repository.commit = async (...args) => {
    const head = await commit(...args);
    if (!lost && args[0] === 'main') { lost = true; throw new PublicationWriteError(head, new Error('response lost')); }
    return head;
  };
  const download = repository.download;
  repository.download = async url => { if (url.includes('/stable/')) throw new Error('HTTPS readback unavailable'); return download(url); };
  const pending = await syncRules({ context: env.context });
  assert.equal(pending.status, 'pending', JSON.stringify(pending));
  assert.ok(pending.results[0].current?.versionId, 'confirmed stable commit must be reported even while readback is pending');
  const status = await getRulesStatus({ context: env.context });
  assert.equal(status.status, 'pending'); assert.equal(status.rules?.[0].current?.versionId, pending.results[0].current?.versionId);
  const stableWrites = env.writes.filter(write => write.branch === 'main').length;
  repository.download = download;
  const resumed = await syncRules({ context: { ...env.context } });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].current?.versionId, pending.results[0].current?.versionId);
  assert.equal(env.writes.filter(write => write.branch === 'main').length, stableWrites);
  assert.equal((await getRulesStatus({ context: env.context })).rules?.[0].candidateCount, 1);
});

test('订阅路径变更被拒绝后，删除仍撤销真实旧路径及记录', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  assert.equal((await syncRules(request)).status, 'success');
  const config = env.config(); config.ruleSets[0].stablePath = 'stable/moved-openai'; env.configure(config);
  const incompatible = await syncRules(request);
  assert.equal(incompatible.status, 'partial');
  assert.equal(incompatible.results.find(x => x.id === 'openai')?.status, 'failed');
  assert.ok(incompatible.results.find(x => x.id === 'openai')?.current?.files['stable/openai/domains.srs']);
  config.ruleSets = config.ruleSets.filter(rule => rule.id !== 'openai'); env.configure(config);
  const removed = await syncRules(request); assert.equal(removed.status, 'success', JSON.stringify(removed));
  const snapshot = await env.context.repository.snapshot();
  assert.ok(!snapshot.paths.some(path => path.startsWith('stable/openai/') || path.startsWith('stable/moved-openai/')));
  assert.equal((await getRulesStatus(request)).status, 'success');
});

test('新定义不能占用兼容性失败后仍交付的旧路径；pinned也验证契约', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  const first = await syncRules(request); const original = first.results.find(x => x.id === 'openai')!.current!;
  await pinRuleVersion({ ...request, id: 'openai', version: original.versionId! });
  const config = env.config(); config.ruleSets[0].stablePath = 'stable/moved-openai';
  config.ruleSets.push({ ...config.ruleSets[0], id: 'other', list: 'other', stablePath: 'stable/openai' }); env.configure(config);
  const result = await syncRules(request); assert.equal(result.status, 'partial');
  assert.equal(result.results.find(x => x.id === 'openai')?.status, 'failed');
  assert.equal(result.results.find(x => x.id === 'other')?.status, 'failed');
  const status = await getRulesStatus(request);
  const actual = status.rules!.find(x => x.id === 'openai')!;
  assert.equal(actual.current?.versionId, original.versionId); assert.equal(actual.candidateCount, 0);
  assert.equal(status.rules!.find(x => x.id === 'other')?.deliveryState, 'not-delivered');
  const snapshot = await env.context.repository.snapshot();
  const record = JSON.parse((await snapshot.read('stable/openai/activation.json'))!.toString());
  assert.equal(record.logicalId, 'openai');
});

test('pin和resume改变控制修订后，不恢复被取代的旧候选任务', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!); const request = { context: env.context };
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules(request); const original = first.results[0].current!.versionId!;
  env.upstream({ openai: 'domain:v2.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata upload unavailable'); });
  assert.equal((await syncRules(request)).status, 'failed');
  env.beforeWrite(); assert.equal((await pinRuleVersion({ ...request, id: 'openai', version: original })).status, 'success');
  env.upstream({ openai: 'domain:v3.example' }); env.requests.length = 0;
  const resumed = await resumeRuleUpdates({ ...request, id: 'openai' });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal((resumed.results[0].current!.source as { releaseId: number }).releaseId, 3);
  assert.ok(!env.requests.some(url => /\/releases\/2$/.test(url)));
});

test('稳定字节损坏时，sync与resume不得先接受换源或解除固定', { skip: !binary }, async () => {
  for (const operation of ['sync', 'resume'] as const) {
    const env = rulesEnvironment(binary!, 'main'); const request = { context: env.context };
    const first = await syncRules(request);
    await pinRuleVersion({ ...request, id: 'openai', version: first.results[0].current!.versionId! });
    const stable = await env.context.repository.snapshot('main');
    env.trees.get(stable.head)!.set('stable/openai/domains.srs', Buffer.from('corrupt'));
    const config = env.config(); config.ruleSets[0].list = 'other'; env.configure(config);
    const before = env.writes.length;
    const result = operation === 'sync' ? await syncRules(request) : await resumeRuleUpdates({ ...request, id: 'openai' });
    assert.notEqual(result.status, 'success'); assert.equal(env.writes.length, before);
    const state = JSON.parse((await (await env.context.repository.snapshot()).read('pipeline/state.json'))!.toString());
    assert.equal(state.rules.openai.control.mode, 'pinned'); assert.equal(state.rules.openai.definition.list, 'openai');
  }
});

for (const stage of ['evidence', 'metadata'] as const) test(`${stage}阶段已提交但检查点中断，换机不同binary路径继续原候选`, { skip: !binary }, async t => {
  const { mkdtemp, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'rules-recovery-binary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const movedBinary = join(directory, 'sing-box'); await copyFile(binary!, movedBinary);
  const env = rulesEnvironment(binary!); const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const repository = env.context.repository, commit = repository.commit;
  const stageFile = stage === 'evidence' ? '/readback.json' : '/build.json';
  repository.commit = async (...args) => {
    const head = await commit(...args);
    if (Object.keys(args[2]).some(path => path.endsWith(stageFile))) {
      throw new Error(`RULE_WRITE_CONFLICT: process stopped after ${stage} commit`);
    }
    return head;
  };
  assert.equal((await syncRules({ context: env.context })).status, 'failed');
  const snapshot = await repository.snapshot();
  const state = JSON.parse((await snapshot.read('pipeline/state.json'))!.toString());
  const candidate = Object.values(state.candidates)[0] as { id: string; versionId: string; publishedAt: string; status: string };
  assert.equal(candidate.status, 'publishing');
  const evidence = await snapshot.read(`candidates/${candidate.id}/readback.json`);
  const build = await snapshot.read(`candidates/${candidate.id}/build.json`); assert.ok(build);
  if (stage === 'evidence') assert.ok(evidence);
  repository.commit = commit; env.failSource(stage === 'evidence'); env.requests.length = 0;
  const resumed = await syncRules({ context: { ...env.context, binary: movedBinary } });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].current?.candidateId, candidate.id);
  if (stage === 'evidence') {
    assert.equal(env.requests.length, 0);
    assert.equal(resumed.results[0].current?.versionId, candidate.versionId);
    assert.equal(resumed.results[0].current?.publishedAt, candidate.publishedAt);
    assert.deepEqual(await (await repository.snapshot()).read(`candidates/${candidate.id}/readback.json`), evidence);
  }
  assert.deepEqual(await (await repository.snapshot()).read(`candidates/${candidate.id}/build.json`), build);
});
