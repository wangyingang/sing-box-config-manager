import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH, type RulesResult } from '../../src/rules-model.js';
import { cleanupEnvironment, fourSetCleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const success = (result: RulesResult) => { assert.equal(result.status, 'success', JSON.stringify(result)); return result; };
type Environment = ReturnType<typeof cleanupEnvironment>;
const request = (env: Environment) => ({ context: env.context });
const current = (result: RulesResult, id = 'openai') => result.results.find(rule => rule.id === id)!.current!;

async function stableBytes(env: Environment) {
  const snapshot = await env.context.repository.snapshot(env.context.targetBranch);
  return Object.fromEntries(await Promise.all(snapshot.paths.filter(path => path.startsWith('stable/') && !path.endsWith('/activation.json'))
    .map(async path => [path, await snapshot.read(path)])));
}

const retainedFixtures = new Map<string, ReturnType<typeof prepareRetainedHistory>>();

async function retainedFixture(target: string) {
  let prepared = retainedFixtures.get(target);
  if (!prepared) {
    prepared = prepareRetainedHistory(target);
    retainedFixtures.set(target, prepared);
  }
  const { checkpoint, versions } = await prepared;
  return { env: cleanupEnvironment(binary!, target, checkpoint()), ...structuredClone(versions) };
}

async function prepareRetainedHistory(target: string) {
  const env = fourSetCleanupEnvironment(binary!, target);
  env.clock('2026-09-01T00:00:00.000Z');
  const first = success(await syncRules(request(env)));
  const expired = current(first);
  const pinned = current(first, 'anthropic');
  const protectedCurrent = current(first, 'google-deepmind');
  const cidr = [current(first, 'china-ip')];
  success(await pinRuleVersion({ ...request(env), id: 'anthropic', version: pinned.versionId! }));
  env.clock('2026-10-17T00:00:00.000Z');
  env.upstream({ openai: 'domain:boundary.example' });
  env.changeCidr('192.0.2.128/25\n2001:db8:2::/48\n');
  const boundaryResult = success(await syncRules(request(env)));
  const boundary = current(boundaryResult); cidr.push(current(boundaryResult, 'china-ip'));
  env.clock('2026-11-01T00:00:00.000Z');
  env.upstream({ openai: 'domain:recent.example' });
  env.changeCidr('198.51.100.0/25\n2001:db8:3::/48\n');
  const recentResult = success(await syncRules(request(env)));
  const recent = current(recentResult); cidr.push(current(recentResult, 'china-ip'));
  env.clock('2026-11-16T00:00:00.000Z');
  env.upstream({ openai: 'domain:current.example' });
  env.changeCidr('198.51.100.128/25\n2001:db8:4::/48\n');
  const latestResult = success(await syncRules(request(env)));
  const latest = current(latestResult); cidr.push(current(latestResult, 'china-ip'));
  return { checkpoint: env.checkpoint(), versions: { expired, pinned, boundary, recent, latest, cidr, protectedCurrent,
    retained: [pinned, protectedCurrent, boundary, recent, latest, ...cidr.slice(1)] } };
}

for (const target of ['acceptance-cleanup-deleted-history', 'main']) {
  test(`${target}: 删除结案登记旧历史，核实并回收后才清除登记`, async () => {
    const env = cleanupEnvironment(binary!, target), input = request(env);
    const first = success(await syncRules(input));
    const removed = current(first), retained = current(first, 'anthropic');
    const repository = env.context.repository, commit = repository.commit;
    const journalHead = env.heads.get(repository.branch)!;
    const stableHead = env.heads.get(target)!;
    const config = env.config(); config.ruleSets = config.ruleSets.filter(rule => rule.id !== removed.logicalId);
    env.configure(config);
    env.beforeWrite(async files => {
      if (files[RULE_STATE_PATH] && parseRulesJournal(files[RULE_STATE_PATH]).rules.openai.lifecycle === 'deleted') {
        throw new Error('RULE_WRITE_CONFLICT: deletion close interrupted');
      }
    });
    assert.notEqual((await syncRules(input)).status, 'success');
    const unfinished = await env.journal();
    assert.equal(unfinished.pendingDelivery?.kind, 'delete');
    assert.equal(unfinished.deletedHistoryPending, undefined);
    assert.equal((await cleanupRuleHistory(input)).status, 'pending');
    assert.deepEqual(env.stageWrites, []);

    env.beforeWrite();
    let lostResponse = false;
    repository.commit = async (...args) => {
      const head = await commit(...args);
      if (args[2][RULE_STATE_PATH] && parseRulesJournal(args[2][RULE_STATE_PATH]).rules.openai.lifecycle === 'deleted') {
        lostResponse = true;
        throw new PublicationWriteError(head, new Error('deletion close response lost'));
      }
      return head;
    };
    success(await syncRules(input));
    repository.commit = commit;
    assert.ok(lostResponse);
    const closed = await env.journal();
    assert.equal(closed.rules.openai.lifecycle, 'deleted');
    assert.equal(closed.pendingDelivery, undefined);
    assert.equal(closed.candidates[removed.candidateId], undefined);
    assert.ok(!(await repository.snapshot()).paths.some(path => path.startsWith(`candidates/${removed.candidateId}/`)));
    assert.ok(!(await repository.snapshot(target)).paths.some(path => path.startsWith('stable/openai/')));
    assert.ok(env.reachable().has(journalHead));
    assert.ok(env.reachable(target).has(stableHead));
    const preview = success(await cleanupRuleHistory({ ...input, dryRun: true }));
    assert.deepEqual(preview.cleanup?.plan.discard.candidateIds, []);
    assert.equal(preview.cleanup?.plan.hasCleanup, true);
    assert.equal(preview.cleanup?.plan.deletedHistoryPending, true);
    assert.equal(closed.deletedHistoryPending, true);

    const bytes = await stableBytes(env);
    env.failDownload(url => {
      if (url.includes(`/${target}/stable/`)) throw new Error('Switched stable URL unavailable');
    });
    const interrupted = await cleanupRuleHistory(input);
    assert.equal(interrupted.status, 'pending', JSON.stringify(interrupted));
    assert.equal(interrupted.cleanup?.phase, 'readback');
    assert.equal((await env.journal()).deletedHistoryPending, true);
    assert.equal(env.reachable().has(journalHead), false);
    assert.equal(env.reachable(target).has(stableHead), false);

    env.failDownload();
    env.clock('2027-01-01T00:00:00.000Z');
    const cleaned = success(await cleanupRuleHistory({ context: { ...env.context } }));
    assert.equal(cleaned.cleanup?.phase, 'completed');
    assert.equal(cleaned.cleanup?.maintenanceId, interrupted.cleanup?.maintenanceId);
    assert.deepEqual(cleaned.cleanup?.plan, preview.cleanup?.plan);
    assert.equal((await env.journal()).deletedHistoryPending, undefined);
    assert.deepEqual(new Set((await env.refs.list()).map(({ ref }) => ref)), new Set([
      `refs/heads/${target}`, `refs/heads/${repository.branch}`,
    ]));
    assert.deepEqual(await stableBytes(env), bytes);
    const status = await getRulesStatus(input); success(status);
    const after = status.rules!.find(rule => rule.id === retained.logicalId)!;
    assert.equal(after.current?.versionId, retained.versionId);
    assert.equal(after.current?.publishedAt, retained.publishedAt);
    assert.deepEqual(after.current?.source, retained.source);
    assert.equal(after.successfulInput?.candidateId, retained.candidateId);
    const writes = env.writes.length;
    assert.equal(success(await cleanupRuleHistory(input)).cleanup?.phase, 'unchanged');
    assert.equal(env.writes.length, writes);
  });
}

for (const target of ['acceptance-issue-85', 'main']) {
  test(`${target}: 四集含 CIDR 按首次发布时间保留多版本，两轮清理后旧历史不可用仍可查询和 pin`, { skip: !binary, timeout: 120_000 }, async () => {
    const { env, expired, pinned, boundary, recent, latest, cidr, retained } = await retainedFixture(target);
    const beforeBytes = await stableBytes(env);
    const beforeJournal = await env.journal();
    const oldHeads = new Set(env.trees.keys());
    env.heads.set('unrelated-work', env.heads.get(env.context.repository.branch)!);
    env.heads.set('refs/tags/unrelated-tag', env.heads.get(env.context.repository.branch)!);
    const unknownHead = env.heads.get('unrelated-work');
    const writes = env.writes.length, upstream = env.requests.length;
    const refs = await env.refs.list();
    const preview = success(await cleanupRuleHistory({ ...request(env), dryRun: true }));
    assert.equal(preview.cleanup?.phase, 'preview');
    assert.equal(preview.cleanup?.plan.candidateRetentionDays, 30);
    assert.equal(preview.cleanup?.plan.cutoff, '2026-10-17T00:00:00.000Z');
    assert.deepEqual(new Set(preview.cleanup?.plan.discard.candidateIds), new Set([expired.candidateId, cidr[0].candidateId]));
    assert.deepEqual(new Set(preview.cleanup?.plan.retain.candidateIds), new Set(retained.map(version => version.candidateId)));
    assert.ok(preview.cleanup!.plan.retainedBytes > 0);
    assert.ok(preview.cleanup!.plan.otherRefs.some(ref => ref.ref === 'refs/heads/unrelated-work'));
    assert.ok(preview.cleanup!.plan.otherRefs.some(ref => ref.ref === 'refs/tags/unrelated-tag'));
    assert.equal(env.writes.length, writes); assert.equal(env.stageWrites.length, 0); assert.equal(env.refWrites.length, 0);
    assert.deepEqual(await env.refs.list(), refs);

    const cleaned = success(await cleanupRuleHistory(request(env)));
    assert.equal(cleaned.cleanup?.phase, 'completed');
    assert.deepEqual(await stableBytes(env), beforeBytes);
    const readbacks = cleaned.readbackRequests!;
    assert.equal(readbacks.length, 2 * retained.length + 2 * cleaned.cleanup!.plan.retain.active.length);
    assert.deepEqual(readbacks.filter(url => url.includes(`/${target}/stable/`)).map(url => url.split(`/${target}/`)[1]).sort(),
      Object.keys(beforeBytes).sort());
    for (const { candidateId } of retained) {
      const fixed = readbacks.filter(url => url.includes(`/candidates/${candidateId}/`));
      assert.equal(fixed.length, 2);
      assert.ok(fixed.some(url => url.endsWith('.json')) && fixed.some(url => url.endsWith('.srs')));
    }
    assert.equal(env.requests.length, upstream, 'cleanup must not fetch any upstream input');
    assert.equal(env.heads.get('unrelated-work'), unknownHead);
    assert.equal(env.heads.get('refs/tags/unrelated-tag'), unknownHead);
    assert.ok(![...env.heads.keys()].some(ref => ref.startsWith('maintenance-')));
    for (const head of env.reachable()) assert.ok(!oldHeads.has(head), `Journal still reaches old history: ${head}`);
    for (const head of env.reachable(target)) assert.ok(!oldHeads.has(head), `Stable branch still reaches old history: ${head}`);
    oldHeads.forEach(head => env.blockedHeads.add(head));
    const after = await getRulesStatus(request(env)); success(after);
    assert.equal(after.rules?.find(rule => rule.id === 'openai')?.current?.candidateId, latest.candidateId);
    assert.equal(after.rules?.find(rule => rule.id === 'anthropic')?.current?.candidateId, pinned.candidateId);
    assert.deepEqual(after.rules?.find(rule => rule.id === 'anthropic')?.control, beforeJournal.rules.anthropic.control);
    const kept = await env.journal();
    for (const version of retained) {
      assert.equal(kept.candidates[version.candidateId].versionId, version.versionId);
      assert.equal(kept.candidates[version.candidateId].publishedAt, version.publishedAt);
      assert.deepEqual(kept.candidates[version.candidateId].source, version.source);
      assert.notEqual(kept.candidates[version.candidateId].evidenceUrl, beforeJournal.candidates[version.candidateId].evidenceUrl);
      const candidate = kept.candidates[version.candidateId];
      const snapshot = await env.context.repository.snapshot();
      const files = snapshot.paths.filter(path => path.startsWith(`candidates/${candidate.id}/`));
      assert.equal(files.length, 7);
      for (const path of files) assert.ok((await snapshot.read(path))!.length, path);
      const proof = JSON.parse((await snapshot.read(`candidates/${candidate.id}/readback.json`))!.toString());
      assert.equal(proof.candidateId, candidate.id);
      assert.equal(proof.versionId, candidate.versionId);
    }
    assert.ok(!kept.candidates[expired.candidateId]);
    assert.equal(after.rules?.length, 4);
    assert.ok(after.rules?.every(rule => rule.candidates.every(candidate => candidate.selectable)));
    for (const version of retained) assert.ok(after.rules!.find(rule => rule.id === version.logicalId)!.candidates.some(candidate => candidate.versionId === version.versionId && candidate.selectable));
    const untouched = { heads: new Map(env.heads), stages: env.stageWrites.length, writes: env.writes.length };
    assert.equal(success(await cleanupRuleHistory(request(env))).cleanup?.phase, 'unchanged');
    assert.deepEqual(env.heads, untouched.heads); assert.equal(env.stageWrites.length, untouched.stages); assert.equal(env.writes.length, untouched.writes);

    const selected = success(await pinRuleVersion({ ...request(env), id: 'openai', version: boundary.versionId! }));
    assert.equal(current(selected).candidateId, boundary.candidateId);
    const selectedCidr = success(await pinRuleVersion({ ...request(env), id: 'china-ip', version: cidr[1].versionId! }));
    assert.equal(current(selectedCidr, 'china-ip').candidateId, cidr[1].candidateId);
    const secondBytes = await stableBytes(env);
    env.clock('2026-12-02T00:00:00.000Z');
    const secondDiscard = [recent.candidateId, cidr[2].candidateId];
    const secondHistory = new Set(env.reachable());
    env.reachable(target).forEach(head => secondHistory.add(head));
    const secondCleanup = success(await cleanupRuleHistory(request(env)));
    assert.equal(secondCleanup.cleanup?.phase, 'completed');
    assert.deepEqual(new Set(secondCleanup.cleanup?.plan.discard.candidateIds), new Set(secondDiscard));
    secondHistory.forEach(head => env.blockedHeads.add(head));
    assert.deepEqual(await stableBytes(env), secondBytes);
    const second = await getRulesStatus(request(env)); success(second);
    assert.equal(second.rules?.find(rule => rule.id === 'openai')?.current?.candidateId, boundary.candidateId);
    const secondJournal = await env.journal();
    for (const version of retained) {
      const candidate = secondJournal.candidates[version.candidateId];
      if (secondDiscard.includes(version.candidateId)) assert.equal(candidate, undefined);
      else {
        assert.equal(candidate.versionId, version.versionId);
        assert.equal(candidate.publishedAt, version.publishedAt);
      }
    }
    success(await pinRuleVersion({ ...request(env), id: 'openai', version: latest.versionId! }));
    env.clock('2026-12-18T00:00:00.000Z');
    const aged = success(await cleanupRuleHistory({ ...request(env), dryRun: true }));
    assert.ok(aged.cleanup?.plan.discard.candidateIds.includes(boundary.candidateId), 'Leaving current must not restart candidate age');
  });
}

for (const phase of ['before-switch', 'after-switch'] as const) {
  test(`${phase}: 一个 cleanup 恢复同一维护计划，跨日及保留期变更不扩大删除集合`, { skip: !binary, timeout: 90_000 }, async () => {
    const { env, boundary, latest, retained } = await retainedFixture(phase === 'before-switch' ? 'acceptance-issue-85' : 'main');
    const stable = await stableBytes(env);
    let interrupted = false;
    if (phase === 'before-switch') {
      env.failDownload(url => {
        const ref = new URL(url).pathname.split('/')[3];
        if (env.stageWrites.some(branch => branch.endsWith('-files') && env.heads.get(branch) === ref) && url.endsWith('.srs')) {
          interrupted = true;
          throw new Error('Interrupted new candidate readback');
        }
      });
    } else {
      env.afterRefs(changes => {
        if (changes.some(change => change.ref === `refs/heads/${env.context.repository.branch}` && change.after)) throw new Error('Switch reply lost');
      });
      env.failDownload(url => {
        const ref = new URL(url).pathname.split('/')[3];
        if (ref === env.context.targetBranch && url.endsWith('.srs')) { interrupted = true; throw new Error('Interrupted stable readback'); }
      });
    }
    const failed = await cleanupRuleHistory(request(env));
    assert.ok(interrupted, JSON.stringify(failed)); assert.notEqual(failed.status, 'success', JSON.stringify(failed));
    assert.equal(failed.cleanup?.continueWith, 'cleanup');
    assert.equal((await env.journal()).maintenance, 'maintenance');
    assert.deepEqual(await stableBytes(env), stable);
    const plan = failed.cleanup!.plan;
    const id = failed.cleanup!.maintenanceId;
    const writes = env.writes.length;
    env.upstream({ openai: 'domain:blocked-by-maintenance.example' });
    assert.notEqual((await syncRules(request(env))).status, 'success');
    assert.notEqual((await pinRuleVersion({ ...request(env), id: 'openai', version: latest.versionId! })).status, 'success');
    const resumeSourceCalls = env.requests.length;
    assert.notEqual((await resumeRuleUpdates({ ...request(env), id: 'anthropic' })).status, 'success');
    assert.equal(env.writes.length, writes, 'Rule operations may not write through maintenance isolation');
    assert.equal(env.requests.length, resumeSourceCalls, 'Blocked resume cannot access upstream');
    env.clock('2026-12-31T00:00:00.000Z');
    const configuration = env.config(); configuration.candidateRetentionDays = 1; env.configure(configuration);
    const heads = new Map(env.heads), stages = env.stageWrites.length, transactions = env.refWrites.length;
    const preview = await cleanupRuleHistory({ ...request(env), dryRun: true });
    assert.deepEqual(preview.cleanup?.plan, plan); assert.equal(preview.cleanup?.maintenanceId, id);
    assert.deepEqual(env.heads, heads); assert.equal(env.stageWrites.length, stages); assert.equal(env.refWrites.length, transactions);
    env.failStage(); env.failDownload(); env.afterRefs();
    const recovered = success(await cleanupRuleHistory(request(env)));
    assert.equal(recovered.cleanup?.maintenanceId, id); assert.deepEqual(recovered.cleanup?.plan, plan);
    assert.equal((await env.journal()).candidates[boundary.candidateId].publishedAt, boundary.publishedAt);
    assert.equal((await env.journal()).maintenance, 'open');
    for (const version of retained) {
      const candidate = (await env.journal()).candidates[version.candidateId];
      assert.equal(candidate.versionId, version.versionId); assert.equal(candidate.publishedAt, version.publishedAt);
      assert.deepEqual(candidate.source, version.source);
    }
    assert.deepEqual(await stableBytes(env), stable);
    assert.equal(env.refWrites.filter(changes => changes.some(change => change.ref === `refs/heads/${env.context.repository.branch}`)).length, 1,
      'A resumed cleanup must not switch a second baseline');
  });
}

test('cleanup 原样复制已有追溯文件，读取未完成时保留计划并可续做', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const input = request(env);
  const first = await syncRules(input);
  assert.equal(first.status, 'success', JSON.stringify(first));
  env.clock('2026-12-20T00:00:00.000Z');
  env.upstream({ openai: 'domain:later.example' });
  const next = await syncRules(input);
  assert.equal(next.status, 'success', JSON.stringify(next));
  const current = next.results[0].current!;
  const prefix = `candidates/${current.candidateId}/`;
  const trace = prefix + 'conversion-report.json', optional = prefix + 'source.json';
  const badReport = Buffer.from('original malformed trace record');
  const retained = env.trees.get(env.heads.get('candidates')!)!;
  retained.set(trace, badReport); retained.delete(optional);
  const repository = env.context.repository, snapshot = repository.snapshot;
  let attempts = 0, failCopy = true;
  repository.snapshot = async branch => {
    const observed = await snapshot(branch);
    return { ...observed, async read(path) {
      if (path === trace) {
        attempts++;
        if (failCopy) throw new Error('Trace Git read unavailable');
      }
      return observed.read(path);
    } };
  };
  const preview = await cleanupRuleHistory({ ...input, dryRun: true });
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  assert.equal(attempts, 0);
  const failed = await cleanupRuleHistory(input);
  assert.equal(failed.status, 'pending', JSON.stringify(failed));
  assert.match(failed.error!, /Trace Git read unavailable/);
  assert.equal(env.refWrites.length, 0);
  assert.equal((await env.journal()).maintenance, 'maintenance');
  failCopy = false;
  const resumed = await cleanupRuleHistory(input);
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.cleanup?.maintenanceId, failed.cleanup?.maintenanceId);
  assert.equal(resumed.cleanup?.removedCandidateCount, 1);
  const raw = resumed.readbackRequests!;
  assert.equal(raw.length, 4);
  assert.equal(raw.filter(url => url.endsWith('.srs')).length, 2);
  assert.equal(raw.filter(url => url.includes('/main/stable/')).length, 2);
  assert.equal(raw.filter(url => url.includes(`/candidates/${current.candidateId}/`)).length, 2);
  const rebuilt = await snapshot();
  assert.deepEqual(await rebuilt.read(trace), badReport);
  assert.equal(await rebuilt.read(optional), undefined);
});

