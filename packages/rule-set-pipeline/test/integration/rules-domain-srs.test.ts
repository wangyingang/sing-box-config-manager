import assert from 'node:assert/strict';
import test from 'node:test';
import { formalConfiguration } from '../fixtures/formal-configuration.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';
import { buildRuleArtifacts, decompileRuleBinary } from '../../src/native.js';
import { sha256 } from '../../src/release.js';
import { syncRules } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

test('旧 DLC 交付保持可用，SRS 候选从固定快照恢复后通过原订阅换源', async () => {
  const env = rulesEnvironment(binary, 'acceptance-china-domains-srs');
  const request = { context: env.context };
  const branch = env.context.targetBranch;
  const config = formalConfiguration();
  config.target.branch = branch;
  config.ruleSets = config.ruleSets.filter(rule => rule.id === 'china-domains');
  const [definition] = config.ruleSets;
  env.configure({ ...config, ruleSets: [{ ...definition, source: 'dlc', list: 'geolocation-cn' }] });

  const rule = { domain: ['exact.example'], domain_suffix: ['.child-only.example'],
    domain_keyword: ['keyword'], domain_regex: ['^regex[0-9]+\\.example$'] };
  const native = await buildRuleArtifacts([{ type: 'headless', rule }], binary, { kind: 'single-artifact', artifact: 'domains' });
  const bytes = native.artifacts.find(artifact => artifact.format === 'binary')!.content;
  const dlc = JSON.stringify({ lists: [{ name: 'geolocation-cn', length: 1, rules: ['domain:dlc-only.example'] }] });
  const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
  const pinnedBody = (commit: string) => `https://raw.githubusercontent.com/SagerNet/sing-geosite/${commit}/geosite-geolocation-cn.srs`;
  let commit = oldCommit;
  let body: Buffer<ArrayBuffer> = Buffer.from('invalid SRS');
  const downloads: string[] = [];
  env.context.fetch = async url => {
    const address = String(url);
    if (address.endsWith('/dlc.dat_plain.yml')) return new Response(dlc);
    if (address.endsWith('/dlc.dat_plain.yml.sha256sum')) return new Response(sha256(dlc));
    if (address === 'https://api.github.com/repos/SagerNet/sing-geosite/branches/rule-set') {
      return Response.json({ name: 'rule-set', commit: { sha: commit } });
    }
    downloads.push(address);
    return address === pinnedBody(commit) ? new Response(body) : new Response(null, { status: 404 });
  };
  const before = await syncRules(request);
  assert.equal(before.status, 'success', JSON.stringify(before));
  const old = before.results[0].current!;
  const url = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/china-domains/domains`;
  const oldArtifacts = await Promise.all(['json', 'srs'].map(ext => env.context.repository.download(`${url}.${ext}`)));

  env.configure(config);
  const invalid = await syncRules(request);
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.results[0].error!, /Cannot convert SRS input geosite-geolocation-cn.srs/);
  assert.deepEqual(invalid.results[0].current, old);
  assert.deepEqual(await Promise.all(['json', 'srs'].map(ext => env.context.repository.download(`${url}.${ext}`))), oldArtifacts);

  body = Buffer.from(bytes);
  env.beforeWrite(async files => {
    if (Object.keys(files).some(path => /^candidates\/[^/]+\/domains\.json$/.test(path))) {
      throw new Error('RULE_WRITE_CONFLICT: interrupted before candidate files');
    }
  });
  const interrupted = await syncRules(request);
  assert.match(interrupted.results[0].error!, /interrupted before candidate files/);
  env.beforeWrite();
  const saved = await env.context.repository.snapshot();
  const snapshotPath = saved.paths.find(path => path.endsWith('/input.source.srs'))!;
  assert.deepEqual(await saved.read(snapshotPath), bytes);
  const recoveredId = snapshotPath.split('/')[1];

  // The force-pushed upstream no longer serves the interrupted candidate's commit.
  downloads.length = 0;
  commit = newCommit;
  const after = await syncRules(request);
  assert.equal(after.status, 'success', JSON.stringify(after));
  assert.equal(after.results[0].status, 'delivered');
  assert.deepEqual(downloads, [pinnedBody(newCommit)]);
  const current = after.results[0].current!;
  assert.ok('commit' in current.source);
  assert.equal(current.source.commit, newCommit);
  assert.notEqual(current.candidateId, recoveredId);
  assert.deepEqual(current.subscription, old.subscription);
  const [json, srs] = await Promise.all(['json', 'srs'].map(ext => env.context.repository.download(`${url}.${ext}`)));
  assert.deepEqual(JSON.parse(json.toString()), { version: 4, rules: [rule] });
  const originalRules = JSON.parse(await decompileRuleBinary(bytes, binary)).rules;
  assert.deepEqual(JSON.parse(await decompileRuleBinary(srs, binary)).rules, originalRules);
  const status = await getRulesStatus({ ...request, id: 'china-domains' });
  assert.ok(status.rules?.[0].candidates.some(candidate => candidate.id === recoveredId && candidate.selectable));
});
