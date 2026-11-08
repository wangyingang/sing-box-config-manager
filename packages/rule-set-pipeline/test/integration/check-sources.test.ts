import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { activateRules, checkRules, readRemoteStatus, resumeRules } from '../../src/index.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { configuredSubscriptions, parseBuildConfiguration } from '../../src/configuration.js';
import { configuredEnvironment, upstream } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const id = 'china-ip';
const original = '192.0.2.0/25\n2001:db8:1::/48\n';
const changed = '192.0.2.128/25\n2001:db8:2::/48\n';
const sha = (revision: number) => String(revision).repeat(40);

async function fixture(t: TestContext, branch = 'acceptance-issue-71') {
  const directory = await mkdtemp(join(tmpdir(), 'check-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = await configuredEnvironment(binary!, directory, branch);
  const publication = { repository: env.repository, commit: env.publish, download: env.transport.download };
  const cidr = parseBuildConfiguration(await readFile(new URL('../../config/china-ip.yml', import.meta.url), 'utf8'));
  const domains = parseBuildConfiguration(env.configuration);
  const config = { ...domains, sources: { ...domains.sources, ...cidr.sources }, ruleSets: [...domains.ruleSets, ...cidr.ruleSets] };
  const subscriptions = configuredSubscriptions(config);
  const options = (name: string, source: ReturnType<typeof sources>) => ({ configuration: JSON.stringify(config), subscriptions,
    publication, fetch: source.fetcher, binary: binary!, stateDirectory: join(directory, name), activation: env.transport });
  const status = () => readRemoteStatus({ repository: env.repository, activation: env.transport, publication });
  return { ...env, options, optionsFor: env.options, status };
}

function sources(release: number, revision: number, bytes = original, rules: Record<string, string> = {}) {
  const v2fly = upstream(release, rules);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: sha(revision) } });
    if (path === `https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${sha(revision)}/china46.txt`) return new Response(bytes);
    return v2fly.fetcher(url, init);
  };
  return { fetcher, requests };
}

test('四集共享各自来源；CIDR 改变只更新 china-ip，新 commit 同内容不重复发布', async t => {
  const env = await fixture(t);
  const first = sources(1, 1);
  const initial = await checkRules(env.options('initial', first));
  assert.equal(initial.exitCode, 0, JSON.stringify(initial));
  assert.deepEqual(initial.results.map(result => result.status), ['activated', 'activated', 'activated', 'activated']);
  for (const suffix of ['/latest', '/assets/11', '/assets/12', '/branches/ip-lists', '/china46.txt']) {
    assert.equal(first.requests.filter(path => path.endsWith(suffix)).length, 1, suffix);
  }
  const next = await checkRules(env.options('next', sources(2, 2, changed)));
  assert.deepEqual(next.results.map(result => result.status), ['unchanged', 'unchanged', 'unchanged', 'activated']);
  assert.equal(next.results[3].current?.sourceCommit, sha(2));
  const third = sources(3, 3, '# comment\n' + changed);
  const unchanged = await checkRules({ ...env.options('unchanged', third), selectedIds: [id] });
  assert.equal(unchanged.exitCode, 0, JSON.stringify(unchanged));
  assert.deepEqual(unchanged.results.map(result => result.status), ['unchanged']);
  assert.equal(unchanged.results[0].sourceCommit, sha(3));
  assert.equal(unchanged.results[0].current?.sourceCommit, sha(2));
  assert.equal(unchanged.results[0].current?.id, next.results[3].current?.id);
  assert.equal(third.requests.length, 2);
  const status = await env.status();
  assert.equal(status.state.latestChecks?.[id].sourceCommit, sha(3));
  assert.equal(status.activeRuleVersions[id].activation.history.length, 1);
  assert.equal(Object.keys(status.state.candidates).length, 5);
  assert.equal(env.writes(), 5);
});

