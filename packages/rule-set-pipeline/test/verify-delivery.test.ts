import assert from 'node:assert/strict';
import test from 'node:test';
import { readDeliveryUrl, readPublishedFile } from '../src/delivery-readback.js';
import { ARTIFACT_REPOSITORY } from '../src/publication.js';
import { sha256 } from '../src/release.js';
import { verifyDelivery } from '../src/verify-delivery.js';

test('GET 保留 HTTP 状态与实际内容证据，不跟随重定向', async () => {
  const expected = { byteLength: 4, sha256: sha256('good') };
  const urls = { candidate: 'https://example.test/candidate', fixedDelivery: 'https://example.test/fixed', stable: 'https://example.test/stable' };
  const requests: string[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual');
    requests.push(String(url));
    if (url === urls.candidate) return new Response('good');
    if (url === urls.fixedDelivery) return new Response(null, { status: 302 });
    return new Response('oops');
  };
  const reads = await readPublishedFile(urls, expected, request);
  assert.deepEqual(requests.sort(), Object.values(urls).sort());
  assert.deepEqual(reads.candidate, { url: urls.candidate, ok: true, httpStatus: 200, ...expected });
  assert.equal(reads.fixedDelivery.ok, false); assert.equal(reads.fixedDelivery.httpStatus, 302);
  assert.equal(reads.stable.ok, false); assert.equal(reads.stable.sha256, sha256('oops'));
  const retired = await readDeliveryUrl('https://example.test/retired', 'retired', request);
  assert.equal(retired.httpStatus, 200); assert.equal(retired.ok, false);
});

test('生产回读拒绝其他仓库、隔离 status 与错误的 Actions 外层目标', async () => {
  const base = { operation: 'status', status: 'success', exitCode: 0, dryRun: false };
  const main = { ...base, target: { repository: ARTIFACT_REPOSITORY, branch: 'main' } };
  const isolated = { ...base, target: { repository: ARTIFACT_REPOSITORY, branch: 'acceptance-fixture' } };
  for (const input of [isolated, { ...base, target: { repository: 'other/repo', branch: 'main' } },
    { target: 'acceptance-fixture', exitCode: 0, results: [main] }, { target: 'main', exitCode: 0, results: [isolated] }]) {
    const result = await verifyDelivery(input, [], () => { throw new Error('Unexpected Git access'); });
    assert.equal(result.ok, false);
    assert.match(result.error!, /production main/);
  }
});
