import assert from 'node:assert/strict';
import { copyFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncRules } from '../../src/rules-operations.js';
import { sha256 } from '../../src/release.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

type Environment = ReturnType<typeof cleanupEnvironment>;
async function bytesUnder(env: Environment, prefix: string, branch = env.context.repository.branch) {
  const snapshot = await env.context.repository.snapshot(branch);
  return new Map(await Promise.all(snapshot.paths.filter(path => path.startsWith(prefix))
    .map(async path => [path, await snapshot.read(path)] as const)));
}

// Restore only the external Git store between independent faults. Each retained
// candidate and immutable stage was produced by the real application service.
function checkpoint(env: Environment) {
  const heads = new Map(env.heads);
  const trees = new Map([...env.trees].map(([head, tree]) => [head, new Map(tree)]));
  return () => {
    env.heads.clear(); for (const [ref, head] of heads) env.heads.set(ref, head);
    env.trees.clear(); for (const [head, tree] of trees) env.trees.set(head, new Map(tree));
    env.requests.length = 0;
  };
}

test('固定 URL 恢复拒绝变更后的输入快照，保留原候选与当前交付', async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context });
  assert.equal(first.status, 'success');
  env.upstream({ openai: 'domain:fixed-v2.example' });
  env.beforeWrite(async files => {
    if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata interrupted');
  });
  assert.equal((await syncRules({ context: env.context })).status, 'failed');
  env.beforeWrite();
  const before = await env.journal();
  const candidate = Object.values(before.candidates).find(candidate => candidate.status === 'publishing')!;
  assert.ok(candidate.filesCommit);
  const stable = await bytesUnder(env, 'stable/', 'main');
  const fixedInput = `candidates/${candidate.id}/input.source.yml`;
  const head = env.heads.get(env.context.repository.branch)!;
  const tree = env.trees.get(head)!;
  const original = tree.get(fixedInput);
  assert.ok(original);
  tree.set(fixedInput, Buffer.from('broken retained input'));
  env.requests.length = 0;
  const failed = await syncRules({ context: env.context });
  assert.equal(failed.status, 'failed');
  assert.match(failed.results[0].error!, /recorded digest or length/);
  assert.deepEqual(failed.results[0].current, first.results[0].current);
  assert.deepEqual((await env.journal()).candidates, before.candidates);
  assert.deepEqual(await bytesUnder(env, 'stable/', 'main'), stable);
  assert.equal(env.requests.length, 0);
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(fixedInput, original);
  const recovered = await syncRules({ context: env.context });
  assert.equal(recovered.status, 'success');
  assert.equal(recovered.results[0].current?.candidateId, candidate.id);
  assert.deepEqual(env.requests.map(url => url.split('/').at(-1)), ['dlc.dat_plain.yml.sha256sum', 'dlc.dat_plain.yml']);
});

function gitEnvironment(artifact = 'route') {
  const env = cleanupEnvironment(binary!, 'main'), config = env.config();
  config.sources = { cidr: { repository: 'gaoyifan/china-operator-ip', version: 'git-branch', branch: 'ip-lists',
    input: { format: 'cidr-text', path: 'china46.txt' } } };
  config.ruleSets = [{ id: 'china-ip', source: 'cidr', stablePath: 'stable/china-ip', artifact }];
  env.configure(config);
  const fixed = 'a'.repeat(40), latest = 'b'.repeat(40);
  const original = '192.0.2.0/24\n2001:db8::/32\n';
  let advanced = false, offline = false, replacement: string | undefined;
  env.context.fetch = async address => {
    const url = String(address); env.requests.push(url);
    if (url.includes('/branches/')) return Response.json({ name: 'ip-lists', commit: { sha: advanced ? latest : fixed } });
    if (offline) return new Response('', { status: 503 });
    if (url.endsWith(`/${fixed}/china46.txt`)) return new Response(replacement ?? original);
    if (url.endsWith(`/${latest}/china46.txt`)) return new Response('203.0.113.0/24\n');
    throw new Error(`Unexpected request ${url}`);
  };
  return { ...env, fixed, latest, original,
    advance() { advanced = true; }, offline(value: boolean) { offline = value; }, replaceInput(value?: string) { replacement = value; } };
}

test('Git 首次输入下载失败尚无候选，重试按最新分支建立候选', async () => {
  const env = gitEnvironment(); env.offline(true);
  const failed = await syncRules({ context: env.context });
  assert.equal(failed.status, 'failed'); assert.match(failed.results[0].error!, /HTTP 503/);
  assert.deepEqual((await env.journal()).candidates, {}); assert.equal(failed.results[0].current, undefined);
  env.offline(false); env.advance(); env.requests.length = 0;
  const result = await syncRules({ context: { ...env.context } });
  assert.equal(result.status, 'success', JSON.stringify(result));
  const source = result.results[0].current?.source;
  assert.ok(source && 'commit' in source); assert.equal(source.commit, env.latest);
  assert.equal(Object.keys((await env.journal()).candidates).length, 1);
  assert.ok(env.requests.some(url => url.includes('/branches/')));
  assert.ok(!env.requests.some(url => url.includes(`/${env.fixed}/`)));
});