test('共同输入和单列表失败各自隔离，其他规则集仍能交付变化', async t => {
  const env = await fixture(t);
  const first = await checkRules(env.options('initial', sources(1, 1)));
  assert.equal(first.exitCode, 0, JSON.stringify(first));

  const badCidr = await checkRules(env.options('bad-cidr', sources(2, 2, 'invalid CIDR', { openai: 'domain:new.example' })));
  assert.equal(badCidr.exitCode, 1);
  assert.deepEqual(badCidr.results.map(result => result.status), ['activated', 'unchanged', 'unchanged', 'failed']);
  assert.equal(badCidr.results[3].sourceCommit, sha(2));
  assert.equal(badCidr.results[3].current?.id, first.results[3].current?.id);

  const v2fly = sources(3, 3, changed);
  const badRelease = await checkRules({ ...env.options('bad-release', v2fly), fetch: (url, init) =>
    String(url).endsWith('/assets/12') ? Promise.resolve(new Response('0'.repeat(64) + '  dlc.dat_plain.yml\n')) : v2fly.fetcher(url, init) });
  assert.equal(badRelease.exitCode, 1);
  assert.deepEqual(badRelease.results.map(result => result.status), ['failed', 'failed', 'failed', 'activated']);
  assert.equal(badRelease.results[0].releaseId, 3);
  assert.equal(badRelease.results[0].current?.id, badCidr.results[0].current?.id);
  assert.equal(badRelease.results[3].current?.sourceCommit, sha(3));

  const badList = await checkRules(env.options('bad-list', sources(4, 4, original, {
    openai: 'unsupported:bad.example', anthropic: 'domain:another.example',
  })));
  assert.equal(badList.exitCode, 1);
  assert.deepEqual(badList.results.map(result => result.status), ['failed', 'activated', 'unchanged', 'activated']);
  assert.equal(badList.results[0].current?.id, badCidr.results[0].current?.id);
  assert.equal(badList.results[3].current?.sourceCommit, sha(4));
});

test('候选提交回复丢失后，新目录续用已固定的两类来源', async t => {
  const env = await fixture(t);
  const originalSources = sources(1, 1);
  const first = env.options('interrupted', originalSources);
  const config = parseBuildConfiguration(first.configuration);
  config.sources['dlc-alias'] = config.sources.dlc;
  config.ruleSets.find(rule => rule.id === 'anthropic')!.source = 'dlc-alias';
  first.configuration = JSON.stringify(config);
  let offline = false;
  let candidate: string | undefined;
  const repository = { ...env.repository,
    async snapshot(target?: string) {
      if (offline) throw new Error('Connection lost');
      return env.repository.snapshot(target);
    },
    async commit(...args: Parameters<typeof env.repository.commit>) {
      const head = await env.repository.commit(...args);
      const file = Object.keys(args[1]).find(path => path.startsWith('candidates/') && path.endsWith('/domains.srs'));
      if (!candidate && file) {
        candidate = file.split('/')[1];
        offline = true;
        throw new PublicationWriteError(head, 'Candidate files response lost');
      }
      return head;
    },
  };
  const interrupted = await checkRules({ ...first, publication: { ...first.publication, repository } });
  assert.equal(interrupted.exitCode, 1, JSON.stringify(interrupted));
  assert.ok(candidate);
  assert.equal(env.writes(), 0);
  assert.ok(originalSources.requests.some(path => path.endsWith(`/${sha(1)}/china46.txt`)));

  originalSources.requests.length = 0;
  const latest = sources(2, 2, changed, { openai: 'domain:latest.example' });
  // Alias declaration order has no effect on the request or the fixed version.
  config.sources = Object.fromEntries(Object.entries(config.sources).reverse());
  const recovered = await checkRules({ ...env.options('fresh', latest), configuration: JSON.stringify(config), fetch: (url, init) =>
    /\/latest$|\/branches\/ip-lists$/.test(String(url)) ? latest.fetcher(url, init) : originalSources.fetcher(url, init) });
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.deepEqual(recovered.results.map(result => result.status), ['activated', 'activated', 'activated', 'activated']);
  assert.equal(recovered.results[0].candidateId, candidate);
  assert.equal(recovered.results[0].releaseId, 1);
  assert.equal(recovered.results[3].sourceCommit, sha(1));
  assert.ok(originalSources.requests.some(path => path.endsWith('/releases/1')));
  assert.ok(originalSources.requests.some(path => path.endsWith(`/${sha(1)}/china46.txt`)));
  assert.deepEqual(latest.requests, []);
  const status = await env.status();
  assert.equal(Object.keys(status.state.candidates).length, 4);
  assert.deepEqual(status.pendingOperations, []);
});

