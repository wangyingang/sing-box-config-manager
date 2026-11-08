import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules, checkRules, readRemoteState, readRemoteStatus, readUpdateState, rebuildRules, resumeRules, rollbackRules, updateRules } from '../../src/index.js';
import { manageMaintenance } from '../../src/maintenance.js';
import type { BaselineTransport } from '../../src/maintenance-baseline-transport.js';

import { PublicationWriteError } from '../../src/publication-repository.js';
import { STATE_PATH, type RemoteJournal } from '../../src/remote-state.js';
import { sha256 } from '../../src/release.js';
import { configuredEnvironment, upstream } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;

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
    ['openai', 'unchanged'], ['anthropic', 'activated'], ['google-deepmind', 'unchanged'],
  ]);
  for (const suffix of ['/latest', '/assets/11', '/assets/12']) {
    assert.equal(next.requests.filter(url => url.endsWith(suffix)).length, 1);
  }
  const status = await readRemoteStatus({ ...common, repository: env.repository });
  assert.equal(Object.keys(status.state.candidates).length, 4);
  assert.equal(status.state.latestChecks?.['openai'].releaseId, 2);
  assert.equal(status.state.latestChecks?.['google-deepmind'].releaseId, 2);
  assert.equal(status.activeRuleVersions['openai'].activation.source.releaseId, 1);
  assert.equal(status.activeRuleVersions['anthropic'].activation.source.releaseId, 2);
  assert.equal(status.activeRuleVersions['anthropic'].activation.history.length, 1);
  assert.equal(status.activeRuleVersions['google-deepmind'].activation.history.length, 0);
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
  const openaiCommit = await env.repository.lastChange!(env.head(), 'stable/openai/activation.json');
  await checkRules(options(env, directory, upstream(2, { openai: 'domain:new-openai.example' })));
  const rollback = await rollbackRules({ ...env.options(openai.id, ''), historicalActivationCommit: openaiCommit });
  const anthropic = firstStatus.activeRuleVersions['anthropic'].activation;
  const pin = await activateRules(env.options('anthropic', anthropic.candidateEvidenceUrl));
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
  const deepmind = env.subscription('google-deepmind');
  Reflect.deleteProperty(deepmind.projections.route.formats, 'source');
  Reflect.deleteProperty(deepmind.projections['dns-query'].formats, 'source');
  const result = await checkRules({ ...common, configuration: common.configuration.replace('list: openai', 'list: openai-alt'),
    subscriptions: { ...common.subscriptions, 'google-deepmind': deepmind } });
  assert.deepEqual(result.results.map(entry => entry.status), ['activated', 'unchanged', 'failed']);
  assert.match(result.results[2].error ?? '', /subscription contract/);
  assert.equal(result.exitCode, 1);
  assert.equal(env.writes(), 4);
}));

for (const branch of ['acceptance-issue-50', 'main']) {
  test(`${branch} 激活未提交时换机复用完整候选，候选发布语义保持独立`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const selectedIds = ['openai'];
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
    const selectedIds = ['openai'];
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
        const manual = await activateRules(env.options('openai', existing['openai'].evidenceUrl!));
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
  const selectedIds = ['openai'];
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
  await env.repository.commit(env.head(), { 'stable/openai/activation.json': Buffer.from('{') }, 'Corrupt one activation');
  const result = await checkRules(options(env, directory, upstream(1)));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results.map(entry => entry.status), ['failed', 'activated', 'activated']);
  assert.equal(result.results[0].current, undefined);
  assert.deepEqual(result.results[1].rollbackTargets, []);
  assert.equal(env.writes(), 2);
}));

test('已提交但 HTTPS 回读失败时报告当前版本和已知提交，换机后只补核实', { skip: !binary }, async () => isolated(async (env, directory) => {
  const selectedIds = ['openai'];
  const first = options(env, join(directory, 'first'), upstream(1));
  let blockReadback = false;
  const activation = { ...env.transport, async commit(...args: Parameters<typeof env.transport.commit>) {
    const commit = await env.transport.commit(...args);
    blockReadback = true;
    return commit;
  }, async download(url: string) {
    if (blockReadback && url.endsWith('/stable/openai/domains.srs')) throw new Error('HTTPS unavailable');
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
    const manual = await activateRules(env.options('openai', existing['openai'].evidenceUrl!));
    manualId = manual.activation.id;
  });
  const first = options(env, join(directory, 'first'), upstream(1));
  const result = await checkRules({ ...first, selectedIds: ['openai'] });
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
  const pinned = await activateRules(env.options('openai', candidates['openai'].evidenceUrl!));
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
      const openai = entered.run.plan.retain.active.find(active => active.recordPath === 'stable/openai/activation.json')!;
      assert.equal(openai.record.id, pinned.activation.id);
      assert.deepEqual(openai.record.control, pinned.activation.control);
      assert.equal(openai.candidatePaths.length, 7);
      assert.ok(!entered.run.plan.discard.candidateIds.includes(pinned.activation.candidateId));
      assert.ok(entered.run.plan.discard.candidateIds.includes(candidates['anthropic'].id));
      assert.equal(entered.run.plan.otherRefs[0].ref, 'refs/heads/acceptance-other-task');
      for (const active of entered.run.plan.retain.active) {
        for (const file of Object.keys(active.record.files)) {
          assert.deepEqual(await (await env.repository.snapshot(env.transport.branch)).read(file), env.snapshots.get(oldHead)![file]);
        }
      }
      await assert.rejects(activateRules(env.options('openai', candidates['openai'].evidenceUrl!)), /REPOSITORY_MAINTENANCE/);
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
  const result = await checkRules({ ...common, selectedIds: ['openai'], publication: { ...common.publication, repository } });
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

test('恢复只解除选中集的限制，并允许重新采用刚回滚掉的最新版本', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = await checkRules(options(env, directory, upstream(1)));
  const openaiCommit = await env.repository.lastChange!(env.head(), 'stable/openai/activation.json');
  const latest = upstream(3, { openai: 'domain:new-openai.example' });
  const second = await checkRules(options(env, directory, latest));
  const pin = await rollbackRules({ ...env.options('openai', ''), historicalActivationCommit: openaiCommit });
  const before = await readRemoteStatus({ repository: env.repository, publication: options(env, directory, latest).publication, activation: env.transport });
  const sibling = await activateRules(env.options('anthropic', before.activeRuleVersions['anthropic'].activation.candidateEvidenceUrl));

  latest.requests.length = 0;
  const result = await resumeRules({ ...options(env, join(directory, 'fresh'), latest), logicalId: 'openai' });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'openai');
  assert.equal(result.results[0].status, 'activated');
  assert.equal(result.results[0].current?.candidateId, second.results[0].candidateId);
  assert.notEqual(result.results[0].current?.candidateId, first.results[0].candidateId);
  assert.notEqual(result.results[0].control?.revision, pin.activation.control?.revision);
  assert.equal(result.results[0].control?.pauseAutomaticRetry, false);
  assert.equal(result.results[0].control?.pauseAutomaticActivation, false);
  assert.equal(latest.requests.filter(url => url.endsWith('/latest')).length, 1);
  assert.ok(latest.requests.every(url => !url.endsWith('/releases/2')));
  const after = await readRemoteStatus({ repository: env.repository, publication: options(env, directory, latest).publication, activation: env.transport });
  assert.deepEqual(after.activeRuleVersions['anthropic'].activation, sibling.activation);
  assert.deepEqual(after.activeRuleVersions['google-deepmind'].activation, before.activeRuleVersions['google-deepmind'].activation);
}));

