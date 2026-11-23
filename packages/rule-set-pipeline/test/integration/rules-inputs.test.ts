import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus, type RuleStatus } from '../../src/rules-status.js';
import { formalConfiguration } from '../fixtures/formal-configuration.js';
import { sha256 } from '../../src/release.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';
import { baselineV4Configuration } from '../fixtures/formal-configuration.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

function fourSources() {
  const env = rulesEnvironment(binary!);
  const config = baselineV4Configuration(false);
  config.target.branch = env.context.targetBranch;
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
  for (const suffix of ['/dlc.dat_plain.yml', '/dlc.dat_plain.yml.sha256sum', '/branches/ip-lists', '/china46.txt']) {
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
      if (fault === 'checksum' && address.endsWith('/dlc.dat_plain.yml.sha256sum')) return new Response('0'.repeat(64) + '  dlc.dat_plain.yml\n');
      if (['yaml', 'missing-list', 'invalid-list'].includes(fault) && /\/dlc\.dat_plain\.yml(?:\.sha256sum)?$/.test(address)) {
        const lists = [{ name: 'anthropic', length: 1, rules: ['domain:anthropic-next.example'] },
          { name: 'google-deepmind', length: 1, rules: ['domain:google-deepmind.example'] }];
        if (fault === 'invalid-list') lists.push({ name: 'openai', length: 1, rules: ['unsupported:bad.example'] });
        const body = fault === 'yaml' ? 'lists: [' : JSON.stringify({ lists });
        return new Response(address.endsWith('/dlc.dat_plain.yml.sha256sum') ? `${sha256(body)}  dlc.dat_plain.yml\n` : body);
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
        assert.ok(successful && 'kind' in successful && successful.kind === 'fixed-url');
        assert.notEqual(successful.inputSha256, first.results[i].successfulInput?.source.inputSha256);
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

test('YAML 自定义名称随两类规则交付，内容复用与稳定订阅各自保留名称', async () => {
  const env = rulesEnvironment(binary!, 'acceptance-artifact-names');
  const config = env.config();
  config.sources.cidr = formalConfiguration().sources['china-operator-ip'];
  const domain = config.ruleSets[0];
  domain.artifact = 'ips';
  const ip = (id: string, artifact: string) => ({
    id, source: 'cidr', stablePath: `stable/${id}`, artifact,
  });
  config.ruleSets = [domain, ip('china-ip', 'office-networks'), ip('ip-copy', 'branch-networks')];
  env.configure(config);
  const request = { context: env.context };
  const synced = await syncRules(request);
  assert.equal(synced.status, 'success', JSON.stringify(synced));
  assert.deepEqual(synced.results.map(row => row.status), ['delivered', 'delivered', 'delivered']);

  const status = await getRulesStatus(request);
  assert.equal(status.status, 'success', JSON.stringify(status));
  assert.equal(status.rules?.length, 3);
  const snapshot = await env.context.repository.snapshot();
  for (const rule of config.ruleSets) {
    const { artifact } = rule;
    const item: RuleStatus = status.rules!.find(row => row.id === rule.id)!;
    const current = item.current!;
    assert.equal(item.deliveryState, 'delivered');
    assert.equal(item.candidateCount, 1);
    assert.ok(item.candidates.some(candidate => candidate.id === current.candidateId && candidate.current && candidate.selectable));
    const candidatePath = `candidates/${current.candidateId}/`;
    const manifest = JSON.parse((await snapshot.read(candidatePath + 'manifest.json'))!.toString());
    const evidence = JSON.parse((await snapshot.read(candidatePath + 'readback.json'))!.toString());
    assert.equal(Object.hasOwn(manifest, 'projections'), false);
    assert.deepEqual(item.stableUrls.map(url => url.split('/').at(-1)).sort(), [artifact + '.json', artifact + '.srs']);
    assert.equal(manifest.artifacts.length, 2);
    for (const entry of manifest.artifacts) {
      const file = artifact + (entry.format === 'source' ? '.json' : '.srs');
      assert.ok(entry.url.endsWith('/' + candidatePath + file));
      const stableUrl = item.stableUrls.find(url => url.endsWith('/' + file))!;
      const stable = await env.context.repository.download(stableUrl);
      const candidate = await env.context.repository.download(entry.url);
      assert.ok(stable.length > 0);
      assert.deepEqual(stable, candidate);
      assert.equal(entry.sha256, sha256(stable));
      assert.ok(evidence.readback.some((row: { url: string; sha256: string }) => row.url === entry.url && row.sha256 === entry.sha256));
    }
  }

  const original = status.rules!.find(row => row.id === 'china-ip')!.current!;
  const originalBytes = await snapshot.read('stable/china-ip/office-networks.srs');
  assert.ok(originalBytes);
  const copied = await snapshot.read('stable/ip-copy/branch-networks.srs');
  assert.deepEqual(copied, originalBytes);
  assert.equal((await pinRuleVersion({ ...request, id: 'china-ip', version: original.versionId! })).status, 'success');
  const resumed = await resumeRuleUpdates({ ...request, id: 'china-ip' });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].current?.versionId, original.versionId);

  config.ruleSets[1] = ip('china-ip', 'replacement-name');
  env.configure(config);
  const conflict = await syncRules(request);
  assert.equal(conflict.status, 'partial', JSON.stringify(conflict));
  const rejected = conflict.results.find(row => row.id === 'china-ip')!;
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error!, /Existing subscription contract cannot change/);
  assert.deepEqual(rejected.current, resumed.results[0].current);
  const stable = await env.context.repository.snapshot();
  assert.deepEqual(await stable.read('stable/china-ip/office-networks.srs'), originalBytes);
  assert.equal(await stable.read('stable/china-ip/replacement-name.srs'), undefined);
});

