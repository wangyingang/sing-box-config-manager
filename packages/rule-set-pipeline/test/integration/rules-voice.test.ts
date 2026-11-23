import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredBuildTools } from '../../src/configured-build.js';
import { formalConfiguration } from '../fixtures/formal-configuration.js';
import { OPENAI_VOICE_URL, probeOpenAiVoiceInput } from '../../src/openai-voice-source.js';
import { sha256 } from '../../src/release.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import { pinRuleVersion, syncRules } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

const first = '{ "prefixes": [{ "ipv4Prefix": "192.0.2.0/24" }, { "ipv6Prefix": "2001:db8:1::/48" }] }\n';
const second = JSON.stringify({ prefixes: [{ ipv4Prefix: '198.51.100.0/24' }] });

const voiceSnapshotPath = (id: string) => `candidates/${id}/input.source.json`;

function fixture() {
  const env = cleanupEnvironment(binary!, 'acceptance-chatgpt-voice');
  const config = formalConfiguration();
  config.target.branch = env.context.targetBranch;
  config.ruleSets = config.ruleSets.filter(rule => rule.id === 'chatgpt-voice');
  env.configure(config);
  let body = first;
  let etag: string | undefined = '"voice-a"';
  const validators: (string | null)[] = [];
  env.context.token = 'github-test-token';
  env.context.fetch = async (url, init) => {
    assert.equal(String(url), OPENAI_VOICE_URL);
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('Authorization'), false);
    const condition = headers.get('If-None-Match');
    validators.push(condition);
    const responseHeaders = etag ? { etag } : undefined;
    if (etag && condition === etag) return new Response(null, { status: 304, headers: responseHeaders });
    return new Response(body, { headers: responseHeaders });
  };
  return { env, req: { context: env.context }, validators, setInput(next: string, nextEtag?: string) { body = next; etag = nextEtag; } };
}

test('ChatGPT Voice 恢复原始快照，损坏时拒绝使用新上游替代', async () => {
  const { env, req, validators, setInput } = fixture();
  env.beforeWrite(async files => {
    if (Object.keys(files).some(path => /^candidates\/.+\/ips\.json$/.test(path))) throw new Error('Interrupted before rule files');
  });
  const interrupted = await syncRules(req);
  assert.equal(interrupted.status, 'failed', JSON.stringify(interrupted));
  assert.deepEqual(validators, [null]);
  const [registered] = Object.values((await env.journal()).candidates);
  assert.ok(registered);
  const path = `candidates/${registered.id}/input.source.json`;
  const snapshot = await env.context.repository.snapshot();
  assert.equal(registered.source.inputSha256, sha256(first));
  assert.equal(registered.source.inputBytes, Buffer.byteLength(first));
  assert.ok(env.writes.some(write => write.files[RULE_STATE_PATH]?.includes(registered.id) && write.files[path]?.equals(Buffer.from(first))));
  assert.deepEqual(await snapshot.read(path), Buffer.from(first));

  env.beforeWrite();
  setInput(second, '"voice-b"');
  const tree = env.trees.get(snapshot.head)!;
  tree.set(path, Buffer.from(second));
  const refused = await syncRules({ context: { ...env.context } });
  assert.equal(refused.status, 'failed');
  assert.match(refused.results[0].error!, /recorded digest or length/);
  assert.deepEqual(validators, [null], 'recovery must use only the registered input');
  assert.equal((await getRulesStatus(req)).rules?.[0].deliveryState, 'not-delivered');
  const failedHead = (await env.context.repository.snapshot()).head;
  env.trees.get(failedHead)!.set(path, Buffer.from(first));
  const recovered = await syncRules({ context: { ...env.context } });
  assert.equal(recovered.status, 'success', JSON.stringify(recovered));
  assert.deepEqual(validators, [null]);
  assert.equal(recovered.results[0].current?.candidateId, registered.id);
  assert.deepEqual(recovered.results[0].current?.source, registered.source);
  const rules = await (await env.context.repository.snapshot()).read('stable/chatgpt-voice/ips.json');
  assert.deepEqual(JSON.parse(rules!.toString()).rules, [{ ip_cidr: ['192.0.2.0/24', '2001:db8:1::/48'] }]);
  const updated = await syncRules(req);
  assert.equal(updated.status, 'success', JSON.stringify(updated));
  assert.notEqual(updated.results[0].current?.candidateId, registered.id);
  assert.equal(updated.results[0].current?.source.inputSha256, sha256(second));
});

test('ChatGPT Voice 发布回读已登记时仍核对原始快照，恢复沿用原版本', async () => {
  const { env, req, validators, setInput } = fixture();
  env.beforeWrite(async files => {
    const state = files[RULE_STATE_PATH];
    if (state && parseRulesJournal(state).pendingDelivery) throw new Error('RULE_WRITE_CONFLICT: interrupted after evidence');
  });
  assert.notEqual((await syncRules(req)).status, 'success');
  env.beforeWrite();
  const [candidate] = Object.values((await env.journal()).candidates);
  assert.ok(candidate);
  const prefix = `candidates/${candidate.id}/`;
  const path = prefix + 'input.source.json';
  const snapshot = await env.context.repository.snapshot();
  const readback = await snapshot.read(prefix + 'readback.json');
  assert.ok(readback);
  const { versionId, publishedAt } = JSON.parse(readback.toString());
  assert.ok(versionId && publishedAt);
  assert.deepEqual(await snapshot.read(path), Buffer.from(first));
  setInput(second, '"voice-b"');

  env.trees.get(snapshot.head)!.delete(path);
  const refused = await syncRules({ context: { ...env.context } });
  assert.equal(refused.status, 'failed');
  assert.match(refused.results[0].error!, /recorded digest or length/);
  assert.equal(refused.results[0].current, undefined);
  assert.deepEqual(refused.readbackRequests, []);
  assert.deepEqual(validators, [null]);

  const failedHead = (await env.context.repository.snapshot()).head;
  env.trees.get(failedHead)!.set(path, Buffer.from(first));
  const recovered = await syncRules({ context: { ...env.context } });
  assert.equal(recovered.status, 'success', JSON.stringify(recovered));
  assert.equal(recovered.results[0].current?.candidateId, candidate.id);
  assert.equal(recovered.results[0].current?.versionId, versionId);
  assert.equal(recovered.results[0].current?.publishedAt, publishedAt);
  assert.deepEqual(recovered.results[0].current?.source, candidate.source);
  assert.deepEqual(validators, [null]);
});