for (const branch of ['acceptance-issue-51', 'main']) {
  test(`${branch} 恢复决定提交后断线，换机检查失败仍保持恢复并能再次更新`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const candidates = await env.candidates();
    const pinned = await activateRules(env.options('openai', candidates['openai'].evidenceUrl!));
    const sibling = await activateRules(env.options('anthropic', candidates['anthropic'].evidenceUrl!));
    const latest = upstream(3);
    const first = options(env, join(directory, 'first'), latest);
    let offline = false;
    const repository = { ...env.repository,
      async snapshot(target?: string) {
        if (offline) throw new Error('Connection lost');
        return env.repository.snapshot(target);
      },
      async commit(...args: Parameters<typeof env.repository.commit>) {
        const head = await env.repository.commit(...args);
        offline = true;
        throw new PublicationWriteError(head, 'Resume response lost');
      },
    };
    const interrupted = await resumeRules({ ...first, logicalId: 'openai', publication: { ...first.publication, repository } });
    assert.equal(interrupted.exitCode, 1);
    assert.equal(interrupted.results[0].status, 'verification-pending');
    assert.deepEqual(latest.requests, []);
    assert.equal(env.writes(), 2);

    const statusOptions = { repository: env.repository, publication: first.publication, activation: env.transport };
    const status = () => readRemoteStatus(statusOptions);
    const maintenance = () => manageMaintenance({ ...statusOptions, action: 'preview', manual: true, refs: async () => [] });
    const saved = await status();
    const control = saved.activeRuleVersions['openai'].control;
    assert.equal(control?.reason, 'manual-resume');
    assert.notEqual(control?.revision, pinned.activation.control?.revision);
    assert.deepEqual(saved.activeRuleVersions['openai'].activation, pinned.activation);
    assert.ok(saved.pendingOperations.some(entry => entry.id === control?.revision && entry.status === 'resume-check-pending'));
    const deferred = await maintenance();
    assert.equal(deferred.status, 'deferred');
    assert.ok('blockers' in deferred && deferred.blockers.some(entry => entry.id === control?.revision && entry.status === 'resume-check-pending'));

    const fresh = options(env, join(directory, 'second'), upstream(3, { openai: 'unsupported:invalid.example' }));
    const failed = await checkRules({ ...fresh, selectedIds: ['openai'] });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.results[0].current?.id, pinned.activation.id);
    assert.deepEqual(failed.results[0].control, control);
    assert.equal(env.writes(), 2);
    assert.ok(!(await status()).pendingOperations.some(entry => entry.status === 'resume-check-pending'));
    const preview = await maintenance();
    assert.equal(preview.status, 'ready');
    assert.ok('plan' in preview);
    const retained = preview.plan.retain.active.find(entry => entry.record.logicalId === 'openai');
    assert.deepEqual(retained?.control, control);
    assert.equal(preview.plan.retain.progress.resumes['openai'].revision, control?.revision);

    const retried = await checkRules({ ...options(env, join(directory, 'third'), upstream(4)), selectedIds: ['openai'] });
    assert.equal(retried.exitCode, 0);
    assert.equal(retried.results[0].status, 'activated');
    assert.equal(retried.results[0].releaseId, 4);
    assert.deepEqual(retried.results[0].control, control);
    assert.deepEqual((await status()).activeRuleVersions['anthropic'].control, sibling.activation.control);
    assert.equal(env.writes(), 3);
  }, branch));

  test(`${branch} 自动检查登记后人工固定并恢复，最早任务仍不能发布或激活`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const initial = options(env, directory, upstream(1));
    await checkRules({ ...initial, selectedIds: ['openai'] });
    const before = await readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
    const candidate = before.activeRuleVersions['openai'].activation.candidateEvidenceUrl;
    const source = upstream(2, { openai: 'domain:old-task.example' });
    const first = options(env, join(directory, 'old'), source);
    const old = await checkRules({ ...first, selectedIds: ['openai'], fetch: async (url, init) => {
      if (String(url).endsWith('/assets/11')) {
        const pinned = await activateRules(env.options('openai', candidate));
        const resumed = await resumeRules({ ...options(env, join(directory, 'new'), upstream(3)), logicalId: 'openai' });
        assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
        assert.equal(resumed.results[0].status, 'unchanged');
        assert.notEqual(resumed.results[0].control?.revision, pinned.activation.control?.revision);
      }
      return source.fetcher(url, init);
    } });
    assert.equal(old.exitCode, 1);
    assert.match(old.error ?? '', /PUBLICATION_CONFLICT/);
    assert.equal(old.results[0].control?.pauseAutomaticActivation, false);
    const after = await readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
    assert.equal(Object.keys(after.state.candidates).length, 1);
    assert.equal(after.state.latestChecks?.['openai'].releaseId, 3);
    assert.equal(env.writes(), 2);
  }, branch));
}

