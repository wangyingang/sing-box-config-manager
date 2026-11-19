import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { sha256 } from '../../src/release.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

function fourSources() {
  const env = rulesEnvironment(binary!);
  const config = parseBuildConfiguration(readOfficialConfiguration());
  config.target.branch = env.context.targetBranch;
  config.ruleSets = config.ruleSets.filter(rule => rule.id !== 'chatgpt-voice');
  env.configure(config);
  const releaseFetch = env.context.fetch!;
  let revision = 1, cidr = '192.0.2.0/25\n2001:db8:1::/48\n';
  const requests: string[] = [];
  env.context.fetch = async (url, init) => {
    const address = String(url); requests.push(address);
    if (address.endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: String(revision).repeat(40) } });
    if (address.includes('raw.githubusercontent.com/gaoyifan/')) {
      assert.ok(address.endsWith(`/${String(revision).repeat(40)}/china46.txt`));
      return new Response(cidr);
    }
    return releaseFetch(url, init);
  };
  return { ...env, requests, changeCidr(value: string) { revision++; cidr = value; } };
}

test('四集共享各自来源；仅 CIDR 变化只交付 CIDR，新 commit 同语义不新增版本', async () => {
  const env = fourSources(), request = { context: env.context };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  assert.deepEqual(first.results.map(x => x.status), ['delivered', 'delivered', 'delivered', 'delivered']);
  for (const suffix of ['/latest', '/assets/11', '/assets/12', '/branches/ip-lists', '/china46.txt']) {
    assert.equal(env.requests.filter(url => url.endsWith(suffix)).length, 1, suffix);
  }
  const old = await getRulesStatus(request);
  env.upstream({}); env.changeCidr('192.0.2.128/25\n2001:db8:2::/48\n');
  const next = await syncRules(request);
  assert.equal(next.status, 'success', JSON.stringify(next));
  assert.deepEqual(next.results.map(x => x.status), ['unchanged', 'unchanged', 'unchanged', 'delivered']);
  for (let i = 0; i < 3; i++) assert.deepEqual(next.results[i].current, first.results[i].current);
  const cidrSource = next.results[3].current?.source;
  assert.ok(cidrSource && 'commit' in cidrSource); assert.equal(cidrSource.commit, '2'.repeat(40));
  assert.notEqual(next.results[3].current?.versionId, first.results[3].current?.versionId);
  const before = await getRulesStatus(request), writes = env.writes.length;
  env.upstream({}); env.changeCidr('# same ranges\n2001:db8:2::/48\n192.0.2.128/25\n');
  const unchanged = await syncRules(request);
  assert.deepEqual(unchanged.results.map(x => x.status), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.equal(env.writes.length, writes + 4, 'one success checkpoint per new input identity');
  const checkpointed = env.writes.length;
  assert.equal((await syncRules(request)).status, 'success');
  assert.equal(env.writes.length, checkpointed);
  const after = await getRulesStatus(request);
  assert.deepEqual(after.rules?.map(x => [x.current, x.candidates]), before.rules?.map(x => [x.current, x.candidates]));
  assert.deepEqual(old.rules?.map(x => x.candidateCount), [1, 1, 1, 1]);
  assert.deepEqual(after.rules?.map(x => x.candidateCount), [1, 1, 1, 2]);
});

for (const fault of ['release-offline', 'checksum', 'yaml', 'missing-list', 'invalid-list', 'cidr', 'readback'] as const) {
  test(`四集混合失败 ${fault}：保留当前与独立成功，后续 sync 可恢复`, async () => {
    const env = fourSources(), request = { context: env.context };
    const first = await syncRules(request); assert.equal(first.status, 'success', JSON.stringify(first));
    env.upstream({ openai: 'domain:next.example', anthropic: 'domain:anthropic-next.example' });
    env.changeCidr(fault === 'cidr' ? 'invalid CIDR' : '198.51.100.0/24\n');
    const fetcher = env.context.fetch!;
    env.context.fetch = async (url, init) => {
      const address = String(url);
      if (fault === 'release-offline' && address.includes('v2fly/')) throw new Error('Source offline');
      if (fault === 'checksum' && address.endsWith('/assets/22')) return new Response('0'.repeat(64) + '  dlc.dat_plain.yml\n');
      if (['yaml', 'missing-list', 'invalid-list'].includes(fault) && /\/assets\/2[12]$/.test(address)) {
        const lists = [{ name: 'anthropic', length: 1, rules: ['domain:anthropic-next.example'] },
          { name: 'google-deepmind', length: 1, rules: ['domain:google-deepmind.example'] }];
        if (fault === 'invalid-list') lists.push({ name: 'openai', length: 1, rules: ['unsupported:bad.example'] });
        const body = fault === 'yaml' ? 'lists: [' : JSON.stringify({ lists });
        return new Response(address.endsWith('/assets/22') ? `${sha256(body)}  dlc.dat_plain.yml\n` : body);
      }
      return fetcher(url, init);
    };
    const download = env.context.repository.download;
    if (fault === 'readback') env.context.repository.download = async url => {
      // Only the newly built OpenAI artifact is unavailable. Other rules must finish.
      const bytes = await download(url);
      if (url.includes('/candidates/') && url.endsWith('/domains.json') && bytes.includes('next.example') && !bytes.includes('anthropic')) throw new Error('Readback offline');
      return bytes;
    };
    const result = await syncRules(request);
    assert.equal(result.status, 'partial', JSON.stringify(result)); assert.equal(result.exitCode, 1);
    const commonFailure = ['release-offline', 'checksum', 'yaml'].includes(fault);
    const expected = commonFailure ? ['failed', 'failed', 'failed', 'delivered']
      : fault === 'cidr' ? ['delivered', 'delivered', 'unchanged', 'failed'] : ['failed', 'delivered', 'unchanged', 'delivered'];
    assert.deepEqual(result.results.map(x => x.status), expected);
    if (commonFailure) assert.deepEqual((await getRulesStatus(request)).rules?.map(x => x.candidateCount), [1, 1, 1, 2]);
    for (let i = 0; i < 4; i++) {
      const entry = result.results[i];
      const successful = entry.successfulInput?.source;
      if (entry.status === 'failed' || entry.status === 'pending') {
        assert.deepEqual(entry.successfulInput, first.results[i].successfulInput);
      } else if (entry.id === 'china-ip') {
        assert.ok(successful && 'commit' in successful); assert.equal(successful.commit, '2'.repeat(40));
      } else {
        assert.equal(successful && 'releaseId' in successful && successful.releaseId, 2);
      }
      if (entry.status === 'failed' || entry.status === 'unchanged') {
        assert.deepEqual(entry.current, first.results[i].current);
        for (const [path, evidence] of Object.entries(entry.current!.files)) {
          const bytes = await download(`https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${env.heads.get(env.context.targetBranch)}/${path}`);
          assert.equal(sha256(bytes), evidence.sha256); assert.equal(bytes.length, evidence.byteLength);
        }
      }
    }
    env.context.fetch = fetcher; env.context.repository.download = download;
    if (fault === 'cidr') env.changeCidr('198.51.100.0/24\n');
    const retried = await syncRules(request); assert.equal(retried.status, 'success', JSON.stringify(retried));
    for (let i = 0; i < 4; i++) if (expected[i] === 'delivered') assert.deepEqual(retried.results[i].current, result.results[i].current);
  });
}

test('首次同步缺少单列表时该集未交付且无候选，其他三集独立成功', async () => {
  const env = fourSources(), request = { context: env.context }, fetcher = env.context.fetch!;
  const body = JSON.stringify({ lists: [
    { name: 'anthropic', length: 1, rules: ['domain:anthropic.example'] },
    { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.example'] },
  ] });
  env.context.fetch = async (url, init) => String(url).endsWith('/assets/11') ? new Response(body)
    : String(url).endsWith('/assets/12') ? new Response(`${sha256(body)}  dlc.dat_plain.yml\n`) : fetcher(url, init);
  const result = await syncRules(request);
  assert.equal(result.status, 'partial', JSON.stringify(result)); assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results.map(x => x.status), ['failed', 'delivered', 'delivered', 'delivered']);
  assert.equal(result.results[0].current, undefined);
  const status = await getRulesStatus({ context: { ...env.context } });
  assert.equal(status.rules?.[0].deliveryState, 'not-delivered');
  assert.deepEqual(status.rules?.map(x => x.candidateCount), [0, 1, 1, 1]);
});

test('CIDR resume 输入失败保留当前并解除固定，不访问域名来源或改变兄弟固定', async () => {
  const env = fourSources(), request = { context: env.context };
  const first = await syncRules(request); assert.equal(first.status, 'success', JSON.stringify(first));
  for (const id of ['openai', 'china-ip']) {
    const current = first.results.find(x => x.id === id)!.current!;
    assert.equal((await pinRuleVersion({ ...request, id, version: current.versionId! })).status, 'success');
  }
  const before = await getRulesStatus(request);
  env.changeCidr('invalid CIDR'); env.requests.length = 0;
  const failed = await resumeRuleUpdates({ ...request, id: 'china-ip' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 1);
  assert.equal(failed.results.length, 1); assert.equal(failed.results[0].control?.mode, 'auto');
  assert.deepEqual(failed.results[0].current, before.rules?.find(x => x.id === 'china-ip')?.current);
  assert.ok(env.requests.length > 0 && env.requests.every(url => url.includes('gaoyifan/china-operator-ip')));
  const after = await getRulesStatus(request);
  for (const id of ['openai', 'anthropic', 'google-deepmind']) {
    const old = before.rules!.find(x => x.id === id)!, current = after.rules!.find(x => x.id === id)!;
    assert.deepEqual(current.current, old.current); assert.deepEqual(current.control, old.control);
  }
  env.changeCidr('198.51.100.0/24\n');
  const retry = await syncRules({ context: { ...env.context } });
  assert.equal(retry.status, 'success', JSON.stringify(retry));
  assert.equal(retry.results.find(x => x.id === 'openai')?.status, 'pinned-skipped');
  assert.equal(retry.results.find(x => x.id === 'china-ip')?.status, 'delivered');
  assert.equal(retry.results.find(x => x.id === 'china-ip')?.control?.revision, failed.results[0].control?.revision);
});

test('合法 ID constructor 经 sync、独立会话 status、pin 和 resume 保留版本身份', async () => {
  const env = rulesEnvironment(binary!); const config = env.config();
  config.ruleSets = [{ ...config.ruleSets[0], id: 'constructor', stablePath: 'stable/constructor' }]; env.configure(config);
  const request = { context: env.context };
  const first = await syncRules(request); assert.equal(first.status, 'success', JSON.stringify(first));
  const current = first.results[0].current!;
  const status = await getRulesStatus({ context: { ...env.context } });
  assert.equal(status.rules?.[0].id, 'constructor'); assert.deepEqual(status.rules?.[0].current, current);
  assert.equal((await pinRuleVersion({ ...request, id: 'constructor', version: current.versionId! })).status, 'success');
  assert.equal((await syncRules(request)).results[0].status, 'pinned-skipped');
  const resumed = await resumeRuleUpdates({ ...request, id: 'constructor' });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].current?.versionId, current.versionId);
  assert.equal(resumed.results[0].current?.candidateId, current.candidateId);
  assert.deepEqual(resumed.results[0].current?.files, current.files);
});
for (const mechanism of ['latest-release', 'git-branch'] as const) for (const format of ['plain-yaml', 'cidr-text'] as const) {
  test(`配置新增任意仓库：${mechanism} + ${format} 完成交付、证据复验及 pin`, { skip: !binary }, async () => {
    const env = rulesEnvironment(binary!); const config = env.config();
    const repo = 'another-owner/another-repo'; const commit = 'b'.repeat(40), tag = 'v2.3.0';
    const body = format === 'plain-yaml' ? JSON.stringify({ lists: [{ name: 'other', length: 1, rules: ['domain:example.org'] }] }) : '192.0.2.0/24\n2001:db8::/32\n';
    const rule = { ...config.ruleSets[0], id: 'custom', list: format === 'plain-yaml' ? 'other' : 'all', source: 'custom', stablePath: 'stable/custom' };
    if (format === 'cidr-text') rule.usages = { route: { artifact: 'route' }, 'dns-query': { unavailable: 'empty' }, 'dns-response': { artifact: 'route' } };
    config.ruleSets = [rule]; config.sources = { custom: mechanism === 'latest-release'
      ? { repository: repo, version: mechanism, input: { format, asset: 'rules.data', checksum: 'rules.sha256' } }
      : { repository: repo, version: mechanism, branch: 'data/rules', input: { format, path: 'lists/rules.data' } } };
    env.configure(config);
    const requests: string[] = [];
    env.context.fetch = async address => {
      const url = String(address); requests.push(url);
      assert.ok(url.includes(repo), url);
      if (url.includes('/branches/')) { assert.ok(url.endsWith('data%2Frules')); return Response.json({ name: 'data/rules', commit: { sha: commit } }); }
      if (url.includes('raw.githubusercontent.com/')) { assert.ok(url.endsWith(`/${commit}/lists/rules.data`)); return new Response(body); }
      if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: commit } });
      if (url.endsWith('/assets/10')) return new Response(body);
      if (url.endsWith('/assets/11')) return new Response(`${sha256(body)}  rules.data\n`);
      if (url.includes('/releases/')) return Response.json({ id: 3, tag_name: tag, assets: ['rules.data', 'rules.sha256'].map((name, i) =>
        ({ id: i + 10, name, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` })) });
      throw new Error(`Unexpected request ${url}`);
    };
    const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success', JSON.stringify(first));
    const acquired = first.results[0].current?.source;
    assert.ok(acquired && 'repository' in acquired); assert.equal(acquired.repository, repo);
    const status = await getRulesStatus({ context: env.context }); assert.equal(status.rules?.[0].candidateCount, 1);
    const before = requests.length;
    const pinned = await pinRuleVersion({ context: env.context, id: 'custom', version: first.results[0].current!.versionId! });
    assert.equal(pinned.status, 'success', JSON.stringify(pinned)); assert.equal(requests.length, before);
  });
}
