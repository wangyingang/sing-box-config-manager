import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules, rollbackRules } from '../../src/activation.js';
import { checkRules, resumeRules } from '../../src/check-rules.js';
import { readRemoteState } from '../../src/remote-state.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { readUpdateState, rebuildRules, updateRules } from '../../src/update.js';
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

for (const branch of ['acceptance-issue-53', 'main']) {
  test(`${branch} 新基线回读中断后可恢复，屏蔽旧地址后仍核验各集当前版本、pin 和处理进度`, { skip: !binary }, async () => isolated(async (env, directory) => {
    const first = options(env, join(directory, 'initial'), upstream(1));
    assert.equal((await checkRules(first)).exitCode, 0);
    const openai = 'openai', anthropic = 'anthropic';
    const before = await readRemoteStatus({ ...first, repository: env.repository });
    const pin = await activateRules(env.options(openai, before.activeRuleVersions[openai].activation.candidateEvidenceUrl));
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
    assert.equal(Object.keys(after.state.candidates).length, 3);
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