test('维护期间拒绝保存恢复决定或访问上游', { skip: !binary }, async () => isolated(async (env, directory) => {
  const candidates = await env.candidates();
  const pin = await activateRules(env.options('openai', candidates['openai'].evidenceUrl!));
  const snapshot = await env.repository.snapshot();
  const journal = JSON.parse((await snapshot.read(STATE_PATH))!.toString());
  journal.maintenance = 'maintenance';
  const head = await env.repository.commit(snapshot.head, { [STATE_PATH]: Buffer.from(JSON.stringify(journal)) }, 'Enter maintenance');
  const source = upstream(1);
  const common = options(env, directory, source);
  await assert.rejects(resumeRules({ ...common, logicalId: 'openai' }), /REPOSITORY_MAINTENANCE/);
  assert.deepEqual(source.requests, []);
  assert.equal(env.head(), head);
  const status = await readRemoteStatus({ ...common, repository: env.repository });
  assert.deepEqual(status.activeRuleVersions['openai'].control, pin.activation.control);
}));

test('恢复 OpenAI 立即检查最新来源，Anthropic 保留原批次和已发布的候选文件', { skip: !binary }, async () => isolated(async (env, directory) => {
  const initial = options(env, directory, upstream(1));
  await checkRules(initial);
  const status = () => readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
  const original = await status();
  await activateRules(env.options('openai', original.activeRuleVersions['openai'].activation.candidateEvidenceUrl));
  const earlier = options(env, join(directory, 'earlier'), upstream(2, { anthropic: 'domain:earlier.example' }));
  let earlierCandidate: string | undefined;
  const repository = { ...env.repository, async commit(...args: Parameters<typeof env.repository.commit>) {
    const head = await env.repository.commit(...args);
    const ruleFile = Object.keys(args[1]).find(path => path.startsWith('candidates/') && path.endsWith('/domains.srs'));
    if (!earlierCandidate && ruleFile) {
      earlierCandidate = ruleFile.split('/')[1];
      const resumed = await resumeRules({ ...options(env, join(directory, 'resume'), upstream(3, { openai: 'domain:latest.example' })), logicalId: 'openai' });
      assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
      assert.equal(resumed.results[0].releaseId, 3);
      assert.equal(resumed.results[0].status, 'activated');
    }
    return head;
  } };
  const old = await checkRules({ ...earlier, selectedIds: ['anthropic'], publication: { ...earlier.publication, repository } });
  assert.equal(old.exitCode, 1);
  assert.ok(earlierCandidate);
  const after = await status();
  assert.equal(after.state.pendingOperation?.releaseId, 2);
  assert.equal(after.state.candidates[earlierCandidate].phase, 'files');
  assert.equal(after.activeRuleVersions['anthropic'].activation.id, original.activeRuleVersions['anthropic'].activation.id);
  const pinnedSource = upstream(2, { anthropic: 'domain:earlier.example' });
  const recovery = await checkRules({ ...options(env, join(directory, 'recover'), pinnedSource), selectedIds: ['anthropic'] });
  assert.equal(recovery.exitCode, 0, JSON.stringify(recovery));
  assert.equal(recovery.results[0].candidateId, earlierCandidate);
  assert.equal(recovery.results[0].releaseId, 2);
  assert.ok(pinnedSource.requests.every(url => !url.endsWith('/latest')));
}, 'main'));

test('单集恢复已固定来源后中断，正常批次用同一个 Release 继续三个规则集', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = options(env, directory, upstream(1));
  await checkRules(first);
  const initial = await readRemoteStatus({ repository: env.repository, publication: first.publication, activation: env.transport });
  await activateRules(env.options('openai', initial.activeRuleVersions['openai'].activation.candidateEvidenceUrl));
  const source = upstream(2, { openai: 'domain:openai-next.example', anthropic: 'domain:anthropic-next.example' });
  const common = options(env, join(directory, 'first'), source);
  let offline = false;
  const repository = { ...env.repository,
    async snapshot(target?: string) {
      if (offline) throw new Error('Connection lost');
      return env.repository.snapshot(target);
    },
    async commit(...args: Parameters<typeof env.repository.commit>) {
      const head = await env.repository.commit(...args);
      const state = JSON.parse(args[1][STATE_PATH].toString()).state;
      if (state.pendingOperation?.status === 'pending' && state.pendingOperation.releaseId === 2) {
        offline = true;
        throw new PublicationWriteError(head, 'Pinned Release response lost');
      }
      return head;
    },
  };
  const interrupted = await resumeRules({ ...common, logicalId: 'openai', publication: { ...common.publication, repository } });
  assert.equal(interrupted.exitCode, 1);
  assert.deepEqual(interrupted.results.map(result => result.status), ['verification-pending']);

  source.requests.length = 0;
  const continued = await checkRules(options(env, join(directory, 'fresh'), source));
  assert.equal(continued.exitCode, 0, JSON.stringify(continued));
  assert.deepEqual(continued.results.map(result => [result.id, result.status, result.releaseId]), [
    ['openai', 'activated', 2], ['anthropic', 'activated', 2], ['google-deepmind', 'unchanged', 2],
  ]);
  assert.ok(source.requests.some(url => url.endsWith('/releases/2')));
  assert.ok(source.requests.every(url => !url.endsWith('/latest')));
}));

