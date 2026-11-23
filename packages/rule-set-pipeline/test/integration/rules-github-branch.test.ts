import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { sha256 } from '../../src/release.js';
import type { RuleDelivery } from '../../src/rules-model.js';
import { syncRules } from '../../src/rules-operations.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const target = 'acceptance-issue-172';
const repository = 'fixtures/rule-lists';
const branch = 'published/lists';

function fixture(ruleSets: Record<string, unknown>, files: Record<string, string>) {
  const env = rulesEnvironment(binary!, target);
  const requests: string[] = [];
  let revision = 1;
  let upstream = 1;
  const revisions = new Map([[upstream, files]]);
  env.context.fetch = async address => {
    const url = String(address);
    requests.push(url);
    if (url === `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}`) {
      return Response.json({ name: branch, commit: { sha: String(upstream).repeat(40) } });
    }
    const prefix = `https://raw.githubusercontent.com/${repository}/`;
    if (!url.startsWith(prefix)) throw new Error(`Unexpected upstream request: ${url}`);
    const [commit, ...path] = url.slice(prefix.length).split('/');
    assert.match(commit, /^([1-9])\1{39}$/);
    const body = revisions.get(Number(commit[0]))?.[path.join('/')];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  };
  env.context.readConfiguration = async () => ({
    origin: 'isolated-fixture', revision: String(revision),
    content: stringify({
      schemaVersion: 4, candidateRetentionDays: 30,
      target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: target },
      sources: { example: { fetch: { method: 'github-branch', repository, branch } } },
      ruleSets,
    }, { aliasDuplicateObjects: false }),
  });
  return { ...env, requests, request: { context: env.context },
    configure(next: typeof ruleSets) { ruleSets = next; revision++; },
    upstream(next: typeof files) { revisions.set(++upstream, next); },
  };
}

function rule(id: string, file: string, format: string, filter?: object) {
  return {
    data: { source: 'example', file, format },
    publishPath: `stable/${id}`, artifact: id,
    ...(filter && { filter }),
  };
}

async function matches(t: TestContext, env: ReturnType<typeof fixture>, current: RuleDelivery, id: string,
  examples: readonly (readonly [string, boolean])[]) {
  const directory = await mkdtemp(join(tmpdir(), 'rules-issue-172-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [format, extension] of [['source', 'json'], ['binary', 'srs']] as const) {
    const path = `stable/${id}/${id}.${extension}`;
    const url = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${target}/${path}`;
    const data = await env.context.repository.download(url);
    assert.deepEqual(current.files[path], { sha256: sha256(data), byteLength: data.length });
    const local = join(directory, `${id}.${extension}`);
    await writeFile(local, data);
    for (const [value, expected] of examples) {
      const { stdout, stderr } = await exec(binary!, ['rule-set', 'match', local, value, '--format', format]);
      assert.equal((stdout + stderr).includes('match rules.'), expected, `${id} ${format}: ${value}`);
    }
  }
}

test('v4 delivers CIDR and domain suffix files using the same GitHub branch declaration', async t => {
  const cidr = rule('networks', 'rules/networks.txt', 'cidr-text');
  const domain = rule('domains', 'rules/domains.txt', 'domain-suffix-text');
  const env = fixture({ networks: cidr }, {
    'rules/networks.txt': '192.0.2.19/24\n2001:db8::/32\n',
    'rules/domains.txt': 'suffix.example\n',
  });

  const first = await syncRules(env.request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  const original = first.results[0].current!;

  env.configure({ networks: cidr, domains: domain });
  env.requests.length = 0;
  const next = await syncRules(env.request);
  assert.equal(next.status, 'success', JSON.stringify(next));
  assert.deepEqual(next.results.map(result => [result.id, result.status]), [['networks', 'unchanged'], ['domains', 'delivered']]);
  assert.deepEqual(env.requests, [
    `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}`,
    `https://raw.githubusercontent.com/${repository}/${'1'.repeat(40)}/rules/domains.txt`,
  ]);
  const [networks, domains] = next.results;
  assert.equal(networks.current!.versionId, original.versionId);
  assert.deepEqual([networks.current!.source, domains.current!.source].map(source => 'file' in source && source.file.path),
    ['rules/networks.txt', 'rules/domains.txt']);

  await matches(t, env, networks.current!, 'networks', [
    ['192.0.2.1', true], ['192.0.3.1', false], ['2001:db8::1', true], ['2001:db9::1', false],
  ]);
  await matches(t, env, domains.current!, 'domains', [
    ['suffix.example', true], ['child.suffix.example', true], ['notsuffix.example', false], ['192.0.2.1', false],
  ]);
});

