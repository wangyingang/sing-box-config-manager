import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { activateRules, readRemoteStatus, rebuildRules, rollbackRules, updateRules } from '../../src/index.js';
import { manageMaintenance } from '../../src/maintenance.js';
import { branchRef } from '../../src/maintenance-refs.js';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';
import { configuredEnvironment, upstream } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const china = 'china-ip';
const gitCommit = (version: number) => String(version).repeat(40);

async function fixture(t: TestContext, branch: string) {
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = await configuredEnvironment(binary, directory, branch);
  const cidr = (await readFile(new URL('../../config/china-ip.yml', import.meta.url), 'utf8'))
    .replace('branch: main', `branch: ${branch}`);
  const url = (path: string) => `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/${path}`;
  const formats = { binary: { url: url('stable/china-ip/route.srs'), requiredCapabilities: [] },
    source: { url: url('stable/china-ip/route.json'), requiredCapabilities: [] } };
  const subscription = { schemaVersion: 2, systemRuleSetId: china, targetVersion: '1.14.4', sourceFormatVersion: 4,
    projections: { route: { formats }, 'dns-query': { unavailable: 'empty' }, 'dns-response': { formats } } };
  const blocked = new Set<string>();
  const download = (address: string) => {
    const ref = new URL(address).pathname.split('/')[3];
    assert.ok(!blocked.has(ref), `Old artifact address used: ${address}`);
    return env.transport.download(address);
  };
  const repository = { ...env.repository, async lastChange(at: string, path: string) {
    assert.ok(!blocked.has(at), `Old Git history used: ${at}`);
    const commit = await env.repository.lastChange!(at, path);
    assert.ok(!blocked.has(commit), `Old Git history used: ${commit}`);
    return commit;
  } };
  const publication = { repository, commit: env.publish, download };
  const activation = { ...env.transport, repository, download };
  const source = (id: string, version: number): typeof fetch => {
    if (id !== china) return upstream(version, { [id]: `domain:${id}-${version}.example` }).fetcher;
    return async address => {
      if (String(address).endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: gitCommit(version) } });
      if (String(address) === `https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${gitCommit(version)}/china46.txt`) {
        return new Response(`192.0.2.${version}/32\n2001:db8:${version}::/48\n`);
      }
      assert.fail(`Unexpected upstream request: ${address}`);
    };
  };
  const update = (id: string, version: number, label = `${id}-${version}`) => ({
    binary, configuration: id === china ? cidr : env.configuration, stateDirectory: join(directory, label),
    publication, selectedIds: [id], fetch: source(id, version),
  });
  const write = (id: string) => ({ ...env.options(id, ''), transport: activation,
    ...(id === china && { configuration: cidr, subscription }) });
  const publish = async (id: string, version: number) => {
    const [result] = (await updateRules(update(id, version))).results;
    if (result.status !== 'processed') assert.fail(JSON.stringify(result));
    return result.candidate;
  };
  const activate = (id: string, candidateEvidenceUrl: string) => activateRules({ ...write(id), candidateEvidenceUrl });
  const deliver = async (id: string, version: number) => activate(id, (await publish(id, version)).evidenceUrl!);
  const status = () => readRemoteStatus({ binary, repository, publication, activation });
  const maintenance = { binary, repository, publication, activation, baseline: env.baseline, refTransport: env.refs };
  return { ...env, update, write, publish, activate, deliver, status, maintenance, blocked, download, url };
}

