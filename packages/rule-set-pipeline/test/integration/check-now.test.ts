import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules, checkRules, readRemoteStatus, rebuildRules, resumeRules, rollbackRules, updateRules } from '../../src/index.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { STATE_PATH, type RemoteJournal } from '../../src/remote-state.js';
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

test('恢复只解除选中集的限制，并允许重新采用刚回滚掉的最新版本', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = await checkRules(options(env, directory, upstream(1)));
  const openaiCommit = await env.repository.lastChange!(env.head(), 'stable/ai-openai/activation.json');
  const latest = upstream(3, { openai: 'domain:new-openai.example' });
  const second = await checkRules(options(env, directory, latest));
  const pin = await rollbackRules({ ...env.options('ai-openai', ''), historicalActivationCommit: openaiCommit });
  const before = await readRemoteStatus({ repository: env.repository, publication: options(env, directory, latest).publication, activation: env.transport });
  const sibling = await activateRules(env.options('ai-anthropic', before.activeRuleVersions['ai-anthropic'].activation.candidateEvidenceUrl));

  latest.requests.length = 0;
  const result = await resumeRules({ ...options(env, join(directory, 'fresh'), latest), logicalId: 'ai-openai' });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'ai-openai');
  assert.equal(result.results[0].status, 'activated');
  assert.equal(result.results[0].current?.candidateId, second.results[0].candidateId);
  assert.notEqual(result.results[0].current?.candidateId, first.results[0].candidateId);
  assert.notEqual(result.results[0].control?.revision, pin.activation.control?.revision);
  assert.equal(result.results[0].control?.pauseAutomaticRetry, false);
  assert.equal(result.results[0].control?.pauseAutomaticActivation, false);
  assert.equal(latest.requests.filter(url => url.endsWith('/latest')).length, 1);
  assert.ok(latest.requests.every(url => !url.endsWith('/releases/2')));
  const after = await readRemoteStatus({ repository: env.repository, publication: options(env, directory, latest).publication, activation: env.transport });
  assert.deepEqual(after.activeRuleVersions['ai-anthropic'].activation, sibling.activation);
  assert.deepEqual(after.activeRuleVersions['ai-google-deepmind'].activation, before.activeRuleVersions['ai-google-deepmind'].activation);
}));