for (const file of ['office-networks.json', 'office-networks.srs']) {
  test(`Git/CIDR ${file} 阶段 HTTPS 回读失败，按固定 commit 恢复原身份与字节`, async () => {
    const env = gitEnvironment('office-networks');
    env.failDownload(url => { if (url.endsWith('/' + file)) throw new Error('stage HTTPS unavailable'); });
    assert.equal((await syncRules({ context: env.context })).status, 'failed');
    const candidate = Object.values((await env.journal()).candidates)[0];
    assert.equal(candidate.status, 'publishing');
    assert.ok('commit' in candidate.source); assert.equal(candidate.source.commit, env.fixed);
    const retained = await bytesUnder(env, `candidates/${candidate.id}/`);
    assert.ok(retained.has(`candidates/${candidate.id}/${file}`));
    env.failDownload(); env.advance(); env.requests.length = 0; env.clock('2026-11-19T00:00:00.000Z');
    const result = await syncRules({ context: { ...env.context } });
    assert.equal(result.status, 'success', JSON.stringify(result));
    const after = await env.journal(), recovered = after.candidates[candidate.id];
    assert.deepEqual(Object.keys(after.candidates), [candidate.id]);
    assert.equal(result.results[0].current?.candidateId, candidate.id);
    assert.equal(recovered.buildId, candidate.buildId); assert.deepEqual(recovered.source, candidate.source);
    if (candidate.versionId) {
      assert.equal(recovered.versionId, candidate.versionId); assert.equal(recovered.publishedAt, candidate.publishedAt);
      assert.equal(result.results[0].current?.versionId, candidate.versionId);
    }
    for (const [path, bytes] of retained) assert.deepEqual((await bytesUnder(env, `candidates/${candidate.id}/`)).get(path), bytes, path);
    assert.deepEqual(env.requests, [`https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${env.fixed}/china46.txt`]);
    for (const path of retained.keys()) assert.equal(env.writes.filter(write => Object.hasOwn(write.files, path)).length, 1, path);
    const stable = await bytesUnder(env, 'stable/', 'main');
    const stableFile = stable.get(`stable/china-ip/${file}`);
    assert.ok(stableFile);
    assert.deepEqual(stableFile, (await bytesUnder(env, `candidates/${candidate.id}/`)).get(`candidates/${candidate.id}/${file}`));
  });
}

test('Git/CIDR 固定输入消失或变化拒绝恢复，恢复原输入后沿用已登记候选', async t => {
  const env = gitEnvironment();
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('metadata interrupted'); });
  assert.equal((await syncRules({ context: env.context })).status, 'failed'); env.beforeWrite();
  const candidate = Object.values((await env.journal()).candidates)[0];
  const retained = await bytesUnder(env, `candidates/${candidate.id}/`), restore = checkpoint(env);
  env.advance();
  for (const fault of ['missing-input', 'changed-input']) await t.test(fault, async () => {
    restore(); env.offline(fault === 'missing-input'); env.replaceInput(fault === 'changed-input' ? '203.0.113.0/24\n' : undefined);
    const failed = await syncRules({ context: { ...env.context } });
    assert.equal(failed.status, 'failed'); assert.match(failed.results[0].error!, fault === 'missing-input' ? /HTTP 503/ : /recorded digest or length/);
    assert.deepEqual((await env.journal()).candidates, { [candidate.id]: candidate });
    assert.deepEqual(await bytesUnder(env, `candidates/${candidate.id}/`), retained);
    assert.deepEqual(env.requests, [`https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${env.fixed}/china46.txt`]);
    assert.equal(failed.results[0].current, undefined);
  });
  restore(); env.offline(false); env.replaceInput();
  const recovered = await syncRules({ context: { ...env.context } });
  assert.equal(recovered.status, 'success', JSON.stringify(recovered));
  assert.equal(recovered.results[0].current?.candidateId, candidate.id);
  assert.equal((await env.journal()).candidates[candidate.id].buildId, candidate.buildId);
});

