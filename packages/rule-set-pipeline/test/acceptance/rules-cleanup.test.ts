import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { stringify } from 'yaml';
import { baselineConfiguration } from '../fixtures/baseline-configuration.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, ghJson } from '../../src/publication.js';
import { githubRulesRepository } from '../../src/rules-repository.js';
import { githubBaselineTransport, filePaths } from '../../src/maintenance-baseline-transport.js';
import { branchRef, gitMaintenanceRefs, type RefChange } from '../../src/maintenance-refs.js';
import type { RulesContext } from '../../src/rules-context.js';
import { parseRulesJournal, RULE_STATE_PATH, type RulesResult } from '../../src/rules-model.js';
import { syncRules, pinRuleVersion } from '../../src/rules-operations.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { getRulesStatus, type RuleStatus } from '../../src/rules-status.js';
import { candidateFiles } from '../../src/candidate-publication.js';
import { sha256 } from '../../src/release.js';

test('GitHub 四集 cleanup：保留窗口、切换中断、HTTPS 失败恢复与多轮选择，生产 refs/开关不变', {
  skip: process.env.RULE_CLEANUP_PROBE !== '1', timeout: 3_600_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY, evidencePath = process.env.RULE_CLEANUP_EVIDENCE;
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY'); assert.ok(evidencePath, 'Set RULE_CLEANUP_EVIDENCE to a new file');
  const exec = promisify(execFile);
  const sourceIdentity = { commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    status: (await exec('git', ['status', '--porcelain'])).stdout,
    diffSha256: sha256((await exec('git', ['diff', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 })).stdout),
    probeSha256: sha256(await readFile(new URL(import.meta.url))), binary,
    command: 'RULE_CLEANUP_PROBE=1 pnpm --dir packages/rule-set-pipeline test:acceptance:cleanup' };
  const startedAt = new Date().toISOString();
  const token = process.env.GH_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const target = `acceptance-issue-98-${randomUUID()}`;
  await writeFile(evidencePath, JSON.stringify({ target, sourceIdentity, startedAt, status: 'started' }, null, 2) + '\n', { flag: 'wx' });
  const readbacks: unknown[] = [];
  const runIds = new Set<string>();
  const ownedHeads = new Map<string, string>();
  const observations: unknown[] = [];
  const failures: string[] = [];
  const immutable = new Map<string, Promise<any>>();
  const allowedRef = (ref: string) => ref === branchRef(target)
    || [...runIds].some(id => new RegExp(`^refs/heads/maintenance-${id}-(?:files|metadata|evidence|journal|old-journal)$`).test(ref));
  const request: typeof ghJson = async (args, input) => {
    const endpoint = args[1], method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    if (method !== 'GET') {
      assert.ok(endpoint.startsWith(`repos/${ARTIFACT_REPOSITORY}/git/`), `Unexpected write: ${endpoint}`);
      if (endpoint.endsWith('/git/refs')) {
        const ref = (input as { ref?: string })?.ref; assert.ok(ref && allowedRef(ref), `Unowned ref creation: ${ref}`);
      } else if (endpoint.includes('/git/refs/')) {
        assert.equal(endpoint, `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${target}`, 'Only the isolated live branch accepts API updates');
        assert.equal(method, 'PATCH');
      } else assert.match(endpoint, /\/git\/(?:blobs|trees|commits)$/);
    }
    const cacheable = method === 'GET' && /\/git\/(commits|trees|blobs)\/[a-f0-9]{40}(?:\?recursive=1)?$/.test(endpoint);
    if (cacheable && immutable.has(endpoint)) return immutable.get(endpoint);
    const call = (async () => {
      const response = await fetch(`https://api.github.com/${endpoint}`, { method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
      const body = await response.text();
      if (!response.ok) throw new GitHubHttpError(response.status, `${method} ${endpoint}: HTTP ${response.status}`);
      const result = body ? JSON.parse(body) : null;
      if (method === 'POST' && endpoint.endsWith('/git/refs')) ownedHeads.set((input as { ref: string }).ref, result.object.sha);
      if (method === 'PATCH' && endpoint.endsWith(`/git/refs/heads/${target}`)) ownedHeads.set(branchRef(target), result.object.sha);
      return result;
    })().catch(error => { if (cacheable) immutable.delete(endpoint); throw error; });
    if (cacheable) immutable.set(endpoint, call);
    return call;
  };
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  const rawRefs = gitMaintenanceRefs();
  const refs = { list: rawRefs.list, async update(changes: RefChange[]) {
    assert.ok(changes.every(change => allowedRef(change.ref)), 'Cleanup attempted to change an unowned ref');
    const before = new Map((await rawRefs.list()).map(({ ref, head }) => [ref, head]));
    for (const change of changes) assert.equal(before.get(change.ref), change.before, `Ref changed before transaction: ${change.ref}`);
    const switching = changes.some(change => change.ref === branchRef(target) && change.after);
    if (switching && rejectSwitch) throw new Error('Injected atomic switch interruption');
    let error: unknown;
    try { await rawRefs.update(changes); } catch (caught) { error = caught; }
    const after = new Map((await rawRefs.list()).map(({ ref, head }) => [ref, head]));
    for (const { ref, after: intended } of changes) {
      if (after.get(ref) !== intended) continue;
      if (intended) ownedHeads.set(ref, intended); else ownedHeads.delete(ref);
    }
    observations.push({ label: 'ref-transaction', changes, observed: changes.map(({ ref }) => ({ ref, head: after.get(ref) })), error: error && String(error) });
    if (error) throw error;
    if (switching) { switchCount++; if (loseReply) { loseReply = false; throw new Error('Injected lost switch reply'); } }
  } };
  const production = async () => ({
    main: (await api('git/ref/heads/main')).object.sha,
    candidates: (await api('git/ref/heads/candidates')).object.sha,
    variables: await ghJson(['api', 'repos/wangyingang/sing-box-config-manager/actions/variables']),
  });
  const before = await production();
  let rejectSwitch = false, loseReply = false, switchCount = 0;
  let stageInterrupted = false, stableOffline = false;
  const blockedHeads = new Set<string>();
  let passed = false;
  t.after(async () => {
    const cleanupErrors: string[] = [];
    const live = await rawRefs.list().catch(error => { cleanupErrors.push(String(error)); return []; });
    const owned = live.filter(({ ref, head }) => allowedRef(ref) && ownedHeads.get(ref) === head);
    if (owned.length) await refs.update(owned.map(({ ref, head }) => ({ ref, before: head }))).catch(error => cleanupErrors.push(String(error)));
    const remaining = await rawRefs.list().then(refs => refs.filter(({ ref }) => allowedRef(ref))).catch(error => { cleanupErrors.push(String(error)); return null; });
    const after = await production().catch(error => { cleanupErrors.push(String(error)); return null; });
    const evidence = { sourceIdentity, startedAt, endedAt: new Date().toISOString(), readbacks, switchCount, cleanupErrors, target, runIds: [...runIds], before, after, observations, failures, passed,
      removedRefs: owned.map(({ ref }) => ref), remaining, at: new Date().toISOString() };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    assert.deepEqual(cleanupErrors, []);
    assert.deepEqual(after, before, 'Production refs or Actions variables changed');
    assert.deepEqual(remaining, [], 'Probe left temporary references with an unknown head');
    console.log(JSON.stringify({ target, runIds: [...runIds], passed, cleaned: true, productionUnchanged: true }));
  });
  try {
    assert.ok(!(await rawRefs.list()).some(({ ref }) => ref === branchRef(target)));
    const head = await createGitCommit(api, { 'README.md': Buffer.from(`Issue 98 isolated cleanup probe ${target}\n`) }, '隔离候选保留与清理验收');
    await api('git/refs', { ref: branchRef(target), sha: head });
    const repository = githubRulesRepository(target, request);
    const download = repository.download, snapshot = repository.snapshot;
    repository.snapshot = async ref => {
      assert.ok(!blockedHeads.has(ref ?? ''), `Old snapshot used: ${ref}`);
      return snapshot(ref);
    };
    repository.download = async url => {
      const ref = new URL(url).pathname.split('/')[3];
      assert.ok(!blockedHeads.has(ref), `Old evidence address used: ${url}`);
      if (stableOffline && ref === target && url.includes('/stable/')) throw new Error('Injected stable HTTPS readback outage');
      try { return await download(url); }
      catch (error) { if (error instanceof TypeError) return download(url); throw error; }
    };
    const baseline = githubBaselineTransport(request);
    const originalTag = '20261104112839', updatedTag = '20261108011013';
    const originalCommit = 'f162630c8cdad6ced5ef59e606cc93919123ac57';
    const updatedCommit = '62bc1fc8b015bece77271b568e10d6337915bc96';
    const requests: string[] = [];
    const sources = new Map<string, Response>();
    let tag = originalTag, commit = originalCommit;
    const upstream = async (address: string, init?: RequestInit) => {
      const cached = sources.get(address); if (cached) return cached.clone();
      const endpoint = new URL(address);
      let response: Response;
      if (endpoint.origin === 'https://api.github.com') {
        const accept = new Headers(init?.headers).get('Accept') ?? 'application/vnd.github+json';
        const { stdout } = await exec('gh', ['api', '-H', `Accept: ${accept}`, endpoint.pathname.slice(1) + endpoint.search],
          { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
        response = new Response(new Uint8Array(stdout));
      } else {
        assert.equal(endpoint.origin, 'https://raw.githubusercontent.com');
        response = await fetch(address, { ...init, signal: AbortSignal.timeout(120_000) });
        assert.ok(response.ok, `Source HTTP ${response.status}`);
      }
      sources.set(address, response.clone()); return response;
    };
    const sourceFetch: typeof fetch = async (url, init) => {
      const address = String(url); requests.push(address);
      if (address.endsWith('/branches/ip-lists')) {
        const branch = await (await upstream(address, init)).json();
        assert.equal(branch.name, 'ip-lists');
        assert.match(branch.commit.sha, /^[a-f0-9]{40}$/);
        const compare = await (await upstream(`https://api.github.com/repos/gaoyifan/china-operator-ip/compare/${commit}...${branch.commit.sha}?per_page=1`, init)).json();
        assert.equal(compare.merge_base_commit.sha, commit);
        return Response.json({ name: 'ip-lists', commit: { sha: commit } });
      }
      return upstream(address.replace(/\/releases\/latest$/, `/releases/tags/${tag}`), init);
    };
    const config = baselineConfiguration(false); config.target.branch = target;
    // The isolated application clock supplies candidate age; upstream bytes,
    // Git history, reference transactions and HTTPS delivery are all real.
    let revision = 1, now = '2026-09-01T00:00:00.000Z';
    const context: RulesContext = { repository, targetBranch: target, allowWrites: true, binary, token, fetch: sourceFetch,
      now: () => new Date(now),
      readConfiguration: async () => ({ revision: String(revision).padStart(40, '0'), origin: 'isolated-github-cleanup-probe', content: stringify(config) }),
      cleanup: { refs, baseline: { ...baseline, async stage(ref, parent, files, message) {
        const match = /^maintenance-([a-f0-9-]{36})-(?:files|metadata|evidence|journal)$/.exec(ref); assert.ok(match);
        const snapshot = await repository.snapshot();
        const state = parseRulesJournal((await snapshot.read(RULE_STATE_PATH))!);
        assert.equal(state.targetBranch, target); assert.equal(state.cleanupRun?.id, match[1]);
        runIds.add(match[1]);
        if (stageInterrupted && ref.endsWith('-journal')) throw new Error('Injected journal stage interruption');
        const staged = await baseline.stage(ref, parent, files, message);
        ownedHeads.set(branchRef(ref), staged);
        return staged;
      } } },
    };
    const input = { context };
    const currentOf = (result: RulesResult, id: string) => {
      const current = result.results.find(rule => rule.id === id)?.current;
      assert.ok(current, `Missing current ${id}: ${result.status}`); return current;
    };
    const check = async (label: string, operation: () => Promise<RulesResult>) => {
      let result!: RulesResult;
      for (let attempt = 1; attempt <= 3; attempt++) {
        result = await operation(); observations.push({ label, attempt, result });
        if (result.status === 'success') break;
        const errors = [result.error, ...result.results.filter(rule => ['failed', 'pending'].includes(rule.status)).map(rule => rule.error)].filter(Boolean);
        const transient = /fetch failed|timeout|HTTP 5\d\d|HTTP 404|HTTP 422.*(?:taking too long|try again)|committed HTTPS readback differs/i;
        if (!errors.length || !errors.every(error => transient.test(error!)) || attempt === 3) break;
        console.log(`${label}: transient failure, retrying public operation (${attempt})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      assert.equal(result.status, 'success', JSON.stringify(result));
      console.log(`${label}: ${result.status}`); return result;
    };
    const ancestorHeads = async (start: string) => {
      const result = new Set<string>();
      const visit = async (head: string) => {
        if (result.has(head)) return; result.add(head);
        const commit = await api(`git/commits/${head}`);
        for (const parent of commit.parents) await visit(parent.sha);
      };
      await visit(start); return result;
    };
    const first = await check('publish-four-expired', () => syncRules(input));
    const expired = currentOf(first, 'openai'), expiredCidr = currentOf(first, 'china-ip');
    const pinned = currentOf(first, 'anthropic'), protectedCurrent = currentOf(first, 'google-deepmind');
    await check('pin-old-anthropic', () => pinRuleVersion({ ...input, id: 'anthropic', version: pinned.versionId! }));
    config.ruleSets[0] = { ...config.ruleSets[0], list: 'anthropic' }; revision++; now = '2026-10-17T00:00:00.000Z';
    commit = updatedCommit;
    const boundaryResult = await check('publish-boundary', () => syncRules(input));
    const boundary = currentOf(boundaryResult, 'openai'), cidr = currentOf(boundaryResult, 'china-ip');
    config.ruleSets[0] = { ...config.ruleSets[0], list: 'google-deepmind' }; revision++; now = '2026-11-01T00:00:00.000Z';
    const recent = currentOf(await check('publish-recent', () => syncRules(input)), 'openai');
    config.ruleSets[0] = { ...config.ruleSets[0], list: 'anthropic' }; revision++; now = '2026-11-16T00:00:00.000Z'; tag = updatedTag;
    const current = currentOf(await check('publish-current', () => syncRules(input)), 'openai');
    assert.notEqual(current.candidateId, boundary.candidateId);
    const retained = [pinned, protectedCurrent, boundary, recent, current, cidr];
    const beforeCleanup = await repository.snapshot();
    const oldHistory = await ancestorHeads(beforeCleanup.head);
    const originalJournal = parseRulesJournal((await beforeCleanup.read(RULE_STATE_PATH))!);
    let expectedStatus = await getRulesStatus(input); assert.equal(expectedStatus.status, 'success');
    const stableBytes = new Map(await Promise.all(filePaths(beforeCleanup.paths).filter(path => path.startsWith('stable/') && !path.endsWith('/activation.json'))
      .map(async path => [path, await beforeCleanup.read(path)] as const)));
    const sourceCount = requests.length;
    const preview = await check('cleanup-preview', () => cleanupRuleHistory({ ...input, dryRun: true }));
    assert.equal(preview.cleanup?.plan.cutoff, '2026-10-17T00:00:00.000Z');
    assert.deepEqual(new Set(preview.cleanup?.plan.discard.candidateIds), new Set([expired.candidateId, expiredCidr.candidateId]));
    assert.deepEqual(new Set(preview.cleanup?.plan.retain.candidateIds), new Set(retained.map(x => x.candidateId)));
    assert.equal((await repository.snapshot()).head, beforeCleanup.head);
    stageInterrupted = true;
    const interrupted = await cleanupRuleHistory(input); observations.push({ label: 'stage-interrupted', result: interrupted });
    assert.equal(interrupted.status, 'pending', JSON.stringify(interrupted)); assert.match(interrupted.error!, /Injected journal stage interruption/);
    assert.equal(interrupted.cleanup?.continueWith, 'cleanup');
    const maintenanceId = interrupted.cleanup?.maintenanceId; assert.ok(maintenanceId);
    stageInterrupted = false; rejectSwitch = true;
    const rejected = await cleanupRuleHistory(input); observations.push({ label: 'switch-interrupted', result: rejected });
    assert.equal(rejected.status, 'pending', JSON.stringify(rejected)); assert.match(rejected.error!, /Injected atomic switch interruption/);
    assert.equal(rejected.cleanup?.maintenanceId, maintenanceId); assert.equal(switchCount, 0);
    rejectSwitch = false; loseReply = true; stableOffline = true;
    const readbackFailed = await cleanupRuleHistory(input); observations.push({ label: 'stable-readback-failed', result: readbackFailed });
    assert.equal(readbackFailed.status, 'pending', JSON.stringify(readbackFailed)); assert.match(readbackFailed.error!, /Injected stable HTTPS readback outage/);
    assert.equal(readbackFailed.cleanup?.maintenanceId, maintenanceId); assert.equal(switchCount, 1);
    stableOffline = false;
    const cleaned = await check('cleanup-recovered', () => cleanupRuleHistory({ context: { ...context } }));
    assert.equal(cleaned.cleanup?.phase, 'completed'); assert.equal(cleaned.cleanup?.maintenanceId, maintenanceId);
    assert.equal(requests.length, sourceCount); assert.equal(switchCount, 1);
    const afterCleanup = await repository.snapshot(), newHistory = await ancestorHeads(afterCleanup.head);
    assert.ok([...newHistory].every(head => !oldHistory.has(head)), 'Managed history still reaches the old root');
    assert.ok(newHistory.size < oldHistory.size);
    oldHistory.forEach(head => blockedHeads.add(head));
    const readBytes = async (url: string, expected?: Buffer) => {
      const bytes = await repository.download(url);
      if (expected) assert.deepEqual(bytes, expected);
      readbacks.push({ url, sha256: sha256(bytes), byteLength: bytes.length, at: new Date().toISOString() });
      return bytes;
    };
    const verifyRetained = async (expectedVersions = retained) => {
      const snapshot = await repository.snapshot();
      const journal = parseRulesJournal((await snapshot.read(RULE_STATE_PATH))!);
      const status = await getRulesStatus({ context: { ...context } }); observations.push({ label: 'status-after-cleanup', status });
      assert.equal(status.status, 'success', JSON.stringify(status)); assert.equal(status.rules?.length, 4);
      for (const expected of expectedStatus.rules!) {
        const actual: RuleStatus = status.rules!.find(rule => rule.id === expected.id)!;
        const { candidateEvidenceUrl: oldAddress, ...oldIdentity } = expected.current!;
        const { candidateEvidenceUrl: newAddress, ...newIdentity } = actual.current!;
        assert.deepEqual(newIdentity, oldIdentity); assert.deepEqual(actual.control, expected.control);
        assert.notEqual(newAddress, oldAddress);
        assert.equal(newAddress, journal.candidates[actual.current!.candidateId].evidenceUrl);
        const path = `${journal.rules[expected.id].definition.stablePath}/activation.json`;
        await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`, (await snapshot.read(path))!);
      }
      for (const version of expectedVersions) {
        const candidate = journal.candidates[version.candidateId]; assert.ok(candidate);
        assert.equal(candidate.versionId, version.versionId); assert.equal(candidate.publishedAt, version.publishedAt);
        assert.deepEqual(candidate.source, version.source);
        assert.notEqual(candidate.evidenceUrl, originalJournal.candidates[candidate.id].evidenceUrl);
        assert.ok(status.rules!.find(rule => rule.id === version.logicalId)!.candidates.some(x => x.versionId === version.versionId && x.selectable));
        for (const file of candidateFiles(candidate.definition)) {
          const path = `candidates/${candidate.id}/${file}`;
          await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`, (await snapshot.read(path))!);
        }
      }
      assert.ok(!journal.candidates[expired.candidateId]); assert.ok(!journal.candidates[expiredCidr.candidateId]);
      return snapshot;
    };
    await verifyRetained();
    for (const [path, bytes] of stableBytes) await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${afterCleanup.head}/${path}`, bytes!);
    const selected = await check('pin-retained-boundary', () => pinRuleVersion({ ...input, id: 'openai', version: boundary.versionId! }));
    assert.equal(currentOf(selected, 'openai').versionId, boundary.versionId);
    assert.equal(currentOf(selected, 'openai').publishedAt, boundary.publishedAt);
    expectedStatus = await getRulesStatus(input); assert.equal(expectedStatus.status, 'success');
    const secondBefore = await repository.snapshot();
    const secondBytes = new Map(await Promise.all(filePaths(secondBefore.paths).filter(path => path.startsWith('stable/') && !path.endsWith('/activation.json'))
      .map(async path => [path, await secondBefore.read(path)] as const)));
    const secondHistory = await ancestorHeads(secondBefore.head); now = '2026-12-02T00:00:00.000Z';
    const secondCleanup = await check('cleanup-second-round', () => cleanupRuleHistory(input));
    assert.equal(switchCount, 2);
    assert.deepEqual(secondCleanup.cleanup?.plan.discard.candidateIds, [recent.candidateId]);
    secondHistory.forEach(head => blockedHeads.add(head));
    const second = await verifyRetained(retained.filter(version => version.candidateId !== recent.candidateId));
    assert.equal(parseRulesJournal((await second.read(RULE_STATE_PATH))!).candidates[recent.candidateId], undefined);
    for (const [path, bytes] of secondBytes) await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${second.head}/${path}`, bytes!);
    const chosenCidr = await check('pin-retained-cidr', () => pinRuleVersion({ ...input, id: 'china-ip', version: cidr.versionId! }));
    const cidrSource = currentOf(chosenCidr, 'china-ip').source;
    assert.ok('commit' in cidrSource); assert.equal(cidrSource.commit, updatedCommit);
    assert.equal(requests.length, sourceCount);
    observations.push({ label: 'history', before: beforeCleanup.head, after: afterCleanup.head,
      oldReachableCommits: [...oldHistory], newReachableCommits: [...newHistory], sourceCalls: requests.length });
    passed = true;
  } catch (error) { failures.push(String(error)); throw error; }
});
