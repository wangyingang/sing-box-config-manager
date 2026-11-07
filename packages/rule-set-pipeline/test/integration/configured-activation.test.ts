import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules } from '../../src/activation.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { readRemoteState, STATE_PATH } from '../../src/remote-state.js';
import { readUpdateState } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import { configuredEnvironment } from './configured-activation-fixture.js';
const binary = process.env.SING_BOX_TEST_BINARY;
async function isolated(run: (env: Awaited<ReturnType<typeof configuredEnvironment>>, directory: string) => Promise<void>, branch?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'configured-activation-'));
  try { await run(await configuredEnvironment(binary!, directory, branch), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('三集依次激活再逐集切换，只改变选中集的稳定字节、版本与历史', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = await env.candidates(), second = await env.candidates();
  for (const id of env.ids) await activateRules(env.options(id, first[id].evidenceUrl!));
  for (const id of env.ids) {
    const before = env.snapshots.get(env.head())!;
    const statusBefore = await readUpdateState(directory);
    const result = await activateRules(env.options(id, second[id].evidenceUrl!));
    assert.equal(result.activation.candidateId, second[id].id);
    const after = env.snapshots.get(env.head())!;
    const changed = Object.keys(after).filter(path => path.startsWith('stable/') && !after[path].equals(before[path]));
    assert.deepEqual(changed.sort(), [`stable/${id}/activation.json`, `stable/${id}/domains.json`, `stable/${id}/domains.srs`]);
    const status = await readUpdateState(directory);
    assert.equal(status.activeRuleVersions[id].activation.candidateId, second[id].id);
    assert.equal(status.activeRuleVersions[id].activation.history.length, 1);
    for (const sibling of env.ids.filter(other => other !== id)) {
      assert.deepEqual(status.activeRuleVersions[sibling], statusBefore.activeRuleVersions[sibling]);
      const endpoint = env.subscription(sibling).projections.route.formats.binary.url;
      assert.deepEqual(await env.transport.download(endpoint), before[`stable/${sibling}/domains.srs`]);
    }
  }
  assert.deepEqual(Object.keys((await readUpdateState(directory)).activeRuleVersions).sort(), [...env.ids].sort());
}));