for (const stage of ['metadata', 'evidence']) test(`Git/CIDR ${stage} 恢复拒绝保留文件篡改或缺失`, async t => {
  const env = gitEnvironment('office-networks');
  if (stage === 'metadata') {
    env.failDownload(url => { if (url.includes('/candidates/') && url.endsWith('/office-networks.srs')) throw new Error('candidate HTTPS unavailable'); });
  } else {
    env.beforeWrite(async files => {
      const state = files[RULE_STATE_PATH];
      if (state && parseRulesJournal(state).pendingDelivery) throw new Error('RULE_WRITE_CONFLICT: interrupted after evidence');
    });
  }
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  env.failDownload(); env.beforeWrite();
  const candidate = Object.values((await env.journal()).candidates)[0], restore = checkpoint(env);
  for (const fault of ['changed-custom.srs', 'missing-build.json', ...(stage === 'evidence' ? ['wrong-version'] : [])]) await t.test(fault, async () => {
    restore();
    const tree = env.trees.get(env.heads.get(env.context.repository.branch)!)!;
    const prefix = `candidates/${candidate.id}/`;
    if (fault === 'changed-custom.srs') tree.set(prefix + 'office-networks.srs', Buffer.from('tampered retained SRS'));
    else if (fault === 'missing-build.json') tree.delete(prefix + 'build.json');
    else tree.set(prefix + 'readback.json', encodeRecord({ ...JSON.parse(tree.get(prefix + 'readback.json')!.toString()), versionId: 'wrong' }));
    const retained = await bytesUnder(env, prefix), stableHead = env.heads.get('main');
    const failed = await syncRules({ context: { ...env.context } });
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.match(failed.results[0].error!, /CANDIDATE_UNAVAILABLE|Missing retained file|Readback integrity/);
    assert.deepEqual((await env.journal()).candidates, { [candidate.id]: candidate });
    assert.deepEqual(await bytesUnder(env, prefix), retained); assert.equal(env.heads.get('main'), stableHead);
    assert.equal(failed.results[0].current, undefined);
  });
  if (stage === 'evidence') {
    restore();
    assert.ok(candidate.versionId);
    const recovered = await syncRules({ context: { ...env.context } });
    assert.equal(recovered.status, 'success', JSON.stringify(recovered));
    assert.equal(recovered.results[0].current?.candidateId, candidate.id);
    assert.equal(recovered.results[0].current?.versionId, candidate.versionId);
    assert.ok(recovered.results[0].current?.files['stable/china-ip/office-networks.srs']);
  }
});

test('正常 sync 工具字节变化产生新 buildId，旧候选、来源和稳定语义保留', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rules-new-tool-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const changed = join(directory, 'sing-box'); await copyFile(binary!, changed); await appendFile(changed, '\nissue-95-tool-identity\n');
  const env = cleanupEnvironment(binary!, 'main'), config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  const old = (await env.journal()).candidates[first.results[0].current!.candidateId];
  const retained = await bytesUnder(env, `candidates/${old.id}/`), stable = await bytesUnder(env, 'stable/', 'main');
  const result = await syncRules({ context: { ...env.context, binary: changed } });
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.results[0].status, 'delivered');
  const next = (await env.journal()).candidates[result.results[0].current!.candidateId];
  assert.notEqual(next.id, old.id); assert.notEqual(next.buildId, old.buildId); assert.notEqual(next.versionId, old.versionId);
  assert.deepEqual(next.source, old.source); assert.deepEqual((await env.journal()).candidates[old.id], old);
  assert.deepEqual(await bytesUnder(env, `candidates/${old.id}/`), retained);
  const after = await bytesUnder(env, 'stable/', 'main');
  for (const path of ['stable/openai/domains.json', 'stable/openai/domains.srs']) {
    assert.ok(stable.get(path), path); assert.deepEqual(after.get(path), stable.get(path), path);
  }
});

test('当前候选与 pendingDelivery 关联事实损坏不能驱动恢复交付', async t => {
  const env = cleanupEnvironment(binary!, 'main'), config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
  env.upstream({ openai: 'domain:pending.example' });
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.startsWith('stable/'))) throw new Error('stable commit unavailable'); });
  assert.equal((await syncRules({ context: env.context })).status, 'pending'); env.beforeWrite();
  const before = await env.journal(), pending = before.pendingDelivery!;
  assert.ok(pending); assert.ok(pending.record);
  const restore = checkpoint(env), stable = await bytesUnder(env, 'stable/', 'main');
  for (const fault of ['missing-write-id', 'invalid-parent', 'missing-candidate', 'changed-content', 'missing-control', 'changed-binding', 'wrong-logical-id']) await t.test(fault, async () => {
    restore(); const journal = structuredClone(before), candidate = journal.candidates[pending.record!.candidateId];
    if (fault === 'missing-write-id') delete (journal.pendingDelivery as Partial<typeof pending>).id;
    if (fault === 'invalid-parent') journal.pendingDelivery!.stableHead = 'not-a-commit';
    if (fault === 'missing-candidate') delete journal.candidates[candidate.id];
    if (fault === 'changed-content') Object.values(journal.pendingDelivery!.changes).find(value => value !== null)!.sha256 = 'f'.repeat(64);
    if (fault === 'missing-control') delete candidate.controlRevision;
    if (fault === 'changed-binding') candidate.inputBindingRevision = 'f'.repeat(64);
    if (fault === 'wrong-logical-id') candidate.logicalId = 'anthropic';
    const tree = env.trees.get(env.heads.get(env.context.repository.branch)!)!;
    tree.set(RULE_STATE_PATH, encodeRecord(journal));
    const writes = env.writes.length, heads = new Map(env.heads), state = tree.get(RULE_STATE_PATH);
    const result = await syncRules({ context: { ...env.context } });
    assert.notEqual(result.status, 'success', JSON.stringify(result));
    assert.match(result.error!, /RULE_STATE_CORRUPT|pending delivery has no retained version|registered content changed/);
    assert.equal(env.requests.length, 0); assert.equal(env.writes.length, writes); assert.deepEqual(env.heads, heads);
    assert.deepEqual(tree.get(RULE_STATE_PATH), state); assert.deepEqual(await bytesUnder(env, 'stable/', 'main'), stable);
  });
});
