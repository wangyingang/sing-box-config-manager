import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { syncRules } from '../../src/rules-operations.js';
import { sha256 } from '../../src/release.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const branch = 'acceptance-issue-173';
const url = 'https://rules.example.test/issue-173.json';
const path = 'stable/issue-173/combined';

function fixture(input: unknown) {
  let body = input;
  const env = rulesEnvironment(binary!, branch);
  env.context.readConfiguration = async () => ({
    origin: 'isolated-fixture', revision: '173',
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
  example-combined:
    data:
      source: example
    publishPath: stable/issue-173
    artifact: combined
`,
  });
  env.context.fetch = async address => {
    assert.equal(String(address), url);
    return Response.json(body);
  };
  return { ...env, request: { context: env.context }, updateInput(next: unknown) { body = next; } };
}

test('v4 sync preserves AND and skips a whole rule with an unsupported child', async t => {
  const env = fixture({
    version: 4,
    rules: [
      { type: 'logical', mode: 'and', rules: [{ domain_suffix: 'both.example' }, { domain_keyword: 'api' }] },
      { type: 'logical', mode: 'and', rules: [{ domain: 'skipped.example' }, { asn: [64512] }] },
      { ip_cidr: ['192.0.2.0/24', '2001:db8::/32'] },
      {
        type: 'logical', mode: 'and',
        rules: [
          { type: 'logical', mode: 'or', rules: [{ domain: 'api.nested.example' }, { domain_suffix: 'nested-alt.example' }] },
          { domain_keyword: 'blocked', invert: true },
        ],
      },
      { domain_suffix: 'default.example', domain_keyword: 'keyword-condition', port: 0 },
      { domain: 'wrong-port.example', port: 443 },
      { domain: 'v5-field.example', package_name_regex: '^com[.]example[.]' },
      { type: 'logical', mode: 'or', invert: true, rules: [{ domain: 'retained-child.example' }, { rule_set: 'other-set' }] },
      { domain: 'wrong-value.example', source_port: -1 },
      { type: 'logical', mode: 'and', rules: [{ domain: 'bad-regex.example' }, { domain_regex: '[' }] },
      { ip_cidr: 'bad-cidr' },
      { domain: 'bad-query.example', query_type: 'NOT_A_DNS_RECORD' },
    ],
  });
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.results[0].status, 'delivered');
  const current = result.results[0].current!;
  const snapshot = await env.context.repository.snapshot();
  const report = JSON.parse((await snapshot.read(`candidates/${current.candidateId}/conversion-report.json`))!.toString());
  assert.equal(report.unsupportedCount, 3);
  assert.equal(report.invalidCount, 4);
  assert.deepEqual(report.skippedRuleTypeCounts, { asn: 1, package_name_regex: 1, rule_set: 1, source_port: 1, logical: 1, ip_cidr: 1, default: 1 });
  assert.deepEqual(report.diagnostics.map(({ index, code }: { index: number; code: string }) => [index, code]), [
    [1, 'UNSUPPORTED_SING_BOX_RULE'], [6, 'UNSUPPORTED_SING_BOX_RULE'], [7, 'UNSUPPORTED_SING_BOX_RULE'], [8, 'INVALID_SING_BOX_RULE'],
    [9, 'INVALID_SING_BOX_RULE'], [10, 'INVALID_SING_BOX_RULE'], [11, 'INVALID_SING_BOX_RULE'],
  ]);
  assert.match(report.diagnostics[0].message, /rules\[1\]\.rules\[1\].*asn/);
  t.diagnostic(JSON.stringify({ target: branch, path, skipped: report.diagnostics }));

  const directory = await mkdtemp(join(tmpdir(), 'rule-source-173-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [format, extension] of [['source', 'json'], ['binary', 'srs']] as const) {
    const url = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/${path}.${extension}`;
    const file = await env.context.repository.download(url);
    assert.deepEqual(current.files[`${path}.${extension}`], { sha256: sha256(file), byteLength: file.length });
    const local = join(directory, `combined.${extension}`);
    await writeFile(local, file);
    for (const [value, expected] of [
      ['api.both.example', true], ['www.both.example', false], ['api.other.example', false],
      ['www.other.example', false], ['skipped.example', false],
      ['192.0.2.10', true], ['192.0.3.10', false], ['2001:db8::10', true], ['2001:db9::10', false],
      ['api.nested.example', true], ['sub.nested-alt.example', true], ['blocked.nested-alt.example', false],
      ['regular.default.example', true], ['keyword-condition.example', true], ['unrelated.example', false],
      ['wrong-port.example', false], ['v5-field.example', false], ['wrong-value.example', false],
      ['bad-regex.example', false], ['bad-query.example', false],
    ] as const) {
      const { stdout, stderr }: { stdout: string; stderr: string } = await exec(binary!, ['rule-set', 'match', local, value, '--format', format]);
      assert.equal((stdout + stderr).includes('match rules.'), expected, `${format}: ${value}`);
    }
    t.diagnostic(`${format} sha256 ${sha256(file)}: native matching matrix passed`);
  }
});