function loseCheckpoint(env: Awaited<ReturnType<typeof configuredEnvironment>>, lose: (journal: RemoteJournal) => boolean) {
  let offline = false;
  return { ...env.repository,
    async snapshot(target?: string) {
      if (offline) throw new Error('Connection lost');
      return env.repository.snapshot(target);
    },
    async commit(...args: Parameters<typeof env.repository.commit>) {
      const head = await env.repository.commit(...args);
      if (lose(JSON.parse(args[1][STATE_PATH].toString()))) {
        offline = true;
        throw new PublicationWriteError(head, 'Checkpoint response lost');
      }
      return head;
    },
  };
}

test('恢复登记后断线，普通批次不会抢先更新仍有旧检查的兄弟集', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = options(env, directory, upstream(1));
  await checkRules(first);
  const status = () => readRemoteStatus({ repository: env.repository, publication: first.publication, activation: env.transport });
  const original = await status();
  await activateRules(env.options('openai', original.activeRuleVersions['openai'].activation.candidateEvidenceUrl));
  const earlier = upstream(2, { anthropic: 'domain:earlier.example' });
  const latest = upstream(3, { openai: 'domain:latest.example', anthropic: 'domain:also-latest.example' });
  const prior = options(env, join(directory, 'prior'), earlier);
  const interruptedPrior = await checkRules({ ...prior, selectedIds: ['anthropic'], publication: {
    ...prior.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } });
  assert.equal(interruptedPrior.exitCode, 1);
  const current = options(env, join(directory, 'resume'), latest);
  const interruptedResume = await resumeRules({ ...current, logicalId: 'openai', publication: {
    ...current.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 3),
  } });
  assert.equal(interruptedResume.exitCode, 1);
  await assert.rejects(checkRules(options(env, join(directory, 'batch'), latest)), /RECOVERY_REQUEST_MISMATCH/);
  assert.equal((await status()).activeRuleVersions['anthropic'].activation.source.releaseId, 1);

  const resumed = await resumeRules({ ...current, stateDirectory: join(directory, 'resume-retry'), logicalId: 'openai' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 3);
  const continued = await checkRules({ ...prior, stateDirectory: join(directory, 'prior-retry'), selectedIds: ['anthropic'] });
  assert.equal(continued.exitCode, 0, JSON.stringify(continued));
  assert.equal(continued.results[0].releaseId, 2);
  assert.equal((await status()).activeRuleVersions['anthropic'].activation.source.releaseId, 2);
}, 'main'));

test('恢复决定写入后断线，候选更新用原命令继续已暂存的 Release', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = options(env, directory, upstream(1));
  await checkRules(first);
  const status = () => readRemoteStatus({ repository: env.repository, publication: first.publication, activation: env.transport });
  const before = await status();
  await activateRules(env.options('openai', before.activeRuleVersions['openai'].activation.candidateEvidenceUrl));
  const source = upstream(2, { anthropic: 'domain:earlier.example' });
  const prior = options(env, join(directory, 'prior'), source);
  await assert.rejects(updateRules({ ...prior, selectedIds: ['anthropic'], publication: {
    ...prior.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } }), /PUBLICATION_PENDING/);
  const latest = options(env, join(directory, 'resume'), upstream(3));
  const interrupted = await resumeRules({ ...latest, logicalId: 'openai', publication: {
    ...latest.publication, repository: loseCheckpoint(env, journal => journal.resumes?.['openai']?.checkPending === true),
  } });
  assert.equal(interrupted.exitCode, 1);
  const saved = await status();
  assert.ok(saved.pendingOperations.some(entry => entry.status === 'parked'));
  source.requests.length = 0;
  const continued = await updateRules({ ...prior, stateDirectory: join(directory, 'fresh'), selectedIds: ['anthropic'] });
  assert.equal(continued.releaseId, 2);
  assert.equal(continued.results[0].status, 'processed');
  assert.ok(source.requests.some(url => url.endsWith('/releases/2')));
  assert.ok(source.requests.every(url => !url.endsWith('/latest')));
  assert.equal((await status()).activeRuleVersions['anthropic'].activation.id, before.activeRuleVersions['anthropic'].activation.id);
  const resumed = await resumeRules({ ...latest, stateDirectory: join(directory, 'resume-retry'), logicalId: 'openai' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 3);
  assert.deepEqual(resumed.results[0].control, saved.activeRuleVersions['openai'].control);
}));

test('普通批次不会把已恢复到新 Release 的兄弟集纳入较旧的恢复检查', { skip: !binary }, async () => isolated(async (env, directory) => {
  const initial = options(env, directory, upstream(1));
  await checkRules(initial);
  const status = () => readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
  const before = await status();
  for (const id of ['openai', 'anthropic']) {
    await activateRules(env.options(id, before.activeRuleVersions[id].activation.candidateEvidenceUrl));
  }
  const earlier = options(env, join(directory, 'earlier'), upstream(2, {
    openai: 'domain:openai-earlier.example', anthropic: 'domain:anthropic-earlier.example',
  }));
  const interrupted = await resumeRules({ ...earlier, logicalId: 'openai', publication: {
    ...earlier.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } });
  assert.equal(interrupted.exitCode, 1);
  const latest = options(env, join(directory, 'latest'), upstream(3, { anthropic: 'domain:anthropic-latest.example' }));
  const sibling = await resumeRules({ ...latest, logicalId: 'anthropic' });
  assert.equal(sibling.exitCode, 0, JSON.stringify(sibling));
  assert.equal(sibling.results[0].status, 'activated');

  await assert.rejects(checkRules({ ...earlier, stateDirectory: join(directory, 'batch') }), /RECOVERY_REQUEST_MISMATCH/);
  const resumed = await resumeRules({ ...earlier, stateDirectory: join(directory, 'fresh'), logicalId: 'openai' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 2);
  const after = await status();
  assert.equal(after.activeRuleVersions['anthropic'].activation.source.releaseId, 3);
  assert.equal(after.activeRuleVersions['anthropic'].activation.id, sibling.results[0].current?.id);
}));

test('使用不同构建配置重新请求中断的恢复时，旧请求不能重放', { skip: !binary }, async () => isolated(async (env, directory) => {
  const initial = options(env, directory, upstream(1));
  await checkRules(initial);
  const status = () => readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
  const before = await status();
  await activateRules(env.options('openai', before.activeRuleVersions['openai'].activation.candidateEvidenceUrl));
  const earlier = options(env, join(directory, 'earlier'), upstream(2, { openai: 'domain:earlier.example' }));
  const interrupted = await resumeRules({ ...earlier, logicalId: 'openai', publication: {
    ...earlier.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } });
  assert.equal(interrupted.exitCode, 1);
  const registered = await status();

  const next = options(env, join(directory, 'next'), upstream(3, { 'openai-alt': 'domain:new-definition.example' }));
  const resumed = await resumeRules({ ...next, logicalId: 'openai', configuration: next.configuration.replace('list: openai', 'list: openai-alt') });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 3);
  assert.notEqual(resumed.results[0].control?.revision, registered.activeRuleVersions['openai'].control?.revision);
  const after = await status();
  assert.ok(!after.pendingOperations.some(entry => entry.id === registered.state.pendingOperation?.id));

  const later = upstream(4);
  const fresh = await checkRules({ ...options(env, join(directory, 'old-command'), later), selectedIds: ['openai'] });
  assert.equal(fresh.exitCode, 0, JSON.stringify(fresh));
  assert.equal(fresh.results[0].releaseId, 4);
  assert.ok(later.requests[0].endsWith('/latest'));
}, 'main'));