for (const fault of ['wrong-set', 'duplicate-ids', 'missing', 'extra', 'evidence', 'srs', 'native', 'usage', 'capability', 'reuse', 'path', 'v1', 'old-record', 'old-bytes']) {
  test(`${fault} 在切换前拒绝，原稳定 URL 仍交付原字节`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const first = await env.candidates();
    const id = env.ids[0];
    await activateRules(env.options(id, first[id].evidenceUrl!));
    const second = await env.candidates();
    const options = env.options(id, second[id].evidenceUrl!);
    const before = new Map(Object.entries(env.snapshots.get(env.head())!));
    const oldHead = env.head(), writes = env.writes();
    const evidence = JSON.parse(env.stored.get(options.candidateEvidenceUrl)!.toString());
    const record = (name: string) => evidence.readback.find((entry: any) => entry.url.endsWith(`/${name}`));
    const alter = (name: string, change: (value: any) => void) => {
      const entry = record(name), value = JSON.parse(env.stored.get(entry.url)!.toString());
      change(value);
      const bytes = Buffer.from(JSON.stringify(value)); env.stored.set(entry.url, bytes);
      entry.sha256 = sha256(bytes); entry.byteLength = bytes.length;
      env.stored.set(options.candidateEvidenceUrl, Buffer.from(JSON.stringify(evidence)));
    };
    if (fault === 'wrong-set') options.candidateEvidenceUrl = second[env.ids[1]].evidenceUrl!;
    if (fault === 'missing') env.stored.delete(record('domains.srs').url);
    if (fault === 'duplicate-ids') alter('manifest.json', m => {
      for (const artifact of m.artifacts) artifact.id = 'duplicated';
      m.projections.route.artifactIds = ['duplicated', 'missing-route-artifact'];
      m.projections['dns-query'].artifactIds = ['duplicated', 'missing-query-artifact'];
    });
    if (fault === 'extra') alter('manifest.json', m => m.artifacts.push({ ...m.artifacts[0], id: 'extra' }));
    if (fault === 'evidence') { evidence.readback.pop(); env.stored.set(options.candidateEvidenceUrl, Buffer.from(JSON.stringify(evidence))); }
    if (fault === 'srs') {
      const entry = record('domains.srs'), bytes = Buffer.from('not SRS'); env.stored.set(entry.url, bytes);
      entry.sha256 = sha256(bytes); entry.byteLength = bytes.length;
      alter('manifest.json', m => { const a = m.artifacts.find((a: any) => a.format === 'binary'); a.sha256 = entry.sha256; a.byteLength = bytes.length; });
      alter('build.json', b => { const a = b.artifacts.find((a: any) => a.format === 'binary'); a.sha256 = entry.sha256; a.bytes = bytes.length; });
    }
    if (fault === 'native') options.binary = '/missing/sing-box';
    if (fault === 'usage') options.subscription.projections['dns-response'] = options.subscription.projections.route as any;
    if (fault === 'capability') (options.subscription.projections.route.formats.binary.requiredCapabilities as string[]).push('processMatching');
    if (fault === 'reuse') options.subscription.projections['dns-query'].formats.binary.url = options.subscription.projections.route.formats.source.url;
    if (fault === 'path') options.subscription.projections.route.formats.binary.url = env.subscription(env.ids[1]).projections.route.formats.binary.url;
    if (fault === 'v1') options.subscription.schemaVersion = 1;
    if (fault === 'old-record') env.snapshots.get(oldHead)![`stable/${id}/activation.json`] = Buffer.from('{}');
    if (fault === 'old-bytes') env.snapshots.get(oldHead)![`stable/${id}/domains.srs`] = Buffer.from('old corruption');
    const served = await env.transport.download(env.subscription(id).projections.route.formats.binary.url);
    await assert.rejects(activateRules(options));
    assert.equal(env.head(), oldHead); assert.equal(env.writes(), writes);
    assert.deepEqual(await env.transport.download(env.subscription(id).projections.route.formats.binary.url), served);
    if (!fault.startsWith('old-')) assert.deepEqual(env.snapshots.get(oldHead), Object.fromEntries(before));
    assert.equal((await readUpdateState(directory)).activeRuleVersions[id].activation.candidateId, first[id].id);
  }));
}

for (const mode of ['applied', 'not-applied', 'unknown', 'superseded', 'readback', 'receipt', 'rejected']) {
  test(`提交中断 ${mode} 可从远端核实且不重复切换`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const candidates = await env.candidates(), id = env.ids[0];
    const options = env.options(id, candidates[id].evidenceUrl!);
    if (mode === 'receipt') {
      await writeFile(join(directory, 'active-rule-versions'), 'block receipt directory');
    } else env.fail(mode);
    if (mode === 'applied' || mode === 'superseded') {
      const result = await activateRules(options);
      assert.equal(result.status, 'activated');
      assert.match(result.commit, /^[a-f0-9]{40}$/);
      if (mode === 'superseded') assert.notEqual(result.commit, env.head());
    } else {
      const code = { 'not-applied': 'ACTIVATION_UNKNOWN', unknown: 'ACTIVATION_UNKNOWN', readback: 'ACTIVATION_APPLIED_READBACK_PENDING',
        receipt: 'ACTIVATION_APPLIED_LOCAL_RECEIPT_PENDING', rejected: 'ACTIVATION_NOT_APPLIED' }[mode]!;
      await assert.rejects(activateRules(options), new RegExp(`${code}:.*[a-f0-9-]{36}`));
    }
    // Simulate a fresh process without the original state directory or a receipt.
    await rm(directory, { recursive: true, force: true });
    const readStatus = () => readRemoteStatus({ repository: env.repository, activation: env.transport });
    const before = env.head();
    let status = await readStatus();
    assert.equal(status.manualOperations.length, 1);
    const operation = status.manualOperations[0];
    if (mode === 'readback') {
      assert.equal(operation.status, 'pending');
      assert.equal(operation.commit, before);
      assert.equal(status.activeRuleVersions[id].activation.candidateId, candidates[id].id);
    }
    env.fail('');
    status = await readStatus();
    const expected = mode === 'rejected' ? 'not-committed' : mode === 'not-applied' ? 'pending' : 'committed';
    assert.equal(status.manualOperations[0].status, expected);
    assert.equal(env.head(), before);
    assert.equal(env.writes(), mode === 'rejected' ? 0 : 1);
  }));
}