test('恢复 china-ip 验证失败时保留当前规则，且不会访问 V2Fly 或修改其人工固定', async t => {
  const env = await fixture(t);
  const first = env.options('first', sources(1, 1));
  const initial = await checkRules(first);
  assert.equal(initial.exitCode, 0, JSON.stringify(initial));
  const before = (await env.status()).activeRuleVersions;
  const sibling = await activateRules(env.optionsFor('openai', before.openai.activation.candidateEvidenceUrl));
  const pinned = await activateRules({ ...env.optionsFor(id, before[id].activation.candidateEvidenceUrl),
    configuration: first.configuration, subscription: first.subscriptions[id] });
  const broken = sources(2, 2, 'invalid CIDR');
  const result = await resumeRules({ ...env.options('resume', broken), logicalId: id });
  assert.equal(result.exitCode, 1);
  assert.equal(result.results.length, 1);
  const [entry] = result.results;
  assert.equal(entry.status, 'failed');
  assert.equal(entry.sourceCommit, sha(2));
  assert.equal(entry.current?.id, pinned.activation.id);
  assert.equal(entry.control?.reason, 'manual-resume');
  assert.equal(entry.control?.pauseAutomaticRetry, false);
  assert.ok(broken.requests.length > 0 && broken.requests.every(url => url.includes('gaoyifan/china-operator-ip')));

  const after = await env.status();
  assert.deepEqual(after.activeRuleVersions.openai.activation, sibling.activation);
  assert.equal(after.activeRuleVersions[id].control?.revision, entry.control?.revision);
  assert.deepEqual(after.pendingOperations, []);
  const later = await checkRules({ ...env.options('later', sources(3, 3, changed)), selectedIds: [id] });
  assert.equal(later.exitCode, 0, JSON.stringify(later));
  assert.equal(later.results[0].status, 'activated');
  assert.equal(later.results[0].current?.sourceCommit, sha(3));
  assert.equal(later.results[0].control?.revision, entry.control?.revision);
});

for (const branch of ['acceptance-issue-71', 'main']) {
  test(`${branch}：旧 CIDR 检查不能覆盖后来人工固定和恢复的决定`, async t => {
    const env = await fixture(t, branch);
    const first = env.options('initial', sources(1, 1));
    const initial = await checkRules({ ...first, selectedIds: [id] });
    assert.equal(initial.exitCode, 0, JSON.stringify(initial));
    const active = (await env.status()).activeRuleVersions[id].activation;
    const stale = sources(2, 2, changed);
    const result = await checkRules({ ...env.options('stale', stale), selectedIds: [id], fetch: async (url, init) => {
      if (String(url).endsWith('/china46.txt')) {
        await activateRules({ ...env.optionsFor(id, active.candidateEvidenceUrl),
          configuration: first.configuration, subscription: first.subscriptions[id] });
        const resumed = await resumeRules({ ...env.options('newer', sources(3, 3)), logicalId: id });
        assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
        assert.equal(resumed.results[0].status, 'unchanged');
      }
      return stale.fetcher(url, init);
    } });
    assert.equal(result.exitCode, 1);
    assert.match(result.error ?? '', /PUBLICATION_CONFLICT/);
    const status = await env.status();
    assert.equal(status.state.latestChecks?.[id].sourceCommit, sha(3));
    assert.equal(status.activeRuleVersions[id].activation.candidateId, active.candidateId);
    assert.equal(status.activeRuleVersions[id].control?.reason, 'manual-resume');
    assert.equal(Object.keys(status.state.candidates).length, 1);
    assert.equal(env.writes(), 2);
  });
}