for (const branch of ['acceptance-issue-53', 'main']) {
  test(`${branch} 新基线回读中断后可恢复，屏蔽旧地址后仍核验各集当前版本、pin 和处理进度`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const first = options(env, join(directory, 'initial'), upstream(1));
    assert.equal((await checkRules(first)).exitCode, 0);
    const openai = 'openai', anthropic = 'anthropic';
    const before = await readRemoteStatus({ ...first, repository: env.repository });
    const pin = await activateRules(env.options(openai, before.activeRuleVersions[openai].activation.candidateEvidenceUrl));
    if (branch !== 'main') {
      const legacy = upstream(4);
      const input = JSON.stringify({ lists: [{ name: 'category-ai-!cn', length: 1, rules: ['domain:legacy.example'] }] });
      const built = await updateRules({ binary: binary!, stateDirectory: join(directory, 'legacy'), publication: first.publication,
        fetch: async (url, init) => String(url).endsWith('/assets/11') ? new Response(input)
          : String(url).endsWith('/assets/12') ? new Response(`${sha256(input)}  dlc.dat_plain.yml\n`) : legacy.fetcher(url, init),
      });
      if (built.status !== 'processed' || !('candidate' in built)) throw new Error('Expected a legacy candidate');
      const formats = {
        source: { url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/domains.json`, requiredCapabilities: [] },
        binary: { url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/domains.srs`, requiredCapabilities: [] },
      };
      await activateRules({ binary: binary!, stateDirectory: directory, expectedHead: env.head(), transport: env.transport,
        candidateEvidenceUrl: built.candidate.evidenceUrl!, subscription: {
          schemaVersion: 1, systemRuleSetId: 'v2fly:domain-list-community:category-ai-!cn', targetVersion: '1.14.4',
          sourceFormatVersion: 4, projections: { route: { formats }, 'dns-query': { formats }, 'dns-response': { unavailable: 'empty' } },
        },
      });
    }
    const next = options(env, join(directory, 'second'), upstream(2, { anthropic: 'domain:new-anthropic.example' }));
    next.configuration = next.configuration.replace('list: openai', 'list: openai-alt');
    assert.notEqual(next.configuration, env.configuration);
    assert.equal((await checkRules(next)).exitCode, 0);
    const live = await readRemoteStatus({ ...next, repository: env.repository });

    const stages = new Map<string, { head: string; parent?: string; files: Record<string, Buffer> }>();
    const baseline: BaselineTransport = {
      async stage(ref, parent, files) {
        if (!stages.has(ref)) {
          const previous = [...stages.values()].find(stage => stage.head === parent);
          assert.equal(previous?.head, parent);
          stages.set(ref, { head: (100 + stages.size).toString(16).padStart(40, 'b'), parent,
            files: { ...previous?.files, ...files } });
        }
        return stages.get(ref)!.head;
      },
      async snapshot(ref) {
        const stage = stages.get(ref);
        if (!stage) return undefined;
        const { head, parent, files } = stage;
        return { head, parents: parent ? [parent] : [], paths: Object.keys(files), async read(path) { return files[path]; } };
      },
    };
    let failReadback = true, blockOld = false;
    const download = async (url: string) => {
      const [, , , , , ref, ...parts] = url.split('/');
      const path = parts.join('/');
      const stage = [...stages.values()].find(value => value.head === ref);
      if (!stage) {
        if (blockOld) throw new Error('Old artifact address blocked');
        return env.transport.download(url);
      }
      if (failReadback && path.startsWith('stable/')) throw new Error('New HTTPS address temporarily unavailable');
      if (!stage.files[path]) throw new Error(`Readback HTTP 404: ${url}`);
      return stage.files[path];
    };
    const maintenance = { ...next, repository: env.repository, baseline,
      activation: { download }, publication: { ...next.publication, download }, refs: async () => [] };
    const entered = await manageMaintenance({ ...maintenance, action: 'enter', manual: true });
    assert.equal(entered.status, 'isolated', JSON.stringify(entered));
    const pausedHead = env.head(), writes = env.writes();
    const missingTool = await manageMaintenance({ ...maintenance, binary: undefined, action: 'prepare' });
    assert.equal(missingTool.status, 'deferred');
    assert.equal(stages.size, 0);
    const alternateBinary = join(directory, 'sing-box-wrapper');
    const wrapper = `#!/bin/sh\nexec '${binary!.replaceAll("'", "'\\''")}' "$@"\n`;
    await writeFile(alternateBinary, wrapper, { mode: 0o700 });
    const interrupted = await manageMaintenance({ ...maintenance, binary: alternateBinary, action: 'prepare' });
    assert.equal(interrupted.status, 'failed');
    assert.equal(env.head(), pausedHead);
    failReadback = false;
    const prepared = await manageMaintenance({ ...maintenance, action: 'prepare' });
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    assert.equal(prepared.run?.phase, 'prepared');
    if (prepared.run?.phase !== 'prepared') throw new Error('Expected a verified baseline');
    assert.equal(prepared.run.id, entered.run?.id);
    assert.equal(env.writes(), writes);
    assert.equal((await readRemoteStatus({ ...next, repository: env.repository })).activeRuleVersions[openai].activation.id, pin.activation.id);

    const liveHead = env.head();
    blockOld = true;
    assert.equal((await manageMaintenance({ ...maintenance, action: 'resume' })).status, 'prepared');
    assert.equal(env.head(), liveHead);
    const { stable, journal, evidence } = prepared.run.baseline.stages;
    assert.equal(stable.head === journal.head, branch !== 'main');
    const newRepository = { ...env.repository, snapshot: async (target = env.repository.branch) =>
      (await baseline.snapshot(target === env.repository.branch ? journal.ref : stable.ref))! };
    const after = await readRemoteStatus({ ...maintenance, repository: newRepository });
    assert.deepEqual(after.pendingOperations, []);
    assert.deepEqual(after.state.latestChecks, live.state.latestChecks);
    assert.deepEqual(after.state.pinned, live.state.pinned);
    assert.deepEqual(after.activeRuleVersions[openai].control, live.activeRuleVersions[openai].control);
    assert.equal(after.activeRuleVersions[openai].activation.id, pin.activation.id);
    assert.equal(after.activeRuleVersions[anthropic].activation.source.releaseId, 2);
    for (const id of env.ids) {
      const original = live.activeRuleVersions[id].activation;
      const active = after.activeRuleVersions[id].activation;
      assert.deepEqual(active.source, original.source);
      assert.deepEqual(active.validation, original.validation);
      assert.deepEqual(active.subscription, original.subscription);
      assert.deepEqual(active.files, original.files);
      assert.deepEqual(after.rollbackTargets[id], []);
    }
    if (branch !== 'main') {
      assert.equal(after.activeRuleVersion?.activation.id, live.activeRuleVersion?.activation.id);
      assert.deepEqual(after.activeRuleVersion?.activation.files, live.activeRuleVersion?.activation.files);
      assert.deepEqual(after.rollbackTargets['v2fly:category-ai-!cn'], []);
    }
    assert.equal(Object.keys(after.state.candidates).length, branch === 'main' ? 3 : 4);
    const pinnedBuildPath = `candidates/${pin.activation.candidateId}/build.json`;
    const oldBuild = await (await env.repository.snapshot()).read(pinnedBuildPath);
    assert.deepEqual(await (await newRepository.snapshot()).read(pinnedBuildPath), oldBuild);
    const proof = JSON.parse((await (await baseline.snapshot(evidence.ref))!.read(
      `candidates/${pin.activation.candidateId}/readback.json`))!.toString());
    assert.equal(proof.tool.sha256, JSON.parse(oldBuild!.toString()).tool.sha256);
    assert.equal(proof.revalidationTool.sha256, sha256(wrapper));
    assert.notEqual(proof.revalidationTool.sha256, proof.tool.sha256);
    assert.equal(after.state.configuredProcessed?.[anthropic]['1'].evidenceUrl, undefined);
    assert.equal(after.state.configuredProcessed?.[anthropic]['1'].candidateId, live.state.configuredProcessed?.[anthropic]['1'].candidateId);
  }, branch));
}

