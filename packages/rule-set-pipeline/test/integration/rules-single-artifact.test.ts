import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { RULE_STATE_PATH } from '../../src/rules-model.js';
import { syncRules } from '../../src/rules-operations.js';
import { sha256 } from '../../src/release.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const branch = 'acceptance-issue-168';
const url = 'https://rules.example.test/mixed.json';
const input = {
  version: 4,
  rules: [{ domain_suffix: ['mixed.example'] }, { ip_cidr: ['192.0.2.0/24', '2001:db8::/32'] }],
};

function fixture(body = JSON.stringify(input)) {
  const env = rulesEnvironment(binary!, branch);
  const requests: string[] = [];
  env.context.token = 'test-github-token';
  env.context.fetch = async (address, init) => {
    requests.push(String(address));
    assert.equal(String(address), url);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(body);
  };
  env.context.readConfiguration = async () => ({
    origin: 'isolated-fixture', revision: '168',
    content: `schemaVersion: 4
candidateRetentionDays: 30
target:
  repository: wangyingang/sing-box-rule-artifacts
  branch: ${branch}
sources:
  example:
    fetch:
      method: url
      url: ${url}
    format: sing-box-source-json
ruleSets:
  example-mixed:
    data:
      source: example
    publishPath: stable/isolated-mixed
    artifact: mixed
`,
  });
  return { ...env, requests, request: { context: env.context } };
}

test('v4 sync publishes one mixed rule artifact in both native formats', async t => {
  const env = fixture();
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.results[0].status, 'delivered');
  assert.deepEqual(env.requests, [url]);
  const current = result.results[0].current!;
  assert.deepEqual(current.subscription, {
    schemaVersion: 3, systemRuleSetId: 'example-mixed', targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats: {
      source: { url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/isolated-mixed/mixed.json` },
      binary: { url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/isolated-mixed/mixed.srs` },
    },
  });
  const snapshot = await env.context.repository.snapshot();
  const prefix = `candidates/${current.candidateId}`;
  const readJson = async (path: string) => JSON.parse((await snapshot.read(path))!.toString());
  const manifest = await readJson(prefix + '/manifest.json');
  const build = await readJson(prefix + '/build.json');
  const journal = await readJson(RULE_STATE_PATH);
  assert.equal(journal.candidates[current.candidateId].source.url, url);
  assert.doesNotMatch(JSON.stringify([journal.candidates[current.candidateId], manifest, build, current,
    await readJson(prefix + '/conversion-report.json')]), /"(?:projections|usages|usageCounts)":/);

  const directory = await mkdtemp(join(tmpdir(), 'rules-mixed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(Object.keys(current.files).sort(), ['stable/isolated-mixed/mixed.json', 'stable/isolated-mixed/mixed.srs']);
  for (const [format, extension] of [['source', 'json'], ['binary', 'srs']] as const) {
    const path = `stable/isolated-mixed/mixed.${extension}`;
    const deliveryUrl = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/${path}`;
    const file = await env.context.repository.download(deliveryUrl);
    const artifact = manifest.artifacts.find((entry: { format: string }) => entry.format === format);
    assert.equal(artifact.sha256, sha256(file));
    assert.equal(artifact.byteLength, file.length);
    assert.deepEqual(current.files[path], { sha256: sha256(file), byteLength: file.length });
    const local = join(directory, `mixed.${extension}`);
    await writeFile(local, file);
    for (const [value, expected] of [
      ['api.mixed.example', true], ['notmixed.example', false],
      ['192.0.2.1', true], ['192.0.3.1', false],
      ['2001:db8::1', true], ['2001:db9::1', false],
    ] as const) {
      const { stdout, stderr }: { stdout: string; stderr: string } = await exec(binary!, ['rule-set', 'match', local, value, '--format', format]);
      assert.equal((stdout + stderr).includes('match rules.'), expected, `${format}: ${value}`);
    }
  }
});

test('v4 sync rejects a damaged candidate digest and can release the same repaired candidate', async () => {
  const env = fixture();
  env.beforeWrite(async files => {
    const state = files[RULE_STATE_PATH];
    if (state && JSON.parse(state.toString()).pendingDelivery) throw new Error('RULE_WRITE_CONFLICT: interrupted after evidence');
  });
  const interrupted = await syncRules(env.request);
  assert.notEqual(interrupted.status, 'success');
  env.beforeWrite();

  const snapshot = await env.context.repository.snapshot();
  const journal = JSON.parse((await snapshot.read(RULE_STATE_PATH))!.toString());
  const [candidateId] = Object.keys(journal.candidates);
  assert.ok(candidateId);
  const prefix = `candidates/${candidateId}`;
  const readback = JSON.parse((await snapshot.read(prefix + '/readback.json'))!.toString());
  assert.ok(readback.versionId);
  for (const [filename, diagnostic] of [
    ['manifest.json', /Artifact integrity or capability mismatch: mixed\.srs/],
    ['build.json', /Build artifact mismatch: mixed\.srs/],
  ] as const) {
    const path = `${prefix}/${filename}`;
    const retained = await env.context.repository.snapshot();
    const original = (await retained.read(path))!;
    const record = JSON.parse(original.toString());
    const binaryFile = record.artifacts.find((entry: { format: string }) => entry.format === 'binary');
    binaryFile.sha256 = '0'.repeat(64);
    env.trees.get(retained.head)!.set(path, Buffer.from(JSON.stringify(record)));

    const refused = await syncRules(env.request);
    assert.equal(refused.status, 'failed');
    assert.match(refused.results[0].error!, diagnostic);
    const failed = await env.context.repository.snapshot();
    assert.equal(await failed.read('stable/isolated-mixed/mixed.json'), undefined);
    assert.equal(await failed.read('stable/isolated-mixed/mixed.srs'), undefined);
    env.trees.get(failed.head)!.set(path, original);
  }
  const recovered = await syncRules(env.request);
  assert.equal(recovered.status, 'success', JSON.stringify(recovered));
  assert.equal(recovered.results[0].current?.candidateId, candidateId);
  assert.equal(recovered.results[0].current?.versionId, readback.versionId);
  assert.deepEqual(env.requests, [url], 'candidate revalidation uses retained data');
});

test('v4 sync rejects duplicate upstream JSON keys without releasing a narrowed rule set', async () => {
  const env = fixture('{"version":4,"rules":[{"domain_suffix":["first.example"],"domain_suffix":["second.example"]}]}');
  const result = await syncRules(env.request);
  assert.equal(result.status, 'failed');
  assert.match(result.results[0].error!, /Map keys must be unique/);
  assert.equal(result.results[0].current, undefined);
});

test('v4 sync accepts a large array of matching values and removes repeated terms', async () => {
  const env = fixture(JSON.stringify({
    version: 4,
    rules: [{ domain_suffix: Array(150_000).fill('mixed.example') }, { ip_cidr: ['192.0.2.0/24'] }],
  }));
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  const snapshot = await env.context.repository.snapshot();
  assert.deepEqual(JSON.parse((await snapshot.read('stable/isolated-mixed/mixed.json'))!.toString()), {
    version: 4, rules: [{ domain_suffix: ['mixed.example'] }, { ip_cidr: ['192.0.2.0/24'] }],
  });
});