for (const branch of ['acceptance-issue-51', 'main']) {
  test(`${branch} 恢复决定提交后断线，换机检查失败仍保持恢复并能再次更新`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const candidates = await env.candidates();
    const pinned = await activateRules(env.options('ai-openai', candidates['ai-openai'].evidenceUrl!));
    const sibling = await activateRules(env.options('ai-anthropic', candidates['ai-anthropic'].evidenceUrl!));
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
    const interrupted = await resumeRules({ ...first, logicalId: 'ai-openai', publication: { ...first.publication, repository } });
    assert.equal(interrupted.exitCode, 1);
    assert.equal(interrupted.results[0].status, 'verification-pending');
    assert.deepEqual(latest.requests, []);
    assert.equal(env.writes(), 2);

    const status = () => readRemoteStatus({ repository: env.repository, publication: first.publication, activation: env.transport });
    const saved = await status();
    const control = saved.activeRuleVersions['ai-openai'].control;
    assert.equal(control?.reason, 'manual-resume');
    assert.notEqual(control?.revision, pinned.activation.control?.revision);
    assert.deepEqual(saved.activeRuleVersions['ai-openai'].activation, pinned.activation);
    assert.ok(saved.pendingOperations.some(entry => entry.id === control?.revision && entry.status === 'resume-check-pending'));

    const fresh = options(env, join(directory, 'second'), upstream(3, { openai: 'unsupported:invalid.example' }));
    const failed = await checkRules({ ...fresh, selectedIds: ['ai-openai'] });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.results[0].current?.id, pinned.activation.id);
    assert.deepEqual(failed.results[0].control, control);
    assert.equal(env.writes(), 2);
    assert.ok(!(await status()).pendingOperations.some(entry => entry.status === 'resume-check-pending'));

    const retried = await checkRules({ ...options(env, join(directory, 'third'), upstream(4)), selectedIds: ['ai-openai'] });
    assert.equal(retried.exitCode, 0);
    assert.equal(retried.results[0].status, 'activated');
    assert.equal(retried.results[0].releaseId, 4);
    assert.deepEqual(retried.results[0].control, control);
    assert.deepEqual((await status()).activeRuleVersions['ai-anthropic'].control, sibling.activation.control);
    assert.equal(env.writes(), 3);
  }, branch));

  test(`${branch} 自动检查登记后人工固定并恢复，最早任务仍不能发布或激活`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const initial = options(env, directory, upstream(1));
    await checkRules({ ...initial, selectedIds: ['ai-openai'] });
    const before = await readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
    const candidate = before.activeRuleVersions['ai-openai'].activation.candidateEvidenceUrl;
    const source = upstream(2, { openai: 'domain:old-task.example' });
    const first = options(env, join(directory, 'old'), source);
    const old = await checkRules({ ...first, selectedIds: ['ai-openai'], fetch: async (url, init) => {
      if (String(url).endsWith('/assets/11')) {
        const pinned = await activateRules(env.options('ai-openai', candidate));
        const resumed = await resumeRules({ ...options(env, join(directory, 'new'), upstream(3)), logicalId: 'ai-openai' });
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
    assert.equal(after.state.latestChecks?.['ai-openai'].releaseId, 3);
    assert.equal(env.writes(), 2);
  }, branch));
}

test('维护期间拒绝保存恢复决定或访问上游', { skip: !binary }, async () => isolated(async (env, directory) => {
  const candidates = await env.candidates();
  const pin = await activateRules(env.options('ai-openai', candidates['ai-openai'].evidenceUrl!));
  const snapshot = await env.repository.snapshot();
  const journal = JSON.parse((await snapshot.read(STATE_PATH))!.toString());
  journal.maintenance = 'maintenance';
  const head = await env.repository.commit(snapshot.head, { [STATE_PATH]: Buffer.from(JSON.stringify(journal)) }, 'Enter maintenance');
  const source = upstream(1);
  const common = options(env, directory, source);
  await assert.rejects(resumeRules({ ...common, logicalId: 'ai-openai' }), /REPOSITORY_MAINTENANCE/);
  assert.deepEqual(source.requests, []);
  assert.equal(env.head(), head);
  const status = await readRemoteStatus({ ...common, repository: env.repository });
  assert.deepEqual(status.activeRuleVersions['ai-openai'].control, pin.activation.control);
}));

test('恢复 OpenAI 立即检查最新来源，Anthropic 保留原批次和已发布的候选文件', { skip: !binary }, async () => isolated(async (env, directory) => {
  const initial = options(env, directory, upstream(1));
  await checkRules(initial);
  const status = () => readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
  const original = await status();
  await activateRules(env.options('ai-openai', original.activeRuleVersions['ai-openai'].activation.candidateEvidenceUrl));
  const earlier = options(env, join(directory, 'earlier'), upstream(2, { anthropic: 'domain:earlier.example' }));
  let earlierCandidate: string | undefined;
  const repository = { ...env.repository, async commit(...args: Parameters<typeof env.repository.commit>) {
    const head = await env.repository.commit(...args);
    const ruleFile = Object.keys(args[1]).find(path => path.startsWith('candidates/') && path.endsWith('/domains.srs'));
    if (!earlierCandidate && ruleFile) {
      earlierCandidate = ruleFile.split('/')[1];
      const resumed = await resumeRules({ ...options(env, join(directory, 'resume'), upstream(3, { openai: 'domain:latest.example' })), logicalId: 'ai-openai' });
      assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
      assert.equal(resumed.results[0].releaseId, 3);
      assert.equal(resumed.results[0].status, 'activated');
    }
    return head;
  } };
  const old = await checkRules({ ...earlier, selectedIds: ['ai-anthropic'], publication: { ...earlier.publication, repository } });
  assert.equal(old.exitCode, 1);
  assert.ok(earlierCandidate);
  const after = await status();
  assert.equal(after.state.pendingOperation?.releaseId, 2);
  assert.equal(after.state.candidates[earlierCandidate].phase, 'files');
  assert.equal(after.activeRuleVersions['ai-anthropic'].activation.id, original.activeRuleVersions['ai-anthropic'].activation.id);
  const pinnedSource = upstream(2, { anthropic: 'domain:earlier.example' });
  const recovery = await checkRules({ ...options(env, join(directory, 'recover'), pinnedSource), selectedIds: ['ai-anthropic'] });
  assert.equal(recovery.exitCode, 0, JSON.stringify(recovery));
  assert.equal(recovery.results[0].candidateId, earlierCandidate);
  assert.equal(recovery.results[0].releaseId, 2);
  assert.ok(pinnedSource.requests.every(url => !url.endsWith('/latest')));
}, 'main'));

test('单集恢复已固定来源后中断，正常批次用同一个 Release 继续三个规则集', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = options(env, directory, upstream(1));
  await checkRules(first);
  const initial = await readRemoteStatus({ repository: env.repository, publication: first.publication, activation: env.transport });
  await activateRules(env.options('ai-openai', initial.activeRuleVersions['ai-openai'].activation.candidateEvidenceUrl));
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
  const interrupted = await resumeRules({ ...common, logicalId: 'ai-openai', publication: { ...common.publication, repository } });
  assert.equal(interrupted.exitCode, 1);
  assert.deepEqual(interrupted.results.map(result => result.status), ['verification-pending']);

  source.requests.length = 0;
  const continued = await checkRules(options(env, join(directory, 'fresh'), source));
  assert.equal(continued.exitCode, 0, JSON.stringify(continued));
  assert.deepEqual(continued.results.map(result => [result.id, result.status, result.releaseId]), [
    ['ai-openai', 'activated', 2], ['ai-anthropic', 'activated', 2], ['ai-google-deepmind', 'unchanged', 2],
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
  await activateRules(env.options('ai-openai', original.activeRuleVersions['ai-openai'].activation.candidateEvidenceUrl));
  const earlier = upstream(2, { anthropic: 'domain:earlier.example' });
  const latest = upstream(3, { openai: 'domain:latest.example', anthropic: 'domain:also-latest.example' });
  const prior = options(env, join(directory, 'prior'), earlier);
  const interruptedPrior = await checkRules({ ...prior, selectedIds: ['ai-anthropic'], publication: {
    ...prior.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } });
  assert.equal(interruptedPrior.exitCode, 1);
  const current = options(env, join(directory, 'resume'), latest);
  const interruptedResume = await resumeRules({ ...current, logicalId: 'ai-openai', publication: {
    ...current.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 3),
  } });
  assert.equal(interruptedResume.exitCode, 1);
  await assert.rejects(checkRules(options(env, join(directory, 'batch'), latest)), /RECOVERY_REQUEST_MISMATCH/);
  assert.equal((await status()).activeRuleVersions['ai-anthropic'].activation.source.releaseId, 1);

  const resumed = await resumeRules({ ...current, stateDirectory: join(directory, 'resume-retry'), logicalId: 'ai-openai' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 3);
  const continued = await checkRules({ ...prior, stateDirectory: join(directory, 'prior-retry'), selectedIds: ['ai-anthropic'] });
  assert.equal(continued.exitCode, 0, JSON.stringify(continued));
  assert.equal(continued.results[0].releaseId, 2);
  assert.equal((await status()).activeRuleVersions['ai-anthropic'].activation.source.releaseId, 2);
}, 'main'));

test('恢复决定写入后断线，候选更新用原命令继续已暂存的 Release', { skip: !binary }, async () => isolated(async (env, directory) => {
  const first = options(env, directory, upstream(1));
  await checkRules(first);
  const status = () => readRemoteStatus({ repository: env.repository, publication: first.publication, activation: env.transport });
  const before = await status();
  await activateRules(env.options('ai-openai', before.activeRuleVersions['ai-openai'].activation.candidateEvidenceUrl));
  const source = upstream(2, { anthropic: 'domain:earlier.example' });
  const prior = options(env, join(directory, 'prior'), source);
  await assert.rejects(updateRules({ ...prior, selectedIds: ['ai-anthropic'], publication: {
    ...prior.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } }), /PUBLICATION_PENDING/);
  const latest = options(env, join(directory, 'resume'), upstream(3));
  const interrupted = await resumeRules({ ...latest, logicalId: 'ai-openai', publication: {
    ...latest.publication, repository: loseCheckpoint(env, journal => journal.resumes?.['ai-openai']?.checkPending === true),
  } });
  assert.equal(interrupted.exitCode, 1);
  const saved = await status();
  assert.ok(saved.pendingOperations.some(entry => entry.status === 'parked'));
  source.requests.length = 0;
  const continued = await updateRules({ ...prior, stateDirectory: join(directory, 'fresh'), selectedIds: ['ai-anthropic'] });
  assert.equal(continued.releaseId, 2);
  assert.equal(continued.results[0].status, 'processed');
  assert.ok(source.requests.some(url => url.endsWith('/releases/2')));
  assert.ok(source.requests.every(url => !url.endsWith('/latest')));
  assert.equal((await status()).activeRuleVersions['ai-anthropic'].activation.id, before.activeRuleVersions['ai-anthropic'].activation.id);
  const resumed = await resumeRules({ ...latest, stateDirectory: join(directory, 'resume-retry'), logicalId: 'ai-openai' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 3);
  assert.deepEqual(resumed.results[0].control, saved.activeRuleVersions['ai-openai'].control);
}));

test('普通批次不会把已恢复到新 Release 的兄弟集纳入较旧的恢复检查', { skip: !binary }, async () => isolated(async (env, directory) => {
  const initial = options(env, directory, upstream(1));
  await checkRules(initial);
  const status = () => readRemoteStatus({ repository: env.repository, publication: initial.publication, activation: env.transport });
  const before = await status();
  for (const id of ['ai-openai', 'ai-anthropic']) {
    await activateRules(env.options(id, before.activeRuleVersions[id].activation.candidateEvidenceUrl));
  }
  const earlier = options(env, join(directory, 'earlier'), upstream(2, {
    openai: 'domain:openai-earlier.example', anthropic: 'domain:anthropic-earlier.example',
  }));
  const interrupted = await resumeRules({ ...earlier, logicalId: 'ai-openai', publication: {
    ...earlier.publication, repository: loseCheckpoint(env, journal => journal.state.pendingOperation?.releaseId === 2),
  } });
  assert.equal(interrupted.exitCode, 1);
  const latest = options(env, join(directory, 'latest'), upstream(3, { anthropic: 'domain:anthropic-latest.example' }));
  const sibling = await resumeRules({ ...latest, logicalId: 'ai-anthropic' });
  assert.equal(sibling.exitCode, 0, JSON.stringify(sibling));
  assert.equal(sibling.results[0].status, 'activated');

  await assert.rejects(checkRules({ ...earlier, stateDirectory: join(directory, 'batch') }), /RECOVERY_REQUEST_MISMATCH/);
  const resumed = await resumeRules({ ...earlier, stateDirectory: join(directory, 'fresh'), logicalId: 'ai-openai' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.equal(resumed.results[0].releaseId, 2);
  const after = await status();
  assert.equal(after.activeRuleVersions['ai-anthropic'].activation.source.releaseId, 3);
  assert.equal(after.activeRuleVersions['ai-anthropic'].activation.id, sibling.results[0].current?.id);
}));