test('ChatGPT Voice 输入校验、无验证器重读及历史清理保留原始快照', async () => {
  const { env, req, validators, setInput } = fixture();
  setInput(first);
  const original = await syncRules(req);
  assert.equal(original.status, 'success', JSON.stringify(original));
  const firstCandidate = original.results[0].current!.candidateId;
  const writes = env.writes.length;
  const unchanged = await syncRules(req);
  assert.equal(unchanged.results[0].status, 'unchanged');
  assert.deepEqual(unchanged.readbackRequests, []);
  assert.equal(env.writes.length, writes);
  assert.deepEqual(validators, [null, null]);

  for (const invalid of ['[]', '{"prefixes":[]}', '{"prefixes":[{"ipv4Prefix":"192.0.2.0/24\\n198.51.100.0/24"}]}',
    '{"prefixes":[{"ipv4Prefix":"2001:db8::/32"}]}', '{"prefixes":[{"ipv4Prefix":"192.0.2.0/33"}]}']) {
    setInput(invalid);
    const rejected = await syncRules(req);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.results[0].current?.candidateId, firstCandidate);
    assert.equal(rejected.results[0].successfulInput?.source.inputSha256, sha256(first));
  }
  env.clock('2027-01-05T00:00:00.000Z');
  setInput(second, '"voice-b"');
  const updated = await syncRules(req);
  assert.equal(updated.status, 'success', JSON.stringify(updated));
  const current = updated.results[0].current!;
  assert.notEqual(current.candidateId, firstCandidate);
  const fetches = validators.length;
  const beforeCleanup = await env.context.repository.snapshot();
  const currentPath = voiceSnapshotPath(current.candidateId);
  const currentTree = env.trees.get(beforeCleanup.head)!;
  currentTree.delete(currentPath);
  const blocked = await cleanupRuleHistory({ context: { ...env.context } });
  assert.equal(blocked.status, 'pending');
  assert.ok(blocked.cleanup?.plan?.blockers.some(reason => reason.includes('recorded digest or length')));
  assert.equal((await env.context.repository.snapshot()).head, beforeCleanup.head);
  currentTree.set(currentPath, Buffer.from(second));
  const clean = await cleanupRuleHistory(req);
  assert.equal(clean.status, 'success', JSON.stringify(clean));
  assert.equal(clean.cleanup?.phase, 'completed');
  assert.equal(clean.readbackRequests?.length, 4);
  const retained = await env.context.repository.snapshot();
  assert.equal(await retained.read(voiceSnapshotPath(firstCandidate)), undefined);
  assert.deepEqual(await retained.read(voiceSnapshotPath(current.candidateId)), Buffer.from(second));
  const pinned = await pinRuleVersion({ ...req, id: 'chatgpt-voice', version: current.versionId! });
  assert.equal(pinned.status, 'success', JSON.stringify(pinned));
  assert.equal(pinned.results[0].current?.source.inputSha256, sha256(second));
  assert.equal(validators.length, fetches, 'pin and cleanup never probe the fixed HTTPS input');
});

test('ChatGPT Voice 共享可信 304，验证器冲突时读取完整输入', async () => {
  const source = { kind: 'openai-voice' as const, url: OPENAI_VOICE_URL, etag: '"voice-a"',
    inputSha256: sha256(first), inputBytes: Buffer.byteLength(first) };
  const validators: (string | null)[] = [];
  let returnedEtag = source.etag;
  const fetcher: typeof fetch = async (_url, init) => {
    const condition = new Headers(init?.headers).get('If-None-Match');
    validators.push(condition);
    if (condition) return new Response(null, { status: 304, headers: { etag: returnedEtag } });
    return new Response(second);
  };
  const shared = probeOpenAiVoiceInput(fetcher);
  assert.deepEqual(await shared.unchanged(source), source);
  assert.deepEqual(await shared.unchanged(source), source);
  assert.deepEqual(validators, [source.etag]);

  validators.length = 0;
  returnedEtag = 'W/"voice-a"';
  const fallback = probeOpenAiVoiceInput(fetcher);
  assert.equal(await fallback.unchanged(source), undefined);
  assert.deepEqual((await fallback.read()).bytes, Buffer.from(second));
  assert.deepEqual(validators, [source.etag, null]);
  assert.ok((await configuredBuildTools('cidr-text')).ipaddr);
  assert.equal((await configuredBuildTools('openai-voice-json')).ipaddr, (await configuredBuildTools('cidr-text')).ipaddr);
});