for (const branch of ['acceptance-issue-54', 'main']) {
  test(`${branch} 切换后稳定 URL 回读中断，远端恢复完成清理且不重复切换`, { timeout: 120_000, skip: !binary }, async () => isolated(async (env, directory) => {
    const first = options(env, directory, upstream(1));
    const initial = await checkRules(first);
    assert.equal(initial.exitCode, 0, JSON.stringify(initial));
    const latest = options(env, directory, upstream(2, { anthropic: 'domain:updated.example' }));
    assert.equal((await checkRules(latest)).exitCode, 0);
    const before = await readRemoteStatus({ ...latest, repository: env.repository });
    let failReadback = true, failReply = true, rejectSwitch = true, failCleanup = true, loseCheckpoint = true;
    let offline = false;
    const repository = { ...env.repository, async snapshot(branch?: string) {
      if (offline) throw new Error('Checkpoint read unavailable');
      return env.repository.snapshot(branch);
    }, async commit(...args: Parameters<typeof env.repository.commit>) {
      const head = await env.repository.commit(...args);
      const state: RemoteJournal = JSON.parse(args[1][STATE_PATH].toString());
      if (loseCheckpoint && state.maintenanceCleanup) {
        loseCheckpoint = false;
        offline = true;
        throw new PublicationWriteError(head, 'Verification checkpoint reply lost');
      }
      return head;
    } };
    const download = async (url: string) => {
      if (failReadback && url.includes(`/${env.transport.branch}/stable/`)) throw new Error('Stable readback interrupted');
      return env.transport.download(url);
    };
    const maintenance = { ...latest, repository, baseline: env.baseline,
      publication: { ...latest.publication, download }, refs: env.refs.list,
      refTransport: { ...env.refs, async update(changes: Parameters<typeof env.refs.update>[0]) {
        const switching = changes.some(change => change.ref === `refs/heads/${env.transport.branch}`);
        if (switching && rejectSwitch) throw new Error('Atomic push unsupported');
        if (!switching && failCleanup) throw new Error('Temporary ref cleanup interrupted');
        await env.refs.update(changes);
        if (switching && failReply) { failReply = false; throw new Error('Switch reply lost'); }
      } } };
    assert.equal((await manageMaintenance({ ...maintenance, action: 'enter', manual: true })).status, 'isolated');
    assert.equal((await manageMaintenance({ ...maintenance, action: 'prepare' })).status, 'prepared');
    const oldHead = env.head();
    const rejected = await manageMaintenance({ ...maintenance, action: 'switch' });
    assert.equal(rejected.status, 'failed');
    assert.match(JSON.stringify(rejected), /Atomic push unsupported/);
    assert.equal(env.head(), oldHead);
    rejectSwitch = false;
    const switched = await manageMaintenance({ ...maintenance, action: 'switch' });
    assert.equal(switched.status, 'failed');
    assert.equal(switched.maintenance, 'maintenance');
    assert.notEqual(env.head(), before.stableHead);
    assert.ok((await env.refs.list()).some(({ ref }) => ref.endsWith('-old-journal')));
    failReadback = false;
    const checkpoint = await manageMaintenance({ ...maintenance, action: 'resume' });
    assert.equal(checkpoint.status, 'failed');
    assert.match(JSON.stringify(checkpoint), /Checkpoint read unavailable/);
    offline = false;
    assert.ok((await readRemoteState(env.repository)).journal.maintenanceCleanup);
    assert.ok((await env.refs.list()).some(({ ref }) => ref.endsWith('-old-journal')));
    const interruptedCleanup = await manageMaintenance({ ...maintenance, binary: undefined, action: 'resume' });
    assert.equal(interruptedCleanup.status, 'failed');
    assert.match(JSON.stringify(interruptedCleanup), /Temporary ref cleanup interrupted/);
    assert.equal((await readRemoteState(env.repository)).journal.maintenance, 'maintenance');
    failCleanup = false;
    const resumedAt = new Date('2026-11-08T15:00:00Z');
    const completed = await manageMaintenance({ ...maintenance, action: 'resume', now: resumedAt });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal((await readRemoteState(env.repository)).journal.lastCleanupAt, resumedAt.toISOString());
    assert.equal(completed.maintenance, 'open');
    assert.equal((await manageMaintenance({ ...maintenance, binary: undefined, action: 'resume' })).status, 'completed');
    assert.equal(env.refs.switches(), 1);
    assert.ok(!(await env.refs.list()).some(({ ref }) => ref.startsWith('refs/heads/maintenance-')));
    const fresh = { ...latest, stateDirectory: join(directory, 'fresh') };
    const same = await checkRules(fresh);
    assert.equal(same.exitCode, 0, JSON.stringify(same));
    const after = await readRemoteStatus({ ...fresh, repository: env.repository });
    assert.deepEqual(Object.keys(after.state.candidates).sort(), Object.values(before.activeRuleVersions).map(v => v.activation.candidateId).sort());
    for (const id of env.ids) {
      assert.equal(after.activeRuleVersions[id].activation.id, before.activeRuleVersions[id].activation.id);
      assert.deepEqual(after.activeRuleVersions[id].activation.subscription, before.activeRuleVersions[id].activation.subscription);
      assert.deepEqual(after.activeRuleVersions[id].activation.files, before.activeRuleVersions[id].activation.files);
    }
  }, branch));
}