test('新的人工决定使旧操作被替代，即使固定的是同一候选', { skip: !binary }, async () => isolated(async env => {
  const candidates = await env.candidates(), id = env.ids[0];
  const first = await activateRules(env.options(id, candidates[id].evidenceUrl!));
  const next = await activateRules(env.options(id, candidates[id].evidenceUrl!));
  const status = await readRemoteStatus({ repository: env.repository, activation: env.transport });
  const byId = new Map(status.manualOperations.map(operation => [operation.id, operation]));
  assert.equal(byId.get(first.activation.id)?.status, 'superseded');
  assert.equal(byId.get(first.activation.id)?.commit, first.commit);
  assert.equal(byId.get(next.activation.id)?.status, 'committed');
}));

for (const branch of ['acceptance-issue-39', 'main']) {
  for (const race of ['maintenance', 'generation', 'head'] as const) {
    test(`${branch} 的人工激活在写入前遇到 ${race} 变化时停下`, { skip: !binary }, async () => isolated(async env => {
      const candidates = await env.candidates(), id = env.ids[0];
      env.beforeSwitch(async () => {
        const { snapshot, journal } = await readRemoteState(env.repository);
        if (race === 'maintenance') journal.maintenance = 'maintenance';
        if (race === 'generation') journal.generation++;
        await env.repository.commit(snapshot.head, { [STATE_PATH]: Buffer.from(JSON.stringify(journal)) }, '模拟并发控制更新');
      });
      await assert.rejects(activateRules(env.options(id, candidates[id].evidenceUrl!)), /PUBLICATION_CONFLICT/);
      assert.equal(env.writes(), 0);
      assert.equal(env.snapshots.get(env.head())![`stable/${id}/activation.json`], undefined);
    }, branch));
  }
}

test('不同集竞争同一旧 head 至多一个成功，过期操作不能覆盖另一集', { skip: !binary }, async () => isolated(async env => {
  const candidates = await env.candidates();
  const operations = env.ids.slice(0, 2).map(id => env.options(id, candidates[id].evidenceUrl!));
  const results = await Promise.allSettled(operations.map(activateRules));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(env.writes(), 1);
  const snapshot = env.snapshots.get(env.head());
  await assert.rejects(activateRules(operations[0]), /ACTIVATION_CONFLICT/);
  assert.deepEqual(env.snapshots.get(env.head()), snapshot);
}));

test('订阅对象字段顺序不改变文件复用关系或既有契约', { skip: !binary }, async () => isolated(async env => {
  const candidates = await env.candidates(), id = env.ids[0];
  await activateRules(env.options(id, candidates[id].evidenceUrl!));
  const options = env.options(id, candidates[id].evidenceUrl!);
  const formats = options.subscription.projections['dns-query'].formats;
  options.subscription.projections['dns-query'].formats = { source: formats.source, binary: formats.binary };
  assert.equal((await activateRules(options)).status, 'activated');
}));


test('再次指定当前候选仍保存人工固定并更换控制修订', { skip: !binary }, async () => isolated(async env => {
  const candidates = await env.candidates(), id = env.ids[0];
  const first = await activateRules(env.options(id, candidates[id].evidenceUrl!));
  const next = await activateRules(env.options(id, candidates[id].evidenceUrl!));
  const path = `stable/${id}/activation.json`;
  const before = JSON.parse(env.snapshots.get(first.commit)![path].toString());
  const after = JSON.parse(env.snapshots.get(next.commit)![path].toString());
  assert.deepEqual(after.files, before.files);
  assert.equal(after.candidateId, before.candidateId);
  assert.equal(after.control.reason, 'manual-activation');
  assert.equal(after.control.pauseAutomaticActivation, true);
  assert.equal(after.control.pauseAutomaticRetry, false);
  assert.notEqual(after.control.revision, before.control.revision);
}));
