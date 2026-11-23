import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { sha256 } from '../../src/release.js';
import { syncRules } from '../../src/rules-operations.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const branch = 'acceptance-issue-171';
const dlcUrl = 'https://rules.example.test/releases/latest/download/dlc.yml';
const assetUrl = 'https://assets.example.test/dlc.yml';
const checksumUrl = dlcUrl + '.sha256sum';
const voiceUrl = 'https://openai.com/chatgpt-voice.json';

function fixture(ruleSets: Record<string, object>, lists: Record<string, string[] | null>) {
  const env = rulesEnvironment(binary!, branch);
  const requests: string[] = [];
  const upstream = { lists, checksum: 'valid', voice: ['192.0.2.0/24', '2001:db8::/32'] };
  env.context.token = 'test-github-token';
  env.context.fetch = async (address, init) => {
    const url = String(address);
    requests.push(url);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    const body = stringify({ lists: Object.entries(upstream.lists).map(([name, rules]) => ({
      name, length: rules?.length ?? 0, rules,
    })) });
    if (url === dlcUrl) return new Response(null, { status: 302, headers: { Location: assetUrl } });
    if (url === assetUrl) return new Response(body);
    if (url === checksumUrl) {
      if (upstream.checksum === 'missing') return new Response(null, { status: 404 });
      if (upstream.checksum === 'invalid') return new Response('invalid digest');
      const hash = upstream.checksum === 'mismatch' ? '0'.repeat(64) : sha256(body);
      return new Response(hash + '  dlc.yml\n');
    }
    assert.equal(url, voiceUrl);
    return Response.json({ prefixes: upstream.voice.map(value => value.includes(':') ? { ipv6Prefix: value } : { ipv4Prefix: value }) });
  };
  env.context.readConfiguration = async () => ({
    origin: 'isolated-fixture', revision: '171',
    content: stringify({
      schemaVersion: 4,
      candidateRetentionDays: 30,
      target: { repository: 'wangyingang/sing-box-rule-artifacts', branch },
      sources: {
        dlc: { fetch: { method: 'url', url: dlcUrl, sha256Url: checksumUrl }, format: 'v2fly-dlc-yaml' },
        voice: { fetch: { method: 'url', url: voiceUrl }, format: 'openai-voice-json' },
      },
      ruleSets,
    }),
  });
  return { ...env, upstream, requests, sync: () => syncRules({ context: env.context }) };
}

function dlcRule(id: string, list: string, filter?: object) {
  return { data: { source: 'dlc', list }, publishPath: `stable/${id}`, artifact: 'domains', ...(filter && { filter }) };
}

const voice = { data: { source: 'voice' }, publishPath: 'stable/voice', artifact: 'ips' };