const clashFile = 'rules/mixed.list';
const mixed = `# A classical text provider
DOMAIN,exact.example
DOMAIN-SUFFIX,Boundary.Example
DOMAIN-KEYWORD,Needle
DOMAIN-KEYWORD,Foo_Bar
IP-CIDR,198.51.100.19/24,no-resolve
IP-CIDR6,2001:db8:4::/48
IP-ASN,64500,no-resolve
IP-ASN,64501
`;

test('v4 filters the same Clash file by upstream type and delivers native matches', async t => {
  const env = fixture({
    mixed: rule('mixed', clashFile, 'clash-rule-list'),
    included: rule('included', clashFile, 'clash-rule-list', { include: { type: { anyOf: ['DOMAIN-KEYWORD', 'IP-CIDR6'] } } }),
    excluded: rule('excluded', clashFile, 'clash-rule-list', { exclude: { type: { anyOf: ['DOMAIN-KEYWORD', 'IP-CIDR6', 'IP-ASN'] } } }),
  }, { [clashFile]: mixed });
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  const [unfiltered, included, excluded] = result.results;
  const snapshot = await env.context.repository.snapshot();
  const report = JSON.parse((await snapshot.read(`candidates/${unfiltered.current!.candidateId}/conversion-report.json`))!.toString());
  assert.equal(report.unsupportedCount, 2);
  assert.deepEqual(report.unsupportedTypeCounts, { 'IP-ASN': 2 });
  assert.deepEqual(unfiltered.unsupportedTypeCounts, { 'IP-ASN': 2 });
  assert.equal(included.unsupportedTypeCounts, undefined);
  assert.equal(excluded.unsupportedTypeCounts, undefined);

  await matches(t, env, unfiltered.current!, 'mixed', [
    ['exact.example', true], ['child.exact.example', false],
    ['boundary.example', true], ['child.boundary.example', true], ['notboundary.example', false],
    ['myneedle.example', true], ['myfoo_bar.example', true], ['myfoobar.example', false], ['plain.example', false],
    ['198.51.100.1', true], ['198.51.101.1', false], ['2001:db8:4::1', true], ['2001:db8:5::1', false],
  ]);
  await matches(t, env, included.current!, 'included', [
    ['child.boundary.example', false], ['myneedle.example', true], ['198.51.100.1', false], ['2001:db8:4::1', true],
  ]);
  await matches(t, env, excluded.current!, 'excluded', [
    ['child.boundary.example', true], ['myneedle.example', false], ['198.51.100.1', true], ['2001:db8:4::1', false],
  ]);
});

test('v4 keeps old files when all selected Clash rules are unsupported and still delivers an independent file', async t => {
  const existing = rule('existing', clashFile, 'clash-rule-list');
  const env = fixture({ existing }, { [clashFile]: mixed });
  const first = await syncRules(env.request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  const original = first.results[0].current!;
  env.configure({
    existing,
    fresh: rule('fresh', clashFile, 'clash-rule-list', { include: { type: { anyOf: ['IP-ASN'] } } }),
    independent: rule('independent', 'independent.txt', 'domain-suffix-text'),
  });
  env.upstream({ [clashFile]: 'IP-ASN,64500,no-resolve\nIP-ASN,64501\n', 'independent.txt': 'new.example\n' });

  const next = await syncRules(env.request);
  assert.equal(next.status, 'partial', JSON.stringify(next));
  assert.equal(next.exitCode, 1);
  const [previous, fresh, independent] = next.results;
  for (const result of [previous, fresh]) {
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /all selected Clash rules are unsupported.*IP-ASN=2/);
    assert.deepEqual(result.unsupportedTypeCounts, { 'IP-ASN': 2 });
  }
  assert.deepEqual(previous.current, original);
  await matches(t, env, original, 'existing', [['myneedle.example', true], ['198.51.100.1', true]]);
  assert.equal(fresh.current, undefined);
  for (const extension of ['json', 'srs']) {
    await assert.rejects(env.context.repository.download(`https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${target}/stable/fresh/fresh.${extension}`), /404/);
  }
  assert.equal(independent.status, 'delivered');
  await matches(t, env, independent.current!, 'independent', [['new.example', true], ['old.example', false]]);
});

test('v4 delivers empty Clash and text rule sets after a normal empty selection', async t => {
  const env = fixture({
    filtered: rule('filtered', clashFile, 'clash-rule-list', { include: { type: { anyOf: ['DOMAIN-KEYWORD'] } } }),
    empty: rule('empty', 'rules/empty.list', 'clash-rule-list'),
    domains: rule('domains', 'rules/empty-domains.txt', 'domain-suffix-text'),
    networks: rule('networks', 'rules/empty-networks.txt', 'cidr-text'),
  }, { [clashFile]: 'IP-ASN,64500\n', 'rules/empty.list': '# Empty\n', 'rules/empty-domains.txt': '', 'rules/empty-networks.txt': '' });
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  const again = await syncRules(env.request);
  assert.equal(again.status, 'success', JSON.stringify(again));
  assert.ok(again.results.every(item => item.status === 'unchanged'));
  for (const { id, current } of result.results) {
    await matches(t, env, current!, id, [['needle.example', false], ['198.51.100.1', false]]);
  }
});

