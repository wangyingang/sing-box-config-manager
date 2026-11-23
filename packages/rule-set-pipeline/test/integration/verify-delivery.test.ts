import assert from 'node:assert/strict';
import test from 'node:test';
import { ARTIFACT_REPOSITORY, immutableUrl } from '../../src/publication.js';
import { syncRules } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { verifyDelivery } from '../../src/verify-delivery.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
assert.ok(binary, 'Set SING_BOX_TEST_BINARY to the sing-box 1.14.4 executable');

test('生产交付回读使用已发布候选的 Git 证据和独立 HTTP 请求', async t => {
  const env = rulesEnvironment(binary, 'main');
  const config = env.config();
  config.ruleSets = config.ruleSets.filter(rule => rule.id === 'openai');
  env.configure(config);
  const { context } = env, reader = context.repository;
  assert.equal((await syncRules({ context })).exitCode, 0);
  const status = await getRulesStatus({ context });
  assert.equal(status.status, 'success');
  const rule = status.rules?.[0];
  assert.ok(rule?.current && rule.candidates[0].selectable);
  const candidateTree = await reader.snapshot('candidates'), stableTree = await reader.snapshot('main');
  const stablePrefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/main/`;
  const candidateDir = `candidates/${rule.current.candidateId}/`;
  const retiredUrl = stablePrefix + 'stable/openai/route.json';
  const expectedFiles = await Promise.all(['domains.json', 'domains.srs'].map(async name => {
    const path = 'stable/openai/' + name, candidatePath = candidateDir + name;
    const filesCommit = await reader.lastChange(candidateTree.head, candidatePath);
    const deliveryCommit = await reader.lastChange(stableTree.head, path);
    assert.notEqual(filesCommit, deliveryCommit);
    return { path, candidate: immutableUrl(filesCommit, candidatePath), fixedDelivery: immutableUrl(deliveryCommit, path), stable: stablePrefix + path };
  }));
  const expectedRequests = [...expectedFiles.flatMap(file => [file.candidate, file.fixedDelivery, file.stable]), retiredUrl].sort();
  const requests: string[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual');
    const address = String(url);
    requests.push(address);
    if (address === retiredUrl) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(await reader.download(address)));
  };
  const writes = env.writes.length;
  await t.test('原始与 Actions status 均实际 GET 六个不同产物地址及退役地址', async () => {
    for (const input of [status, { event: 'workflow_dispatch', target: 'main', exitCode: 0, results: [status] }]) {
      requests.length = 0;
      const report = await verifyDelivery(input, [retiredUrl], () => reader, request);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual([...requests].sort(), expectedRequests);
      assert.deepEqual(report.observedHeads, status.observedHeads);
      assert.deepEqual(report.retired, [{ url: retiredUrl, ok: true, httpStatus: 404 }]);
      assert.equal(report.rules.length, 1);
      const files = report.rules[0].files;
      assert.equal(files.length, expectedFiles.length);
      for (const [i, { path, expected, reads }] of files.entries()) {
        assert.equal(path, expectedFiles[i].path);
        for (const key of ['candidate', 'fixedDelivery', 'stable'] as const) {
          assert.deepEqual(reads[key], { url: expectedFiles[i][key], ok: true, httpStatus: 200, ...expected });
        }
      }
    }
  });
  await t.test('status 已交付但稳定地址返回同长度错误字节，旧地址仍返回 200', async () => {
    const broken: typeof fetch = async (url, init) => {
      if (url === retiredUrl) return new Response('stale');
      if (url === expectedFiles[0].stable) return new Response(Buffer.alloc(rule.current!.files[expectedFiles[0].path].byteLength));
      return request(url, init);
    };
    const report = await verifyDelivery(status, [retiredUrl], () => reader, broken);
    assert.equal(report.ok, false);
    const { expected, reads } = report.rules[0].files[0];
    assert.ok(reads.candidate.ok && reads.fixedDelivery.ok);
    assert.equal(reads.stable.ok, false); assert.equal(reads.stable.httpStatus, 200);
    assert.equal(reads.stable.byteLength, expected.byteLength); assert.notEqual(reads.stable.sha256, expected.sha256);
    assert.equal(report.retired[0].ok, false); assert.equal(report.retired[0].httpStatus, 200);
  });
  for (const missing of ['readback.json', 'build.json']) await t.test(`status 标为可选，但 Git 缺失 ${missing}`, async () => {
    const incomplete = { ...reader, async snapshot(branch?: string) {
      const snapshot = await reader.snapshot(branch);
      return { ...snapshot, read: (path: string) => path === candidateDir + missing ? Promise.resolve(undefined) : snapshot.read(path) };
    } };
    requests.length = 0;
    const report = await verifyDelivery(status, [], () => incomplete, request);
    assert.equal(report.ok, false);
    assert.equal(report.rules[0].error, `Missing retained file: ${missing}`);
    assert.deepEqual(requests, []);
  });
  await t.test('拒绝空集、重复规则、过期状态及其他仓库的退役 URL', async () => {
    const repeated = [rule, rule];
    for (const input of [{ ...status, rules: [], results: [] }, { ...status, rules: repeated, results: repeated },
      { ...status, observedHeads: { ...status.observedHeads, journal: 'f'.repeat(40) } }]) {
      assert.equal((await verifyDelivery(input, [], () => reader, request)).ok, false);
    }
    const report = await verifyDelivery(status, [retiredUrl.replace(ARTIFACT_REPOSITORY, 'other/repo')], () => reader, request);
    assert.match(report.error!, /Invalid retired subscription URL/);
  });
  assert.equal(env.writes.length, writes);
});