test('换源失败的旧交付按当前版本保护，未知发布时间及未完成候选阻塞年龄清理', { skip: !binary, timeout: 90_000 }, async () => {
  const { env, expired, latest } = await retainedFixture('acceptance-issue-85');
  const configuration = env.config();
  const dlc = configuration.sources.dlc; assert.equal(dlc.version, 'latest-release');
  configuration.sources.other = { ...dlc, repository: 'failing/source' };
  configuration.ruleSets[0].source = 'other'; env.configure(configuration); env.failSource('failing/source');
  assert.equal((await syncRules(request(env))).status, 'partial');
  env.clock('2027-01-01T00:00:00.000Z');
  const preview = success(await cleanupRuleHistory({ ...request(env), dryRun: true }));
  assert.ok(preview.cleanup?.plan.retain.candidateIds.includes(latest.candidateId));
  assert.ok(preview.cleanup?.plan.discard.candidateIds.includes(expired.candidateId));
  const journal = await env.journal();
  const old = journal.candidates[expired.candidateId];
  delete old.publishedAt; delete old.versionId; old.migrationPending = 'Original publication time unavailable';
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  const writes = env.writes.length, heads = new Map(env.heads);
  const unknown = await cleanupRuleHistory(request(env));
  assert.notEqual(unknown.status, 'success'); assert.ok(unknown.cleanup?.plan.blockers.length);
  assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes); assert.equal(env.stageWrites.length, 0);
  delete old.migrationPending; old.status = 'publishing';
  const owner = journal.rules[old.logicalId];
  old.controlRevision = owner.control.revision; old.definitionGeneration = owner.generation;
  old.definition = owner.definition; old.sourceInput = owner.source; old.inputBindingRevision = owner.inputBindingRevision;
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  const incomplete = await cleanupRuleHistory(request(env));
  assert.notEqual(incomplete.status, 'success'); assert.ok(incomplete.cleanup?.plan.blockers.length);
  assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
});