for (const branch of ['acceptance-issue-54', 'main']) {
  test(`${branch} 两轮清理保留 pin 和新历史，并拒绝旧代次写入、回滚及重建`, { timeout: 120_000, skip: !binary }, async () => isolated(async (env, directory) => {
    const anthropic = 'anthropic';
    const openai = 'openai';
    const blocked = new Set<string>();
    const download = (url: string) => {
      assert.ok(!blocked.has(url.split('/')[5]), `Old artifact address used: ${url}`);
      return env.transport.download(url);
    };
    const next = (source: ReturnType<typeof upstream>, label: string) => {
      const base = options(env, join(directory, label), source);
      return { ...base, publication: { ...base.publication, download }, activation: { ...base.activation, download } };
    };
    const a = upstream(1);
    const b = upstream(2, { anthropic: 'domain:version-b.example' });
    const initial = next(a, 'original');
    assert.equal((await checkRules(initial)).exitCode, 0);
    const status = (opts = initial) => readRemoteStatus({ ...opts, repository: env.repository });
    const started = await status();
    await activateRules(env.options(openai, started.activeRuleVersions[openai].activation.candidateEvidenceUrl));
    const pinned = (await status()).activeRuleVersions[openai];
    const unrelated = { ref: 'refs/heads/acceptance-issue-54-unrelated', after: env.head() };
    await env.refs.update([unrelated]);

    const maintenance = { ...initial, repository: env.repository, baseline: env.baseline, refTransport: env.refs };
    async function clean() {
      const prior = [...env.snapshots.keys()];
      assert.equal((await manageMaintenance({ ...maintenance, action: 'enter', manual: true })).status, 'isolated');
      assert.equal((await manageMaintenance({ ...maintenance, action: 'prepare' })).status, 'prepared');
      const switched = await manageMaintenance({ ...maintenance, action: 'switch' });
      assert.equal(switched.status, 'completed', JSON.stringify(switched));
      assert.match(JSON.stringify(switched), /acceptance-issue-54-unrelated/);
      return prior;
    }
    for (const sha of await clean()) blocked.add(sha);
    const afterFirst = await status(next(a, 'after-first'));
    assert.equal(afterFirst.generation, 2);
    assert.deepEqual(afterFirst.activeRuleVersions[openai].control, pinned.control);
    assert.equal(afterFirst.activeRuleVersions[anthropic].activation.id, started.activeRuleVersions[anthropic].activation.id);
    assert.deepEqual(afterFirst.rollbackTargets[anthropic], []);

    const updated = await checkRules(next(b, 'update-b'));
    assert.equal(updated.exitCode, 0, JSON.stringify(updated));
    const afterB = await status();
    const [retainedA] = afterB.rollbackTargets[anthropic];
    assert.equal(retainedA.id, started.activeRuleVersions[anthropic].activation.id);
    const rollback = await rollbackRules({ ...env.options(anthropic, ''), transport: initial.activation, historicalActivationCommit: retainedA.commit });
    assert.deepEqual(rollback.activation.files, started.activeRuleVersions[anthropic].activation.files);
    assert.equal((await resumeRules({ ...next(b, 'resume-b'), logicalId: anthropic })).exitCode, 0);
    const beforeSecond = await status();
    assert.deepEqual(beforeSecond.activeRuleVersions[anthropic].activation.files, afterB.activeRuleVersions[anthropic].activation.files);

    const stale = next(upstream(3, { anthropic: 'domain:stale.example' }), 'stale-operation');
    let continueCheck!: () => void, markStarted!: () => void;
    const release = new Promise<void>(resolve => { continueCheck = resolve; });
    const startedFetch = new Promise<void>(resolve => { markStarted = resolve; });
    const waiting = checkRules({ ...stale, fetch: async (...args) => {
      markStarted();
      await release;
      return stale.fetch(...args);
    } });
    await startedFetch;
    let releaseStatus!: () => void, markStatusStarted!: () => void;
    const statusRelease = new Promise<void>(resolve => { releaseStatus = resolve; });
    const statusStarted = new Promise<void>(resolve => { markStatusStarted = resolve; });
    let waitForSwitch = true;
    const querying = readRemoteStatus({ ...initial, repository: { ...env.repository, async snapshot(target?: string) {
      const snapshot = await env.repository.snapshot(target);
      if (waitForSwitch) {
        waitForSwitch = false;
        markStatusStarted();
        await statusRelease;
      }
      return snapshot;
    } } });
    await statusStarted;
    let obsolete: string[];
    try { obsolete = await clean(); }
    finally { continueCheck(); releaseStatus(); }
    const observed = await querying;
    assert.equal(observed.generation, branch === 'main' ? 3 : 2);
    if (branch === 'main') assert.deepEqual(observed.rollbackTargets[anthropic], []);
    const newHead = env.head();
    const staleResult = await waiting;
    assert.equal(staleResult.exitCode, 1);
    assert.match(JSON.stringify(staleResult), /earlier maintenance generation/);
    assert.equal(env.head(), newHead);

    // Even when GitHub still serves an obsolete object, its SHA cannot select a rollback.
    await assert.rejects(rollbackRules({ ...env.options(anthropic, ''), historicalActivationCommit: retainedA.commit }), /ROLLBACK_UNAVAILABLE/);
    for (const sha of obsolete) blocked.add(sha);
    const fresh = next(b, 'fresh-generation-3');
    const afterSecond = await status(fresh);
    assert.equal(afterSecond.generation, 3);
    assert.deepEqual(afterSecond.rollbackTargets[anthropic], []);
    for (const id of env.ids) {
      const before = beforeSecond.activeRuleVersions[id];
      const after = afterSecond.activeRuleVersions[id];
      assert.equal(after.activation.id, before.activation.id);
      assert.deepEqual(after.activation.files, before.activation.files);
      assert.deepEqual(after.activation.subscription, before.activation.subscription);
      assert.deepEqual(after.control, before.control);
      assert.equal(after.candidate.status, 'available');
    }
    const old = next(a, 'original');
    assert.ok((await readUpdateState(old.stateDirectory)).state.candidates[retainedA.candidateId]);
    await assert.rejects(updateRules({ ...old, selectedIds: [anthropic] }), /CANDIDATE_UNAVAILABLE/);
    assert.equal((await readUpdateState(old.stateDirectory)).state.candidates[retainedA.candidateId], undefined);
    await assert.rejects(rebuildRules({ ...old, release: '20261104112831', selectedIds: [anthropic] }), /CANDIDATE_UNAVAILABLE/);
    const same = await checkRules(fresh);
    assert.equal(same.exitCode, 0, JSON.stringify(same));
    assert.equal(same.results.find(entry => entry.id === anthropic)?.status, 'unchanged');
    assert.equal((await status()).activeRuleVersions[anthropic].activation.id, afterSecond.activeRuleVersions[anthropic].activation.id);
  }, branch));
}