test('gfw 经 sync 交付并可核验，非法 Git 更新保留 gfw 且不阻断独立规则集', async () => {
  const env = rulesEnvironment(binary!, 'acceptance-gfw');
  const request = { context: env.context };
  const config = formalConfiguration();
  config.target.branch = env.context.targetBranch;
  config.ruleSets = config.ruleSets.filter(rule => ['openai', 'gfw'].includes(rule.id));
  env.configure(config);
  const releaseFetch = env.context.fetch!;
  let commit = 'a'.repeat(40), input = 'example.test\n';
  const repo = 'Loyalsoldier/v2ray-rules-dat';
  const branchUrl = `https://api.github.com/repos/${repo}/branches/release`;
  const inputUrl = () => `https://raw.githubusercontent.com/${repo}/${commit}/gfw.txt`;
  env.context.fetch = async (url, init) => {
    if (String(url) === branchUrl) return Response.json({ name: 'release', commit: { sha: commit } });
    if (String(url) === inputUrl()) return new Response(input);
    return releaseFetch(url, init);
  };

  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  assert.deepEqual(first.results.map(({ id, status }) => [id, status]), [['openai', 'delivered'], ['gfw', 'delivered']]);
  const current = first.results[1].current!;
  assert.deepEqual(current.source, { kind: 'github-commit', repository: repo, branch: 'release', commit,
    file: { path: 'gfw.txt', url: inputUrl() }, inputSha256: sha256(input), inputBytes: Buffer.byteLength(input) });

  const status = await getRulesStatus({ context: { ...env.context }, id: 'gfw' });
  assert.equal(status.status, 'success', JSON.stringify(status));
  const [visible] = status.rules!;
  assert.equal(visible.deliveryState, 'delivered');
  assert.equal(visible.candidateCount, 1);
  assert.deepEqual(visible.current, current);
  assert.deepEqual(visible.candidates.map(({ id, current, selectable, source }) => [id, current, selectable, source]),
    [[current.candidateId, true, true, current.source]]);

  const stablePrefix = 'https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/acceptance-gfw/stable/gfw/';
  const formats = {
    source: { url: stablePrefix + 'domains.json' },
    binary: { url: stablePrefix + 'domains.srs' },
  };
  assert.deepEqual(visible.stableUrls.sort(), Object.values(formats).map(x => x.url).sort());
  assert.deepEqual(current.subscription, {
    schemaVersion: 3, systemRuleSetId: 'gfw', targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats,
  });
  const prefix = `candidates/${current.candidateId}/`;
  const snapshot = await env.context.repository.snapshot();
  const manifest = JSON.parse((await snapshot.read(prefix + 'manifest.json'))!.toString());
  const build = JSON.parse((await snapshot.read(prefix + 'build.json'))!.toString());
  const evidence = JSON.parse((await env.context.repository.download(current.candidateEvidenceUrl)).toString());
  assert.equal(manifest.id, 'gfw');
  assert.equal(manifest.revision, current.candidateId);
  assert.equal(Object.hasOwn(manifest, 'projections'), false);
  assert.equal(build.buildId, evidence.buildId);
  assert.equal(build.buildId, first.results[1].successfulInput?.buildId);
  assert.equal(build.tool.version, '1.14.4');
  assert.equal(build.tools.conversionPolicy, 'domain-suffix-text-v1');
  assert.deepEqual(build.source, current.source);
  for (const format of ['source', 'binary'] as const) {
    const artifact = manifest.artifacts.find((a: { format: string }) => a.format === format)!;
    const stable = await env.context.repository.download(formats[format].url);
    assert.deepEqual(stable, await env.context.repository.download(artifact.url));
    assert.equal(artifact.sha256, sha256(stable));
    assert.equal(artifact.byteLength, stable.length);
  }

  commit = 'b'.repeat(40); input = '*.example.test\n';
  env.upstream({ openai: 'domain:updated.example' });
  const partial = await syncRules({ context: { ...env.context } });
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  const [openai, gfw] = partial.results;
  assert.equal(openai.status, 'delivered');
  assert.notEqual(openai.current?.versionId, first.results[0].current?.versionId);
  assert.equal(gfw.status, 'failed');
  assert.match(gfw.error!, /gfw\.txt.*line 1/);
  assert.deepEqual(gfw.current, current);
  assert.deepEqual(gfw.successfulInput, first.results[1].successfulInput);
  const after = await getRulesStatus({ ...request, id: 'gfw' });
  assert.deepEqual(after.rules?.[0].current, current);
  assert.equal(after.rules?.[0].candidateCount, 1);
  console.log(JSON.stringify({ gfwDelivery: { current, manifest, buildId: build.buildId, candidateReadback: evidence.readback },
    invalidUpdate: { gfw: gfw.status, retained: gfw.current?.versionId, healthyOpenAI: openai.status } }));
});