test('v4 rejects invalid branch file selections and Clash filters before upstream access', async t => {
  const valid = rule('test-rule', clashFile, 'clash-rule-list');
  const malformed = [
    ['path traversal', { ...valid, data: { ...valid.data, file: 'rules/../mixed.list' } }, /\d+:\d+ ruleSets\.test-rule\.data\.file: must match pattern/],
    ['missing format', { ...valid, data: { source: 'example', file: clashFile } }, /\d+:\d+ ruleSets\.test-rule\.data\.format: required when file is present/],
    ['whole-file list', { ...valid, data: { ...valid.data, list: 'all' } }, /\d+:\d+ ruleSets\.test-rule\.data\.list: field is not allowed/],
    ['unknown format', { ...valid, data: { ...valid.data, format: 'plain-yaml' } }, /\d+:\d+ ruleSets\.test-rule\.data\.format: allowed values/],
    ['undefined source', { ...valid, data: { ...valid.data, source: 'missing' } }, /\d+:\d+ ruleSets\.test-rule\.data\.source: unknown source missing/],
    ['two actions', { ...valid, filter: { include: { type: { anyOf: ['DOMAIN'] } }, exclude: { type: { anyOf: ['IP-ASN'] } } } }, /\d+:\d+ ruleSets\.test-rule\.filter: .*more than 1 properties/],
    ['empty condition', { ...valid, filter: { include: { type: { anyOf: [] } } } }, /\d+:\d+ ruleSets\.test-rule\.filter\.include\.type\.anyOf: must contain at least one value/],
    ['non-type condition', { ...valid, filter: { include: { tags: { anyOf: ['cn'] } } } }, /\d+:\d+ ruleSets\.test-rule\.filter\.include\.tags: field is not allowed/],
    ['filter on CIDR', { ...rule('test-rule', 'ip.txt', 'cidr-text'), filter: { include: { type: { anyOf: ['IP-CIDR'] } } } }, /\d+:\d+ ruleSets\.test-rule\.filter: field is not allowed/],
  ] as const;
  for (const [name, definition, error] of malformed) {
    await t.test(name, async () => {
      const env = fixture({ 'test-rule': definition }, {});
      const result = await syncRules(env.request);
      assert.equal(result.status, 'failed');
      assert.match(result.error!, error);
      assert.deepEqual(env.requests, []);
      assert.deepEqual(env.writes, []);
    });
  }
});

test('v4 keeps a missing branch file failure local to consumers of that file', async t => {
  const env = fixture({
    missing: rule('missing', 'rules/missing.list', 'clash-rule-list'),
    present: rule('present', 'rules/present.txt', 'cidr-text'),
  }, { 'rules/present.txt': '203.0.113.0/24\n' });
  const result = await syncRules(env.request);
  assert.equal(result.status, 'partial', JSON.stringify(result));
  const [missing, present] = result.results;
  assert.match(missing.error!, /HTTP 404: .*\/rules\/missing\.list/);
  assert.equal(missing.current, undefined);
  assert.equal(present.status, 'delivered');
  await matches(t, env, present.current!, 'present', [['203.0.113.1', true], ['203.0.114.1', false]]);
});

test('v4 preserves the source CIDR and port directions from a Clash list', async t => {
  const env = fixture({ transport: rule('transport', clashFile, 'clash-rule-list') }, {
    [clashFile]: 'SRC-IP-CIDR,192.0.2.15/24\nSRC-PORT,1234\nDST-PORT,80/8443-8445\n',
  });
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.results[0].unsupportedTypeCounts, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'rules-issue-172-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${target}/stable/transport/transport`;
  const source = await env.context.repository.download(url + '.json');
  const srs = await env.context.repository.download(url + '.srs');
  const srsPath = join(directory, 'transport.srs');
  const decodedPath = join(directory, 'transport-decoded.json');
  await writeFile(srsPath, srs);
  await exec(binary!, ['rule-set', 'decompile', srsPath, '-o', decodedPath]);
  assert.equal(JSON.parse(source.toString()).version, 4);
  for (const bytes of [source, await readFile(decodedPath)]) {
    const doc = JSON.parse(bytes.toString()) as { rules: Record<string, unknown>[] };
    assert.equal(doc.rules.length, 4);
    assert.deepEqual(Object.fromEntries(doc.rules.flatMap(entry => Object.entries(entry))
      .map(([key, value]) => [key, Array.isArray(value) ? value : [value]])), {
      source_ip_cidr: ['192.0.2.0/24'], source_port: [1234], port: [80], port_range: ['8443:8445'],
    });
    assert.ok(doc.rules.every(entry => Object.keys(entry).length === 1));
  }
});