test('人工激活回读跨越清理后拒绝返回旧地址或覆盖本地回执', { skip: !binary, timeout: 120_000 }, async () => isolated(async (env, directory) => {
  const id = 'anthropic';
  const first = options(env, directory, upstream(1));
  const candidate = await updateRules({ ...first, selectedIds: [id] });
  const built = candidate.results.find(entry => entry.id === id);
  assert.ok(built?.status === 'processed');
  const old = env.options(id, built.candidate.evidenceUrl!);
  let releaseReadback!: () => void, markCommitted!: () => void;
  const release = new Promise<void>(resolve => { releaseReadback = resolve; });
  const committed = new Promise<void>(resolve => { markCommitted = resolve; });
  let oldCommit: string | undefined;
  const pending = activateRules({ ...old, transport: { ...env.transport, async commit(...args) {
    return oldCommit = await env.transport.commit(...args);
  }, async download(url) {
    if (oldCommit && url.split('/')[5] === oldCommit) {
      markCommitted();
      await release;
    }
    return env.transport.download(url);
  } } });
  const refused = assert.rejects(pending, /PUBLICATION_CONFLICT: generation or maintenance changed/);
  await committed;
  try {
    const latest = options(env, directory, upstream(2, { anthropic: 'domain:replacement.example' }));
    const next = await updateRules({ ...latest, selectedIds: [id] });
    const replacement = next.results.find(entry => entry.id === id);
    assert.ok(replacement?.status === 'processed');
    const active = await activateRules(env.options(id, replacement.candidate.evidenceUrl!));
    const maintenance = { ...first, repository: env.repository, baseline: env.baseline, refTransport: env.refs };
    assert.equal((await manageMaintenance({ ...maintenance, action: 'enter', manual: true })).status, 'isolated');
    assert.equal((await manageMaintenance({ ...maintenance, action: 'prepare' })).status, 'prepared');
    assert.equal((await manageMaintenance({ ...maintenance, action: 'switch' })).status, 'completed');
    releaseReadback();
    await refused;
    assert.equal((await readUpdateState(directory)).activeRuleVersions[id].activation.id, active.activation.id);
    assert.equal((await readRemoteStatus({ ...first, repository: env.repository })).state.candidates[built.candidate.id], undefined);
  } finally { releaseReadback(); }
}));