test('CIDR 激活待核实期间暂停同批写入，换目录继续时不重复切换', async t => {
  const env = await fixture(t);
  const originalSources = sources(1, 1);
  const options = env.options('pending', originalSources);
  const config = parseBuildConfiguration(options.configuration);
  config.ruleSets.unshift(config.ruleSets.pop()!);
  options.configuration = JSON.stringify(config);
  env.fail('readback');
  const pending = await checkRules(options);
  assert.equal(pending.exitCode, 1);
  const [entry, ...siblings] = pending.results;
  assert.equal(entry.status, 'verification-pending');
  assert.equal(entry.sourceCommit, sha(1));
  assert.equal(entry.current?.sourceCommit, sha(1));
  assert.equal(entry.pendingOperation?.status, 'activated-readback-pending');
  assert.equal(entry.pendingOperation?.commit, entry.current?.commit);
  assert.ok(siblings.every(result => result.status === 'failed' && result.pendingOperation === undefined));

  originalSources.requests.length = 0;
  const offline = await checkRules({ ...options, stateDirectory: env.options('offline', originalSources).stateDirectory });
  assert.equal(offline.exitCode, 1);
  assert.equal(offline.results[0].pendingOperation?.id, entry.pendingOperation?.id);
  assert.equal(originalSources.requests.length, 0);
  assert.equal(env.writes(), 1);

  env.fail('');
  const recovered = await checkRules({ ...options, stateDirectory: env.options('fresh', originalSources).stateDirectory });
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.ok(recovered.results.every(result => result.status === 'activated'));
  assert.equal(recovered.results[0].current?.id, entry.current?.id);
  assert.equal(recovered.results[0].current?.commit, entry.current?.commit);
  assert.equal(recovered.results[0].sourceCommit, sha(1));
  assert.ok(originalSources.requests.every(url => url.includes('v2fly/domain-list-community') && !url.endsWith('/latest')));
  assert.equal(env.writes(), 4);
});

test('人工固定期间，新 commit 的内容与已检查候选相同则保留该候选', async t => {
  const env = await fixture(t);
  const options = env.options('initial', sources(1, 1));
  const initial = await checkRules({ ...options, selectedIds: [id] });
  assert.equal(initial.results[0].status, 'activated');
  const active = (await env.status()).activeRuleVersions[id].activation;
  const fixed = await activateRules({ ...env.optionsFor(id, active.candidateEvidenceUrl),
    configuration: options.configuration, subscription: options.subscriptions[id] });

  const first = await checkRules({ ...env.options('changed', sources(2, 2, changed)), selectedIds: [id] });
  assert.equal(first.results[0].status, 'paused');
  assert.ok(first.results[0].candidateId);
  const next = await checkRules({ ...env.options('same', sources(3, 3, '# comment\n' + changed)), selectedIds: [id] });
  assert.equal(next.exitCode, 0, JSON.stringify(next));
  assert.equal(next.results[0].status, 'paused');
  assert.equal(next.results[0].sourceCommit, sha(3));
  assert.equal(next.results[0].candidateId, first.results[0].candidateId);
  assert.equal(next.results[0].current?.id, fixed.activation.id);
  const status = await env.status();
  assert.equal(Object.keys(status.state.candidates).length, 2);
  assert.equal(env.writes(), 2);

  const resumed = await resumeRules({ ...env.options('resume', sources(4, 4, changed)), logicalId: id });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].status, 'activated');
  assert.equal(resumed.results[0].sourceCommit, sha(4));
  assert.equal(resumed.results[0].current?.sourceCommit, sha(2));
  assert.equal(resumed.results[0].current?.candidateId, first.results[0].candidateId);
  assert.equal(Object.keys((await env.status()).state.candidates).length, 2);
  assert.equal(env.writes(), 3);
});