test('首次同步缺少单列表时该集未交付且无候选，其他三集独立成功', async () => {
  const env = fourSources(), request = { context: env.context }, fetcher = env.context.fetch!;
  const body = JSON.stringify({ lists: [
    { name: 'anthropic', length: 1, rules: ['domain:anthropic.example'] },
    { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.example'] },
  ] });
  env.context.fetch = async (url, init) => String(url).endsWith('/dlc.dat_plain.yml') ? new Response(body)
    : String(url).endsWith('/dlc.dat_plain.yml.sha256sum') ? new Response(`${sha256(body)}  dlc.dat_plain.yml\n`) : fetcher(url, init);
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
for (const mechanism of ['url', 'git-branch'] as const) {
  test(`配置新增任意仓库：${mechanism} 完成交付、证据复验及 pin`, async () => {
    const env = rulesEnvironment(binary!);
    const config = env.config();
    const repo = 'another-owner/another-repo', commit = 'b'.repeat(40);
    const address = `https://github.com/${repo}/releases/latest/download/rules.data`;
    const body = mechanism === 'url'
      ? JSON.stringify({ lists: [{ name: 'other', length: 1, rules: ['domain:example.org'] }] })
      : '192.0.2.0/24\n2001:db8::/32\n';
    config.ruleSets = [{ id: 'custom', source: 'custom', stablePath: 'stable/custom', artifact: 'rules',
      ...(mechanism === 'url' && { list: 'other' }) }];
    config.sources = { custom: mechanism === 'url'
      ? { version: 'url', input: { format: 'v2fly-dlc-yaml', url: address, sha256Url: address + '.sha256' } }
      : { repository: repo, version: mechanism, branch: 'data/rules', input: { format: 'cidr-text', path: 'lists/rules.data' } } };
    env.configure(config);
    const requests: string[] = [];
    env.context.fetch = async addressInput => {
      const url = String(addressInput);
      requests.push(url);
      assert.ok(url.includes(repo), url);
      if (url.endsWith('/branches/data%2Frules')) return Response.json({ name: 'data/rules', commit: { sha: commit } });
      if (url.endsWith(`/${commit}/lists/rules.data`) || url === address) return new Response(body);
      if (url === address + '.sha256') return new Response(sha256(body));
      throw new Error(`Unexpected request ${url}`);
    };
    const first = await syncRules({ context: env.context });
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.equal(first.results[0].current?.source.inputSha256, sha256(body));
    const status = await getRulesStatus({ context: env.context });
    assert.equal(status.rules?.[0].candidateCount, 1);
    const before = requests.length;
    const pinned = await pinRuleVersion({ context: env.context, id: 'custom', version: first.results[0].current!.versionId! });
    assert.equal(pinned.status, 'success', JSON.stringify(pinned));
    assert.equal(requests.length, before);
  });
}

const gitDomainDeliveries = [
  {
    id: 'onedrive', repository: 'blackmatrix7/ios_rule_script', path: 'rule/Clash/OneDrive/OneDrive.list',
    input: 'DOMAIN-SUFFIX,sharepoint.example\nDOMAIN-KEYWORD,onedrive\nPROCESS-NAME,OneDrive\n',
    policy: 'clash-rule-list-v1', terms: 2,
  },
  {
    id: 'stream', repository: 'SukkaLab/ruleset.skk.moe', path: 'sing-box/non_ip/stream.json',
    input: JSON.stringify({ version: 2, rules: [{ domain: ['exact.example'],
      domain_suffix: ['suffix.example'], domain_keyword: ['needle'] }] }),
    policy: 'sing-box-source-json-v2', terms: 1,
  },
];
for (const { id, repository, path, input, policy, terms } of gitDomainDeliveries) test(`${id} 经 sync 交付两种域名格式并保留转换报告及固定来源`, async () => {
  const env = rulesEnvironment(binary!, `acceptance-${id}`);
  const configuration = formalConfiguration();
  configuration.target.branch = env.context.targetBranch;
  configuration.ruleSets = configuration.ruleSets.filter(rule => rule.id === id);
  env.configure(configuration);

  const commit = 'c'.repeat(40);
  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
  const upstream = env.context.fetch!;
  env.context.fetch = async (address, init) => {
    if (String(address) === `https://api.github.com/repos/${repository}/branches/master`) {
      return Response.json({ name: 'master', commit: { sha: commit } });
    }
    return String(address) === url ? new Response(input) : upstream(address, init);
  };
  const request = { context: env.context };
  const result = await syncRules(request);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.deepEqual(result.results.map(({ id, status }) => [id, status]), [[id, 'delivered']]);
  const current = result.results[0].current!;
  assert.deepEqual(current.source, { kind: 'github-commit', repository, branch: 'master', commit,
    file: { path, url }, inputSha256: sha256(input), inputBytes: Buffer.byteLength(input) });

  const status = await getRulesStatus({ ...request, id });
  assert.equal(status.status, 'success', JSON.stringify(status));
  assert.equal(status.rules?.[0].deliveryState, 'delivered');
  assert.deepEqual(status.rules?.[0].current, current);
  const stablePrefix = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${env.context.targetBranch}/stable/${id}/`;
  const formats = {
    source: { url: stablePrefix + 'domains.json' },
    binary: { url: stablePrefix + 'domains.srs' },
  };
  assert.deepEqual(current.subscription, {
    schemaVersion: 3, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats,
  });

  const snapshot = await env.context.repository.snapshot();
  const prefix = `candidates/${current.candidateId}/`;
  const manifest = JSON.parse((await snapshot.read(prefix + 'manifest.json'))!.toString());
  const build = JSON.parse((await snapshot.read(prefix + 'build.json'))!.toString());
  const report = JSON.parse((await snapshot.read(prefix + 'conversion-report.json'))!.toString());
  assert.equal(manifest.id, id);
  assert.equal(manifest.revision, current.candidateId);
  assert.equal(Object.hasOwn(manifest, 'projections'), false);
  assert.equal(build.tools.conversionPolicy, policy);
  assert.equal(build.tool.version, '1.14.4');
  assert.equal(report.unsupportedCount, 0);
  assert.equal(report.inputCount, id === 'onedrive' ? 2 : 1);
  assert.equal(report.outputTermCount, terms);
  for (const format of ['source', 'binary'] as const) {
    const artifact = manifest.artifacts.find((entry: { format: string }) => entry.format === format);
    assert.ok(artifact);
    const stable = await env.context.repository.download(formats[format].url);
    assert.equal(sha256(stable), artifact.sha256);
    assert.deepEqual(stable, await env.context.repository.download(artifact.url));
  }
  console.log(JSON.stringify({ gitDomainDelivery: { id, current, manifest, buildId: build.buildId, terms } }));
});
