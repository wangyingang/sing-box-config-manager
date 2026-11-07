import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules, checkRules, readRemoteState, readRemoteStatus, rebuildRules, rollbackRules } from '../../src/index.js';
import { manageMaintenance } from '../../src/maintenance.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { STATE_PATH } from '../../src/remote-state.js';
import { sha256 } from '../../src/release.js';
import { configuredEnvironment } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;

function upstream(revision: number, rules: Record<string, string> = {}) {
  const requests: string[] = [];
  const tag = `2026110411283${revision}`;
  const input = JSON.stringify({ lists: ['openai', 'anthropic', 'google-deepmind', 'openai-alt'].map(name =>
    ({ name, length: 1, rules: [rules[name] ?? `domain:${name}.example`] })) });
  const fetcher: typeof fetch = async url => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith('/latest') || path.endsWith(`/releases/${revision}`)) return Response.json({ id: revision, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({ id: 11 + i, name,
        browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path.endsWith('/assets/11')) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected source: ${path}`);
  };
  return { fetcher, requests };
}

async function isolated(run: (environment: Awaited<ReturnType<typeof configuredEnvironment>>, directory: string) => Promise<void>, branch?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'check-now-'));
  try { await run(await configuredEnvironment(binary!, directory, branch), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function options(env: Awaited<ReturnType<typeof configuredEnvironment>>, stateDirectory: string, source: ReturnType<typeof upstream>) {
  return { binary: binary!, configuration: env.configuration, stateDirectory, fetch: source.fetcher,
    publication: { repository: env.repository, commit: env.publish, download: env.transport.download },
    activation: env.transport, subscriptions: Object.fromEntries(env.ids.map(id => [id, env.subscription(id)])) };
}

test('同一 Release 只为内容改变的 Anthropic 发布并激活', { skip: !binary }, async () => isolated(async (env, directory) => {
  const initial = await checkRules(options(env, join(directory, 'initial'), upstream(1)));
  assert.deepEqual(initial.results.map(result => result.status), ['activated', 'activated', 'activated']);
  const next = upstream(2, { anthropic: 'domain:changed.example' });
  const common = options(env, join(directory, 'next'), next);
  const result = await checkRules(common);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.results.map(result => [result.id, result.status]), [
    ['ai-openai', 'unchanged'], ['ai-anthropic', 'activated'], ['ai-google-deepmind', 'unchanged'],
  ]);
  for (const suffix of ['/latest', '/assets/11', '/assets/12']) {
    assert.equal(next.requests.filter(url => url.endsWith(suffix)).length, 1);
  }
  const status = await readRemoteStatus({ ...common, repository: env.repository });
  assert.equal(Object.keys(status.state.candidates).length, 4);
  assert.equal(status.state.latestChecks?.['ai-openai'].releaseId, 2);
  assert.equal(status.state.latestChecks?.['ai-google-deepmind'].releaseId, 2);
  assert.equal(status.activeRuleVersions['ai-openai'].activation.source.releaseId, 1);
  assert.equal(status.activeRuleVersions['ai-anthropic'].activation.source.releaseId, 2);
  assert.equal(status.activeRuleVersions['ai-anthropic'].activation.history.length, 1);
  assert.equal(status.activeRuleVersions['ai-google-deepmind'].activation.history.length, 0);
}));

test('单集失败仍交付兄弟集，下一次重试；共同来源校验失败不切换任何集', { skip: !binary }, async () => isolated(async (env, directory) => {
  const common = options(env, directory, upstream(1, { openai: 'unsupported:openai.example' }));
  const result = await checkRules(common);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results.map(entry => entry.status), ['failed', 'activated', 'activated']);
  const corrupt = upstream(2);
  const corruptResult = await checkRules({ ...common, fetch: async (url, init) =>
    String(url).endsWith('/assets/12') ? new Response('0'.repeat(64) + '  dlc.dat_plain.yml\n') : corrupt.fetcher(url, init) });
  assert.equal(corruptResult.exitCode, 1);
  assert.deepEqual(corruptResult.results.map(entry => entry.status), ['failed', 'failed', 'failed']);
  assert.equal(env.writes(), 2);
  const retried = await checkRules(options(env, directory, upstream(3)));
  assert.equal(retried.exitCode, 0);
  assert.deepEqual(retried.results.map(entry => entry.status), ['activated', 'unchanged', 'unchanged']);
  assert.equal(env.writes(), 3);
}));

test('人工回滚停止检查该集，人工指定仍可产生候选但不会激活', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = await checkRules(options(env, directory, upstream(1)));
  const openai = first.results[0];
  const firstStatus = await readRemoteStatus({ repository: env.repository, publication: options(env, directory, upstream(1)).publication,
    activation: env.transport });
  const openaiCommit = await env.repository.lastChange!(env.head(), 'stable/ai-openai/activation.json');
  await checkRules(options(env, directory, upstream(2, { openai: 'domain:new-openai.example' })));
  const rollback = await rollbackRules({ ...env.options(openai.id, ''), historicalActivationCommit: openaiCommit });
  const anthropic = firstStatus.activeRuleVersions['ai-anthropic'].activation;
  const pin = await activateRules(env.options('ai-anthropic', anthropic.candidateEvidenceUrl));
  const third = await checkRules(options(env, join(directory, 'fresh'), upstream(3, {
    openai: 'unsupported:openai.example', anthropic: 'domain:new-anthropic.example', 'google-deepmind': 'domain:new-deepmind.example',
  })));
  assert.equal(third.exitCode, 0);
  assert.deepEqual(third.results.map(entry => entry.status), ['paused', 'paused', 'activated']);
  assert.equal(third.results[0].releaseId, undefined);
  assert.equal(third.results[0].candidateId, undefined);
  assert.equal(third.results[0].current?.id, rollback.activation.id);
  assert.equal(third.results[1].releaseId, 3);
  assert.ok(third.results[1].candidateId);
  assert.equal(third.results[1].current?.id, pin.activation.id);
  assert.equal(third.results[0].control?.pauseAutomaticRetry, true);
  assert.equal(third.results[1].control?.pauseAutomaticRetry, false);
}));

test('来源列表变化重新判断同字节，订阅契约变化拒绝激活', { skip: !binary }, async () => isolated(async (env, directory) => {
  await checkRules(options(env, directory, upstream(1)));
  const common = options(env, directory, upstream(2, { 'openai-alt': 'domain:openai.example' }));
  const deepmind = env.subscription('ai-google-deepmind');
  Reflect.deleteProperty(deepmind.projections.route.formats, 'source');
  Reflect.deleteProperty(deepmind.projections['dns-query'].formats, 'source');
  const result = await checkRules({ ...common, configuration: common.configuration.replace('list: openai', 'list: openai-alt'),
    subscriptions: { ...common.subscriptions, 'ai-google-deepmind': deepmind } });
  assert.deepEqual(result.results.map(entry => entry.status), ['activated', 'unchanged', 'failed']);
  assert.match(result.results[2].error ?? '', /subscription contract/);
  assert.equal(result.exitCode, 1);
  assert.equal(env.writes(), 4);
}));

for (const branch of ['acceptance-issue-50', 'main']) {
  test(`${branch} 激活未提交时换机复用完整候选，候选发布语义保持独立`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const selectedIds = ['ai-openai'];
    const first = options(env, join(directory, 'first'), upstream(1));
    env.fail('rejected');
    const failed = await checkRules({ ...first, selectedIds });
    assert.equal(failed.results[0].status, 'failed');
    assert.equal(env.writes(), 0);
    assert.ok(failed.results[0].candidateId);
    env.fail('');
    const common = options(env, join(directory, 'second'), upstream(1));
    const resumed = await checkRules({ ...common, selectedIds });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.results[0].status, 'activated');
    assert.equal(resumed.results[0].candidateId, failed.results[0].candidateId);
    assert.equal(env.writes(), 1);
    const status = await readRemoteStatus({ ...common, repository: env.repository });
    assert.deepEqual(Object.keys(status.state.candidates), [resumed.results[0].candidateId]);
    assert.deepEqual(status.automaticOperations.map(operation => operation.status), ['not-committed', 'committed']);
    const rebuilt = await rebuildRules({ ...common, stateDirectory: join(directory, 'rebuild'), release: '20261104112831', selectedIds });
    assert.equal(rebuilt.results[0].status, 'processed');
    assert.equal(env.writes(), 1, 'Explicit rebuild must not activate');
  }, branch));

  test(`${branch} 激活提交后断线，换机确认已交付并保留同一条激活记录`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const selectedIds = ['ai-openai'];
    const first = options(env, join(directory, 'first'), upstream(1));
    env.fail('unknown');
    const resolved = await checkRules({ ...first, selectedIds });
    assert.equal(resolved.exitCode, 0);
    assert.equal(resolved.results[0].status, 'activated');
    assert.equal(resolved.results[0].current?.candidateId, resolved.results[0].candidateId);
    assert.equal(resolved.results[0].current?.commit, env.head());
    env.fail('');
    const common = options(env, join(directory, 'second'), upstream(2));
    const recovered = await checkRules({ ...common, selectedIds, fetch: async () => { throw new Error('Must recover the known commit before reading upstream'); } });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.results[0].status, 'activated');
    assert.equal(recovered.results[0].candidateId, resolved.results[0].candidateId);
    assert.equal(env.writes(), 1);
  }, branch));

  test(`${branch} 自动检查启动后人工固定，旧检查不能把新 head 当作父提交`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const existing = await env.candidates();
    const source = upstream(1);
    const common = options(env, directory, source);
    let manualActivation: string | undefined;
    const result = await checkRules({ ...common, fetch: async (url, init) => {
      if (String(url).endsWith('/assets/11')) {
        const manual = await activateRules(env.options('ai-openai', existing['ai-openai'].evidenceUrl!));
        manualActivation = manual.activation.id;
      }
      return source.fetcher(url, init);
    } });
    assert.equal(result.exitCode, 1);
    assert.ok(manualActivation);
    assert.equal(result.results[0].current?.id, manualActivation);
    assert.equal(result.results[0].control?.pauseAutomaticActivation, true);
    assert.equal(env.writes(), 1);
    const status = await readRemoteStatus({ ...common, repository: env.repository });
    assert.equal(Object.keys(status.state.candidates).length, 0);
  }, branch));
}

test('构建期间进入维护并更换代次，旧检查拒绝候选提交', { skip: !binary }, async () => isolated(async (env, directory) => {
  const source = upstream(1);
  const common = options(env, directory, source);
  const result = await checkRules({ ...common, fetch: async (url, init) => {
    if (String(url).endsWith('/assets/11')) {
      const snapshot = await env.repository.snapshot();
      const journal = JSON.parse((await snapshot.read(STATE_PATH))!.toString());
      journal.maintenance = 'maintenance';
      journal.generation++;
      journal.state.pendingOperation.generation++;
      await env.repository.commit(snapshot.head, { [STATE_PATH]: Buffer.from(JSON.stringify(journal)) }, 'Enter maintenance');
    }
    return source.fetcher(url, init);
  } });
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /PUBLICATION_CONFLICT/);
  assert.equal(env.writes(), 0);
  const status = await readRemoteStatus({ ...common, repository: env.repository });
  assert.equal(status.maintenance, 'maintenance');
  assert.equal(Object.keys(status.state.candidates).length, 0);
}));

test('完整候选的证据已提交但进程断线，换机复验候选并补做激活', { skip: !binary }, async () => isolated(async (env, directory) => {
  const selectedIds = ['ai-openai'];
  const first = options(env, join(directory, 'first'), upstream(1));
  let offline = false;
  const repository = { ...env.repository, async snapshot(branch?: string) {
    if (offline) throw new Error('Connection unavailable');
    return env.repository.snapshot(branch);
  }, async commit(expectedHead: string, files: Record<string, Buffer>, message: string) {
    const commit = await env.repository.commit(expectedHead, files, message);
    if (Object.keys(files).some(path => path.endsWith('/readback.json'))) {
      offline = true;
      throw new PublicationWriteError(commit, 'Evidence response lost');
    }
    return commit;
  } };
  const interrupted = await checkRules({ ...first, selectedIds, publication: { ...first.publication, repository } });
  assert.equal(interrupted.exitCode, 1);
  assert.equal(interrupted.results[0].status, 'verification-pending');
  assert.equal(env.writes(), 0);
  offline = false;
  const status = await readRemoteStatus({ ...first, repository: env.repository });
  const [candidateId] = Object.keys(status.state.candidates);
  const common = options(env, join(directory, 'fresh'), upstream(2));
  const recovered = await checkRules({ ...common, selectedIds, fetch: async () => { throw new Error('Recovered evidence is sufficient'); } });
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.results[0].candidateId, candidateId);
  assert.equal(recovered.results[0].releaseId, 1);
  assert.equal(recovered.results[0].status, 'activated');
  assert.equal(env.writes(), 1);
  const after = await readRemoteStatus({ ...common, repository: env.repository });
  assert.deepEqual(Object.keys(after.state.candidates), [candidateId]);
}));

test('一个当前记录损坏，未激活的兄弟集仍可首次交付', { skip: !binary }, async () => isolated(async (env, directory) => {
  await env.repository.commit(env.head(), { 'stable/ai-openai/activation.json': Buffer.from('{') }, 'Corrupt one activation');
  const result = await checkRules(options(env, directory, upstream(1)));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results.map(entry => entry.status), ['failed', 'activated', 'activated']);
  assert.equal(result.results[0].current, undefined);
  assert.deepEqual(result.results[1].rollbackTargets, []);
  assert.equal(env.writes(), 2);
}));

test('已提交但 HTTPS 回读失败时报告当前版本和已知提交，换机后只补核实', { skip: !binary }, async () => isolated(async (env, directory) => {
  const selectedIds = ['ai-openai'];
  const first = options(env, join(directory, 'first'), upstream(1));
  let blockReadback = false;
  const activation = { ...env.transport, async commit(...args: Parameters<typeof env.transport.commit>) {
    const commit = await env.transport.commit(...args);
    blockReadback = true;
    return commit;
  }, async download(url: string) {
    if (blockReadback && url.endsWith('/stable/ai-openai/domains.srs')) throw new Error('HTTPS unavailable');
    return env.transport.download(url);
  } };
  const pending = await checkRules({ ...first, selectedIds, activation });
  assert.equal(pending.exitCode, 1);
  assert.equal(pending.results[0].status, 'verification-pending');
  assert.equal(pending.results[0].current?.candidateId, pending.results[0].candidateId);
  assert.ok(pending.results[0].current?.commit);
  assert.equal(pending.results[0].pendingOperation?.commit, pending.results[0].current?.commit);
  blockReadback = false;
  const common = options(env, join(directory, 'second'), upstream(2));
  const recovered = await checkRules({ ...common, selectedIds, fetch: async () => { throw new Error('Only readback should be retried'); } });
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.results[0].status, 'activated');
  assert.equal(recovered.results[0].current?.commit, pending.results[0].current?.commit);
  assert.equal(env.writes(), 1);
}, 'main'));

test('稳定切换登记后发生人工固定，旧自动切换在提交前被拒绝', { skip: !binary }, async () => isolated(async (env, directory) => {
  const existing = await env.candidates();
  let manualId: string | undefined;
  let injected = false;
  env.beforeSwitch(async () => {
    if (injected) return;
    injected = true;
    const manual = await activateRules(env.options('ai-openai', existing['ai-openai'].evidenceUrl!));
    manualId = manual.activation.id;
  });
  const first = options(env, join(directory, 'first'), upstream(1));
  const result = await checkRules({ ...first, selectedIds: ['ai-openai'] });
  assert.equal(result.exitCode, 1);
  assert.ok(manualId);
  assert.equal(result.results[0].current?.id, manualId);
  assert.equal(result.results[0].control?.pauseAutomaticActivation, true);
  assert.equal(env.writes(), 1);
}, 'main'));


test('维护重新确定所有当前版本和 pin，从远端恢复并安全退出，旧任务仍然过期', { skip: !binary }, async () => isolated(async (env, directory) => {
  const common = options(env, directory, upstream(1));
  const initial = await checkRules(common);
  assert.equal(initial.exitCode, 0);
  const maintenance = { ...common, repository: env.repository, refs: async () => [
    { ref: 'refs/heads/acceptance-other-task', head: 'e'.repeat(40) },
  ] };
  const preview = await manageMaintenance({ ...maintenance, action: 'preview', manual: true });
  assert.equal(preview.status, 'ready');
  const candidates = await env.candidates();
  const pinned = await activateRules(env.options('ai-openai', candidates['ai-openai'].evidenceUrl!));
  const oldHead = env.head();
  const staleSource = upstream(2);
  const oldCheck = await checkRules({ ...common, stateDirectory: join(directory, 'old'), fetch: async (url, init) => {
    if (String(url).endsWith('/latest')) {
      const entered = await manageMaintenance({ ...maintenance, action: 'enter', manual: true });
      assert.equal(entered.status, 'isolated');
      assert.equal(entered.run?.phase, 'ready');
      assert.equal(entered.run?.oldHeads.stable, oldHead);
      assert.equal(entered.generation, preview.generation + 1);
      assert.equal(entered.run.plan.retain.active.length, 3);
      const openai = entered.run.plan.retain.active.find(active => active.recordPath === 'stable/ai-openai/activation.json')!;
      assert.equal(openai.record.id, pinned.activation.id);
      assert.deepEqual(openai.record.control, pinned.activation.control);
      assert.equal(openai.candidatePaths.length, 7);
      assert.ok(!entered.run.plan.discard.candidateIds.includes(pinned.activation.candidateId));
      assert.ok(entered.run.plan.discard.candidateIds.includes(candidates['ai-anthropic'].id));
      assert.equal(entered.run.plan.otherRefs[0].ref, 'refs/heads/acceptance-other-task');
      for (const active of entered.run.plan.retain.active) {
        for (const file of Object.keys(active.record.files)) {
          assert.deepEqual(await (await env.repository.snapshot(env.transport.branch)).read(file), env.snapshots.get(oldHead)![file]);
        }
      }
      await assert.rejects(activateRules(env.options('ai-openai', candidates['ai-openai'].evidenceUrl!)), /REPOSITORY_MAINTENANCE/);
      const resumed = await manageMaintenance({ ...maintenance, action: 'resume' });
      assert.deepEqual(resumed.run, entered.run);
      const wrong = await manageMaintenance({ ...maintenance, action: 'abort', maintenanceId: 'another-run' });
      assert.equal(wrong.status, 'deferred');
      const ended = await manageMaintenance({ ...maintenance, action: 'abort', maintenanceId: entered.run.id });
      assert.equal(ended.status, 'aborted');
      assert.equal(ended.generation, entered.generation);
    }
    return staleSource.fetcher(url, init);
  } });
  assert.equal(oldCheck.exitCode, 1);
  assert.match(oldCheck.error ?? '', /PUBLICATION_CONFLICT/);
  assert.equal(env.writes(), 4);
  const next = await checkRules(options(env, join(directory, 'fresh'), upstream(2)));
  assert.equal(next.exitCode, 0);
  assert.equal(next.results[0].current?.id, pinned.activation.id);
}));

test('候选各提交阶段都使维护延期，远端登记在任务中断后仍然有效', { skip: !binary }, async () => isolated(async (env, directory) => {
  const common = options(env, directory, upstream(1));
  const observed = new Set<string>();
  let offline = false;
  const maintenance = { ...common, repository: env.repository, refs: async () => [] };
  const repository = { ...env.repository, async snapshot(branch?: string) {
    if (offline) throw new Error('Writer lost its connection');
    return env.repository.snapshot(branch);
  }, async commit(head: string, files: Record<string, Buffer>, message: string) {
    const phasePath = Object.keys(files).find(path => path.startsWith('candidates/'));
    if (phasePath) {
      const preview = await manageMaintenance({ ...maintenance, action: 'enter', manual: true });
      assert.equal(preview.status, 'deferred');
      assert.equal(preview.maintenance, 'open');
      assert.equal((await env.repository.snapshot()).head, head);
      observed.add(phasePath.split('/').at(-1)!);
      if (phasePath.endsWith('/readback.json')) {
        offline = true;
        throw new Error('Writer interrupted before evidence');
      }
    }
    return env.repository.commit(head, files, message);
  } };
  const result = await checkRules({ ...common, selectedIds: ['ai-openai'], publication: { ...common.publication, repository } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual([...observed], ['domains.json', 'manifest.json', 'readback.json']);
  const deferred = await manageMaintenance({ ...maintenance, action: 'enter', manual: true });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.maintenance, 'open');
}));

test('隔离已提交后断线，新调用续做保留集合。稳定 head 改变后保持隔离', { skip: !binary }, async () => isolated(async (env, directory) => {
  const common = options(env, directory, upstream(1));
  assert.equal((await checkRules(common)).exitCode, 0);
  const maintenance = { ...common, repository: env.repository, refs: async () => [] };
  let offline = false;
  const repository = { ...env.repository, async snapshot(branch?: string) {
    if (offline) throw new Error('Connection unavailable');
    return env.repository.snapshot(branch);
  }, async commit(head: string, files: Record<string, Buffer>, message: string) {
    const commit = await env.repository.commit(head, files, message);
    offline = true;
    throw new PublicationWriteError(commit, 'lost maintenance reply');
  } };
  await assert.rejects(manageMaintenance({ ...maintenance, repository, action: 'enter', manual: true }), /Connection unavailable/);
  const isolated = await readRemoteState(env.repository);
  assert.equal(isolated.journal.maintenanceRun?.phase, 'isolated');
  const result = await manageMaintenance({ ...maintenance, action: 'resume' });
  assert.equal(result.status, 'isolated');
  assert.equal(result.run?.phase, 'ready');
  assert.equal(result.run.id, isolated.journal.maintenanceRun.id);
  const head = env.head();
  await env.transport.commit(head, { 'stable/untracked/domains.srs': Buffer.from('external writer') }, 'External writer');
  const abort = await manageMaintenance({ ...maintenance, action: 'abort', maintenanceId: result.run.id });
  assert.equal(abort.status, 'deferred');
  assert.equal((await readRemoteState(env.repository)).journal.maintenance, 'maintenance');
}));