test('v4 sync compiles the remaining Source Format v4 condition families', async () => {
  const extraConditions = {
    query_type: ['AAAA', 65], network: ['tcp', 'udp'], source_ip_cidr: '198.51.100.0/24', source_port: 443,
    source_port_range: '1024:', port_range: ':1000', process_name: 'fixture', process_path: '/example/fixture',
    process_path_regex: '^/example/', package_name: 'com.example.fixture', network_type: 'wifi',
    network_is_expensive: true, network_is_constrained: true, wifi_ssid: 'test-wifi', wifi_bssid: '00:11:22:33:44:55',
    network_interface_address: { wifi: '2001:db8::/32', ethernet: ['192.0.2.0/24'] },
    default_interface_address: '192.0.2.1', domain_regex: '^api[.]example$',
  };
  const env = fixture({ version: 4, rules: [extraConditions] });
  const result = await syncRules(env.request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.results[0].status, 'delivered');
  const snapshot = await env.context.repository.snapshot();
  const source = JSON.parse((await snapshot.read(`${path}.json`))!.toString());
  assert.deepEqual(source.rules, [Object.fromEntries(Object.entries(extraConditions).map(([key, value]) =>
    [key, typeof value === 'string' || typeof value === 'number' ? [value]
      : key === 'network_interface_address' ? { ethernet: ['192.0.2.0/24'], wifi: ['2001:db8::/32'] } : value]))]);
  assert.equal((await snapshot.read(`${path}.srs`))?.[3], 4, 'interface address conditions require an SRS v4 output');
});

test('v4 sync keeps the previous pair when all rules are skipped or the version is unsupported', async () => {
  const badRules = [{ type: 'logical', mode: 'and', rules: [{ domain: 'skipped.example' }, { asn: [64512] }] }];
  const env = fixture({ version: 4, rules: badRules });
  const failed = await syncRules(env.request);
  assert.equal(failed.status, 'failed');
  assert.match(failed.results[0].error!, /No rules could be converted.*asn/);
  assert.equal(failed.results[0].current, undefined);
  assert.deepEqual(failed.results[0].conversionReport?.skippedRuleTypeCounts, { asn: 1 });

  const goodRules = [{ domain: 'previous.example' }, { domain: 'second.example' }];
  env.updateInput({ version: 4, rules: goodRules });
  const delivered = await syncRules(env.request);
  assert.equal(delivered.results[0].status, 'delivered');
  env.updateInput({ version: 4, rules: [...goodRules, ...badRules] });
  const unchanged = await syncRules(env.request);
  assert.equal(unchanged.results[0].status, 'unchanged');
  assert.deepEqual(unchanged.results[0].current, delivered.results[0].current);
  assert.deepEqual(unchanged.results[0].conversionReport?.skippedRuleTypeCounts, { asn: 1 });
  for (const [input, reason] of [
    [{ version: 4, rules: badRules }, /No rules could be converted/],
    [{ version: 5, rules: [{ domain: 'previous.example' }] }, /Expected Source Format version 4/],
  ] as const) {
    env.updateInput(input);
    const refused = await syncRules(env.request);
    assert.equal(refused.status, 'failed');
    assert.match(refused.results[0].error!, reason);
    assert.deepEqual(refused.results[0].current, delivered.results[0].current);
  }
});