async function checkMatches(t: TestContext, env: ReturnType<typeof fixture>, path: string, samples: Record<string, boolean>) {
  const directory = await mkdtemp(join(tmpdir(), 'rules-fixed-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await env.context.repository.snapshot();
  for (const [extension, format] of [['json', 'source'], ['srs', 'binary']] as const) {
    const bytes = await snapshot.read(`stable/${path}.${extension}`);
    assert.ok(bytes, `${path}.${extension}`);
    const file = join(directory, `rules.${extension}`);
    await writeFile(file, bytes);
    if (format === 'source') assert.doesNotMatch(bytes.toString(), /:@/);
    for (const [sample, expected] of Object.entries(samples)) {
      const { stdout, stderr } = await exec(binary!, ['rule-set', 'match', file, sample, '--format', format]);
      assert.equal((stdout + stderr).includes('match rules.'), expected, `${path} (${format}): ${sample}`);
    }
  }
}

test('v4 sync verifies a shared fixed URL DLC and independently delivers whole-file Voice', async t => {
  const env = fixture({ alpha: dlcRule('alpha', 'a'), beta: dlcRule('beta', 'b'), voice }, {
    a: ['domain:alpha.example:@cn'], b: ['full:beta.example:@!cn'],
  });
  const started = await env.sync();
  assert.equal(started.status, 'success', JSON.stringify(started));
  assert.deepEqual([...env.requests].sort(), [dlcUrl, assetUrl, checksumUrl, voiceUrl].sort());
  await checkMatches(t, env, 'alpha/domains', { 'api.alpha.example': true, 'beta.example': false });
  await checkMatches(t, env, 'beta/domains', { 'api.alpha.example': false, 'beta.example': true, 'api.beta.example': false });
  await checkMatches(t, env, 'voice/ips', { '192.0.2.7': true, '192.0.3.1': false, '2001:db8::1': true, '2001:db9::1': false });

  for (const [index, value] of ['missing', 'invalid', 'mismatch'].entries()) {
    env.upstream.checksum = value;
    env.upstream.lists.a = ['domain:new-alpha.example'];
    env.upstream.lists.b = ['domain:new-beta.example'];
    env.upstream.voice = [`198.51.100.${index}/32`];
    const result = await env.sync();
    assert.equal(result.status, 'partial', JSON.stringify(result));
    for (const [id, diagnostic] of [['alpha', /checksum|SHA-256/i], ['beta', /checksum|SHA-256/i]] as const) {
      const failed = result.results.find(rule => rule.id === id)!;
      assert.equal(failed.status, 'failed');
      assert.match(failed.error!, diagnostic);
      assert.deepEqual(failed.current, started.results.find(rule => rule.id === id)!.current);
    }
    assert.equal(result.results.find(rule => rule.id === 'voice')!.status, 'delivered');
  }
  await checkMatches(t, env, 'alpha/domains', { 'alpha.example': true, 'new-alpha.example': false });
  await checkMatches(t, env, 'beta/domains', { 'beta.example': true, 'new-beta.example': false });
  await checkMatches(t, env, 'voice/ips', { '198.51.100.2': true, '192.0.2.7': false });
});

test('DLC filters match exact tags per entry and track normalized content changes', async t => {
  const env = fixture({
    'include-all': dlcRule('include-all', 'a', { include: { tags: { allOf: ['cn', 'video'] } } }),
    'include-any': dlcRule('include-any', 'a', { include: { tags: { anyOf: ['cn', '!cn'] } } }),
    'exclude-all': dlcRule('exclude-all', 'a', { exclude: { tags: { allOf: ['cn', 'video'] } } }),
    'exclude-any': dlcRule('exclude-any', 'a', { exclude: { tags: { anyOf: ['cn', 'video'] } } }),
    all: dlcRule('all', 'all'),
  }, {
    a: [
      'domain:both.example:@cn,@video', 'full:one.example:@cn', 'domain:neither.example', 'full:literal.example:@!cn',
      String.raw`regexp:^regex[0-9]+\.example$:@cn,@video`,
    ],
    all: ['domain:actual-all.example:@video'],
  });
  const sync = async () => {
    const result = await env.sync();
    assert.equal(result.status, 'success', JSON.stringify(result));
    return new Map(result.results.map(rule => [rule.id, rule]));
  };
  const first = await sync();
  await checkMatches(t, env, 'include-all/domains', {
    'both.example': true, 'one.example': false, 'neither.example': false, 'literal.example': false, 'regex42.example': true,
  });
  await checkMatches(t, env, 'include-any/domains', {
    'both.example': true, 'one.example': true, 'neither.example': false, 'literal.example': true,
  });
  await checkMatches(t, env, 'exclude-all/domains', {
    'both.example': false, 'one.example': true, 'neither.example': true, 'literal.example': true, 'regex42.example': false,
  });
  await checkMatches(t, env, 'exclude-any/domains', {
    'both.example': false, 'one.example': false, 'neither.example': true, 'literal.example': true,
  });
  await checkMatches(t, env, 'all/domains', { 'actual-all.example': true, 'both.example': false });

  env.upstream.lists.all = ['domain:replacement.example'];
  const otherListChanged = await sync();
  assert.equal(otherListChanged.get('all')!.status, 'delivered');
  for (const id of ['include-all', 'include-any', 'exclude-all', 'exclude-any']) {
    const checked = otherListChanged.get(id)!;
    assert.equal(checked.status, 'unchanged');
    assert.deepEqual(checked.current, first.get(id)!.current);
    assert.notEqual(checked.successfulInput?.source.inputSha256, first.get(id)!.current?.source.inputSha256);
    assert.equal(checked.successfulInput?.candidateId, checked.current?.candidateId);
  }

  env.upstream.lists.a![0] = 'domain:both.example:@cn,@video,@unrelated';
  const irrelevantTag = await sync();
  assert.equal(irrelevantTag.get('include-all')!.status, 'unchanged');
  assert.notEqual(irrelevantTag.get('include-all')!.successfulInput?.source.inputSha256,
    otherListChanged.get('include-all')!.successfulInput?.source.inputSha256);
  assert.deepEqual(irrelevantTag.get('include-all')!.current, first.get('include-all')!.current);

  env.upstream.lists.a![1] = 'full:one.example:@cn,@video';
  const relevantTag = await sync();
  assert.equal(relevantTag.get('include-all')!.status, 'delivered');
  assert.notEqual(relevantTag.get('include-all')!.current?.versionId, first.get('include-all')!.current?.versionId);
  assert.equal(relevantTag.get('include-any')!.status, 'unchanged');
  await checkMatches(t, env, 'include-all/domains', { 'both.example': true, 'one.example': true, 'literal.example': false });
});

test('empty DLC results publish valid empty artifacts while a missing list preserves its version', async t => {
  const env = fixture({
    empty: dlcRule('empty', 'empty'),
    'empty-export': dlcRule('empty-export', 'empty-export'),
    filtered: dlcRule('filtered', 'filtered', { include: { tags: { anyOf: ['cn'] } } }),
    sibling: dlcRule('sibling', 'sibling'),
  }, {
    empty: [],
    'empty-export': null,
    filtered: ['domain:previous.example:@cn'],
    sibling: ['domain:sibling.example', 'asn:64512'],
  });
  const first = await env.sync();
  assert.equal(first.status, 'success', JSON.stringify(first));
  await checkMatches(t, env, 'empty/domains', { 'previous.example': false, '192.0.2.1': false });
  await checkMatches(t, env, 'empty-export/domains', { 'previous.example': false, '192.0.2.1': false });
  await checkMatches(t, env, 'sibling/domains', { 'sibling.example': true });
  const candidateId = first.results.find(rule => rule.id === 'sibling')!.current!.candidateId;
  const report = await (await env.context.repository.snapshot()).read(`candidates/${candidateId}/conversion-report.json`);
  assert.deepEqual(JSON.parse(report!.toString()).unsupportedTypeCounts, { asn: 1 });
  await checkMatches(t, env, 'filtered/domains', { 'previous.example': true });

  env.upstream.lists.filtered = ['domain:previous.example:@!cn'];
  const second = await env.sync();
  assert.equal(second.status, 'success', JSON.stringify(second));
  const filtered = second.results.find(rule => rule.id === 'filtered')!;
  assert.equal(filtered.status, 'delivered');
  assert.notEqual(filtered.current?.versionId, first.results.find(rule => rule.id === 'filtered')!.current?.versionId);
  await checkMatches(t, env, 'filtered/domains', { 'previous.example': false, '2001:db8::1': false });

  delete env.upstream.lists.filtered;
  env.upstream.lists.sibling = ['domain:updated.example'];
  const missing = await env.sync();
  assert.equal(missing.status, 'partial', JSON.stringify(missing));
  assert.equal(missing.results.find(rule => rule.id === 'filtered')!.status, 'failed');
  assert.match(missing.results.find(rule => rule.id === 'filtered')!.error!, /DLC list filtered is unavailable/);
  assert.deepEqual(missing.results.find(rule => rule.id === 'filtered')!.current, filtered.current);
  const sibling = missing.results.find(rule => rule.id === 'sibling')!;
  assert.equal(sibling.status, 'delivered');
  await checkMatches(t, env, 'sibling/domains', { 'updated.example': true, 'sibling.example': false });

  env.upstream.lists.sibling = ['asn:64512'];
  const unsupported = await env.sync();
  const failed = unsupported.results.find(rule => rule.id === 'sibling')!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /asn/);
  assert.deepEqual(failed.current, sibling.current);

  env.upstream.lists.sibling = ['asn:64512', 'domain:valid.example', 'domain:bad..example'];
  const malformed = await env.sync();
  assert.match(malformed.results.find(rule => rule.id === 'sibling')!.error!, /at line \d+: 域名匹配值非法/);
});

test('v4 rejects invalid DLC and whole-file selections before downloading', async () => {
  for (const rule of [
    { ...dlcRule('invalid', 'unused'), data: { source: 'dlc' } },
    dlcRule('invalid', 'a', { include: { tags: { allOf: [] } } }),
    dlcRule('invalid', 'a', { include: { tags: { allOf: ['cn'], anyOf: ['cn'] } } }),
    { ...voice, data: { source: 'voice', list: 'all' } },
    { ...voice, filter: { include: { tags: { anyOf: ['cn'] } } } },
  ]) {
    const env = fixture({ invalid: rule }, { a: ['domain:example.com'] });
    const result = await env.sync();
    assert.equal(result.status, 'failed', JSON.stringify(rule));
    assert.match(result.error!, /Rule set invalid, source (dlc|voice)/);
    assert.match(result.error!, /DLC tag filter|tag condition|rule definition fields/);
    assert.deepEqual(env.requests, []);
    assert.deepEqual(env.writes, []);
  }
});