test('被新控制明确取代的在途候选可回收，未知控制记录不会授权删除其他 refs', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!);
  const first = success(await syncRules(request(env)));
  const original = current(first);
  env.upstream({ openai: 'domain:next.example' });
  success(await syncRules(request(env)));
  const journal = await env.journal();
  const abandoned = journal.candidates[original.candidateId];
  // Publication can have reserved a timestamp before losing its control revision.
  abandoned.status = 'publishing';
  abandoned.controlRevision = '00000000-0000-0000-0000-000000000000';
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  const result = success(await cleanupRuleHistory(request(env)));
  assert.ok(result.cleanup?.plan.decisions.some(item => item.candidateId === abandoned.id
    && item.action === 'discard' && item.reasons.includes('invalidated-operation')));
  assert.ok(!(await env.journal()).candidates[abandoned.id]);
  const writes = env.writes.length;
  assert.equal((await cleanupRuleHistory({ ...request(env), dryRun: true, draft: 'schemaVersion: 3' })).status, 'failed');
  assert.equal(env.writes.length, writes);
  const corrupt = await env.journal();
  corrupt.maintenance = 'maintenance';
  corrupt.cleanupCheckpoint = { id: result.cleanup!.maintenanceId!, plan: result.cleanup!.plan,
    stableHead: env.heads.get(env.context.targetBranch)!, verifiedAt: '2026-11-16T00:00:00.000Z',
    refs: { 'refs/heads/main': env.heads.get(env.context.targetBranch)! } };
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(corrupt));
  const refs = await env.refs.list(), count = env.refWrites.length;
  const refused = await cleanupRuleHistory(request(env));
  assert.equal(refused.status, 'failed'); assert.match(refused.error!, /RULE_STATE_CORRUPT/);
  assert.deepEqual(await env.refs.list(), refs); assert.equal(env.refWrites.length, count); assert.equal(env.writes.length, writes);
});