test('v4 sync publishes a genuinely empty source as an empty pair', async t => {
  const env = fixture({ version: 4, rules: [] });
  const delivered = await syncRules(env.request);
  assert.equal(delivered.results[0].status, 'delivered', JSON.stringify(delivered));
  const snapshot = await env.context.repository.snapshot();
  assert.deepEqual(JSON.parse((await snapshot.read(`${path}.json`))!.toString()), { version: 4, rules: [] });
  const directory = await mkdtemp(join(tmpdir(), 'rule-source-173-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = join(directory, 'empty.srs');
  await writeFile(local, (await snapshot.read(`${path}.srs`))!);
  const { stdout, stderr } = await exec(binary!, ['rule-set', 'match', local, 'empty.example', '--format', 'binary']);
  assert.doesNotMatch(stdout + stderr, /match rules\./);
});


test('v4 sync preserves separate top-level rules and prevents newly merging with outer rules after skips', async t => {
  const rules = [{ domain: 'first.example' }, { domain: 'second.example' }, { domain: 'first.example' }];
  const env = fixture({ version: 4, rules });
  const directory = await mkdtemp(join(tmpdir(), 'rule-source-173-boundaries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const delivered = await syncRules(env.request);
  assert.equal(delivered.results[0].status, 'delivered');
  const snapshot = await env.context.repository.snapshot();
  assert.deepEqual(JSON.parse((await snapshot.read(`${path}.json`))!.toString()).rules,
    [{ domain: ['first.example'] }, { domain: ['second.example'] }, { domain: ['first.example'] }]);
  const local = join(directory, 'boundaries.srs');
  await writeFile(local, (await snapshot.read(`${path}.srs`))!);
  const { stdout, stderr } = await exec(binary!, ['rule-set', 'match', local, 'first.example', '--format', 'binary']);
  assert.deepEqual([...((stdout + stderr).matchAll(/match rules\.\[(\d+)\]/g))].map(match => match[1]), ['0', '2']);

  env.updateInput({ version: 4, rules: [{ domain: 'first.example' }, { asn: 64512 }] });
  const changed = await syncRules(env.request);
  assert.equal(changed.results[0].status, 'delivered');
  const stable = await env.context.repository.snapshot();
  assert.deepEqual(JSON.parse((await stable.read(`${path}.json`))!.toString()).rules, [
    { type: 'logical', mode: 'or', rules: [{ domain: ['first.example'] }] },
  ]);
});

test('v4 sync reports a native-invalid rule when rebuilding a candidate from its original snapshot', async () => {
  const env = fixture({
    version: 4,
    rules: [{ domain: 'native-validation.invalid' }, { domain_regex: '[' }],
  });
  env.beforeWrite(async files => {
    if (Object.keys(files).some(file => /^candidates\/[^/]+\/combined.json$/.test(file))) {
      throw new Error('RULE_WRITE_CONFLICT: interrupted before candidate files');
    }
  });
  const interrupted = await syncRules(env.request);
  assert.match(interrupted.results[0].error!, /interrupted before candidate files/);
  env.beforeWrite();
  env.updateInput({ version: 5, rules: [] });
  const recovered = await syncRules(env.request);
  assert.equal(recovered.results[0].status, 'delivered', JSON.stringify(recovered));
  assert.deepEqual(recovered.results[0].conversionReport?.skippedRuleTypeCounts, { domain_regex: 1 });
  const snapshot = await env.context.repository.snapshot();
  assert.deepEqual(JSON.parse((await snapshot.read(`${path}.json`))!.toString()).rules, [
    { type: 'logical', mode: 'or', rules: [{ domain: ['native-validation.invalid'] }] },
  ]);
});