for (const branch of ['acceptance-issue-72', 'main']) {
  test(`${branch} 四集跨两轮清理保持稳定字节和长期 pin，旧历史不可用、新历史可回滚`, { timeout: 120_000 }, async t => {
    const env = await fixture(t, branch);
    const old = await env.deliver(china, 1);
    const pinned = await env.deliver(china, 2);
    await env.deliver('openai', 3);
    await env.deliver('anthropic', 4);
    await env.deliver('google-deepmind', 5);
    const before = await env.status();
    const active = before.activeRuleVersions;
    const bytes = async () => Object.fromEntries(await Promise.all(Object.values(active)
      .flatMap(({ activation }) => Object.keys(activation.files))
      .map(async path => [path, await env.download(env.url(path))])));
    const original = await bytes();
    const run = (action: 'preview' | 'enter' | 'prepare' | 'switch' | 'resume', options = env.maintenance) =>
      manageMaintenance({ ...options, action, manual: true });
    const expectStatus = async (result: ReturnType<typeof run>, expected: string, error?: RegExp) => {
      const response = await result;
      assert.equal(response.status, expected, JSON.stringify(response));
      if (error) assert.ok('error' in response && typeof response.error === 'string' && error.test(response.error), JSON.stringify(response));
      return response;
    };
    const preview = await expectStatus(run('preview'), 'ready');
    assert.ok('plan' in preview && preview.plan);
    const entries = preview.plan.retain.active;
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map(({ record }) => record.source.commit).filter(commit => commit === gitCommit(2)), [gitCommit(2)]);
    assert.deepEqual(entries.flatMap(({ record }) => record.source.releaseId ?? []).sort(), [3, 4, 5]);
    const cidr = entries.find(({ record }) => record.logicalId === china)!;
    assert.deepEqual(cidr.record.source, pinned.activation.source);
    assert.deepEqual(cidr.control, pinned.activation.control);
    assert.equal(cidr.sourceKey, before.state.candidates[pinned.activation.candidateId].sourceKey);
    assert.deepEqual(cidr.candidatePaths.map(path => path.split('/').at(-1)).sort(),
      ['build.json', 'conversion-report.json', 'manifest.json', 'readback.json', 'route.json', 'route.srs', 'source.json']);
    assert.ok(preview.plan.discard.candidateIds.includes(old.activation.candidateId));

    const heads = async () => ({ journal: (await env.maintenance.repository.snapshot()).head, stable: env.head() });
    const obsolete = () => [...env.snapshots.keys()];
    const firstHistory = obsolete();
    const beforeEnter = await heads();
    await expectStatus(run('enter'), 'isolated');
    const isolated = await heads();
    assert.notEqual(isolated.journal, beforeEnter.journal);
    await assert.rejects(updateRules(env.update(china, 3, 'blocked-update')), /REPOSITORY_MAINTENANCE/);
    await assert.rejects(env.activate(china, pinned.activation.candidateEvidenceUrl), /REPOSITORY_MAINTENANCE/);
    assert.deepEqual(await heads(), isolated);

    // The files, metadata and evidence refs already exist when preparation is interrupted.
    await expectStatus(run('prepare', { ...env.maintenance, baseline: { ...env.baseline, async stage(...args) {
      if (args[0].endsWith('-journal')) throw new Error('Journal stage interrupted');
      return env.baseline.stage(...args);
    } } }), 'failed', /Journal stage interrupted/);
    assert.deepEqual(await heads(), isolated);
    assert.deepEqual(await bytes(), original);
    const prepared = await expectStatus(run('prepare'), 'prepared');
    assert.equal(prepared.run?.phase, 'prepared');
    const { journal, stable } = prepared.run.baseline.stages;
    const beforeSwitch = await heads();

    let fail = 'switch';
    const faults = { ...env.maintenance, refTransport: { ...env.refs, async update(changes: Parameters<typeof env.refs.update>[0]) {
      const switching = changes.some(change => change.ref === branchRef(branch));
      if (switching && fail === 'switch') throw new Error('Atomic push rejected');
      if (!switching && fail === 'cleanup') throw new Error('Cleanup interrupted');
      await env.refs.update(changes);
      if (switching && fail === 'readback') throw new Error('Switch reply lost');
    } }, publication: { ...env.maintenance.publication, async download(address: string) {
      if (fail === 'readback' && address === env.url('stable/china-ip/route.srs')) throw new Error('Stable readback interrupted');
      return env.download(address);
    } } };
    await expectStatus(run('switch', faults), 'failed', /Atomic push rejected/);
    assert.deepEqual(await heads(), beforeSwitch);
    fail = 'readback';
    await expectStatus(run('switch', faults), 'failed', /Stable readback interrupted/);
    assert.deepEqual(await heads(), { journal: journal.head, stable: stable.head });
    assert.deepEqual(await bytes(), original);
    assert.deepEqual((await env.status()).activeRuleVersions[china].control, pinned.activation.control);
    fail = 'cleanup';
    await expectStatus(run('resume', faults), 'failed', /Cleanup interrupted/);
    assert.equal((await env.status()).maintenance, 'maintenance');
    await expectStatus(run('resume'), 'completed');
    assert.equal(env.refs.switches(), 1);
    await assert.rejects(rollbackRules({ ...env.write(china), historicalActivationCommit: old.commit }), /ROLLBACK_UNAVAILABLE/);
    firstHistory.forEach(commit => env.blocked.add(commit));

    // A candidate rebuilt from the retained fixed commit supplies discardable
    // history for the second cleanup, without changing any current version.
    const rebuild = await rebuildRules({ ...env.update(china, 2, 'fresh-rebuild'), commit: gitCommit(2),
      fetch: async (url, init) => {
        assert.equal(String(url), pinned.activation.source.file.url);
        return env.update(china, 2).fetch(url, init);
      } });
    assert.equal(rebuild.results[0].status, 'processed');
    const secondHistory = obsolete();
    await expectStatus(run('enter'), 'isolated');
    await expectStatus(run('prepare'), 'prepared');
    await expectStatus(run('switch'), 'completed');
    secondHistory.forEach(commit => env.blocked.add(commit));

    const after = await env.status();
    assert.equal(after.generation, before.generation + 2);
    assert.deepEqual(after.pendingOperations, []);
    assert.deepEqual(after.state.commitPins, before.state.commitPins);
    assert.equal(env.refs.switches(), 2);
    assert.ok(!(await env.refs.list()).some(({ ref }) => ref.startsWith('refs/heads/maintenance-')));
    assert.deepEqual(await bytes(), original);
    assert.deepEqual(Object.keys(after.state.candidates).sort(), Object.values(active).map(({ activation }) => activation.candidateId).sort());
    for (const [id, version] of Object.entries(active)) {
      const current = after.activeRuleVersions[id];
      assert.equal(current.activation.id, version.activation.id);
      assert.deepEqual(current.activation.source, version.activation.source);
      assert.deepEqual(current.activation.subscription, version.activation.subscription);
      assert.deepEqual(current.activation.files, version.activation.files);
      assert.deepEqual(current.control, version.control);
      assert.equal(current.candidate.verification, 'native');
      assert.deepEqual(after.rollbackTargets[id], []);
    }
    const fresh = env.update(china, 1, 'fresh-after-two-cleanups');
    await assert.rejects(rebuildRules({ ...fresh, commit: gitCommit(1), fetch: async url => assert.fail(`Unexpected upstream read: ${url}`) }),
      /CANDIDATE_UNAVAILABLE/);
    await assert.rejects(rollbackRules({ ...env.write(china), historicalActivationCommit: old.commit }), /ROLLBACK_UNAVAILABLE/);
    await env.activate(china, (await env.publish(china, 3)).evidenceUrl!);
    const [retained] = (await env.status()).rollbackTargets[china];
    assert.equal(retained.id, pinned.activation.id);
    const restored = await rollbackRules({ ...env.write(china), historicalActivationCommit: retained.commit });
    assert.deepEqual(restored.activation.files, pinned.activation.files);
    assert.equal(restored.activation.control?.reason, 'manual-rollback');
    assert.deepEqual(await bytes(), original);
  });
}

test('china-ip 稳定入口写入待核实时延期清理，保持当前交付', { timeout: 30_000 }, async t => {
  const env = await fixture(t, 'acceptance-issue-72-pending');
  const active = await env.deliver(china, 1);
  const next = await env.publish(china, 2);
  env.fail('not-applied');
  await assert.rejects(env.activate(china, next.evidenceUrl!), /ACTIVATION_UNKNOWN/);
  const status = await env.status();
  assert.ok(status.pendingOperations.length > 0);
  const deferred = await manageMaintenance({ ...env.maintenance, action: 'enter', manual: true });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.maintenance, 'open');
  assert.ok('blockers' in deferred && deferred.blockers.some(blocker => blocker.candidateId === next.id));
  const after = await env.status();
  assert.equal(after.head, status.head);
  assert.equal(after.activeRuleVersions[china].activation.id, active.activation.id);
  assert.deepEqual(after.activeRuleVersions[china].control, active.activation.control);
});