test('保留历史的场景各自拥有 Git、上游、时钟、故障与记录', async () => {
  const { env: left } = await retainedFixture('main');
  const { env: right } = await retainedFixture('main');
  const original = await right.context.repository.snapshot('main');
  const originalParents = [...original.parents!];
  const path = 'stable/openai/domains.srs';
  const bytes = Buffer.from((await original.read(path))!);
  const journal = await right.journal();
  const revision = await right.context.readConfiguration!();
  const upstream = right.context.fetch!;
  const release = 'https://api.github.com/repos/v2fly/domain-list-community/releases/latest';
  const branch = 'https://api.github.com/repos/gaoyifan/china-operator-ip/branches/ip-lists';
  const releaseBefore = await (await upstream(release)).json();
  const branchBefore = await (await upstream(branch)).json();
  const originalRelease = 'https://api.github.com/repos/v2fly/domain-list-community/releases/assets/11';
  const originalCidr = 'https://raw.githubusercontent.com/gaoyifan/china-operator-ip/' + '1'.repeat(40) + '/china46.txt';
  const releaseBody = await (await upstream(originalRelease)).text();
  const cidrBody = await (await upstream(originalCidr)).text();

  const changed = await left.context.repository.snapshot('main');
  (await changed.read(path))!.fill(0);
  left.trees.get(changed.head)!.delete(path);
  left.parents.get(changed.head)!.push('different-parent');
  left.heads.delete('main');
  const leftJournal = await left.journal();
  leftJournal.rules.openai.control.revision = 'fixture-control-change';
  left.trees.get(left.heads.get(left.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(leftJournal));
  left.configure({ ...left.config(), candidateRetentionDays: 1 });
  left.upstream({ openai: 'domain:other.example' });
  left.changeCidr('invalid CIDR');
  left.clock('2027-01-01T00:00:00.000Z');
  left.failSource(true);
  left.failStage(() => { throw new Error('stage fault'); });
  left.beforeRefs(() => { throw new Error('ref fault'); });
  left.afterRefs(() => { throw new Error('lost ref response'); });
  left.failDownload(() => { throw new Error('Raw fault'); });
  left.beforeWrite(() => { throw new Error('write fault'); });

  const { env: fresh } = await retainedFixture('main');
  assert.deepEqual([fresh.writes, fresh.requests, fresh.stageWrites, fresh.refWrites], [[], [], [], []]);
  assert.deepEqual(await fresh.journal(), journal);
  assert.deepEqual(await fresh.context.readConfiguration!(), revision);
  assert.equal(fresh.context.now!().toISOString(), '2026-11-16T00:00:00.000Z');
  const reset = await fresh.context.repository.snapshot('main');
  assert.equal(reset.head, original.head);
  assert.deepEqual(reset.parents, originalParents);
  assert.deepEqual(await reset.read(path), bytes);
  assert.deepEqual(await (await fresh.context.fetch!(release)).json(), releaseBefore);
  assert.deepEqual(await (await fresh.context.fetch!(branch)).json(), branchBefore);
  assert.equal(await (await fresh.context.fetch!(originalRelease)).text(), releaseBody);
  assert.equal(await (await fresh.context.fetch!(originalCidr)).text(), cidrBody);
  const nextCidr = originalCidr.replace('1'.repeat(40), String(Number(branchBefore.commit.sha[0]) + 1).repeat(40));
  await assert.rejects(fresh.context.fetch!(nextCidr), /Unknown CIDR fixture revision/);
  await assert.rejects(left.context.fetch!(release), /Upstream unavailable/);
  assert.deepEqual(await fresh.context.repository.download(`https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/${path}`), bytes);

  const commit = async (env: Environment) => env.context.repository.commit('main', original.head,
    { 'pipeline/scenario.json': Buffer.from('{}') }, 'isolated scenario', async () => {});
  assert.equal(await commit(fresh), await commit(right), 'both scenarios allocate the same next commit from the shared base');
  assert.equal(fresh.writes.length, 1);
  assert.equal(right.writes.length, 1);

  const ref = 'fixture-scenario';
  const staged = await fresh.baseline.stage(ref, reset.head, { 'pipeline/staged.json': Buffer.from('{}') }, 'isolated stage');
  assert.equal(left.heads.has(ref), false);
  assert.equal(right.heads.has(ref), false);
  await fresh.refs.update([{ ref: `refs/heads/${ref}`, before: staged, after: undefined }]);
  assert.equal(fresh.heads.has(ref), false);
  assert.deepEqual(fresh.stageWrites, [ref]);
  assert.equal(fresh.refWrites.length, 1);
  assert.deepEqual([right.stageWrites, right.refWrites], [[], []]);
});
