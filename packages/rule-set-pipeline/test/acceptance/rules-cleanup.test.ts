import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { stringify } from 'yaml';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, ghJson } from '../../src/publication.js';
import { githubRulesRepository } from '../../src/rules-repository.js';
import { githubBaselineTransport } from '../../src/maintenance-baseline-transport.js';
import { branchRef, gitMaintenanceRefs, type RefChange } from '../../src/maintenance-refs.js';
import type { RulesContext } from '../../src/rules-context.js';
import { parseRulesJournal, RULE_STATE_PATH, type RulesResult } from '../../src/rules-model.js';
import { syncRules, pinRuleVersion } from '../../src/rules-operations.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { sha256 } from '../../src/release.js';

test('GitHub 隔离清理：窗口内候选可查可 pin，真实历史切换且生产 refs/开关不变', {
  skip: process.env.RULE_CLEANUP_PROBE !== '1', timeout: 1_200_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY; assert.ok(binary);
  const token = process.env.GH_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const target = `acceptance-issue-85-${randomUUID()}`;
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
    let error: unknown;
    try { await rawRefs.update(changes); } catch (caught) { error = caught; }
    const after = new Map((await rawRefs.list()).map(({ ref, head }) => [ref, head]));
    for (const { ref, after: intended } of changes) {
      if (after.get(ref) !== intended) continue;
      if (intended) ownedHeads.set(ref, intended); else ownedHeads.delete(ref);
    }
    observations.push({ label: 'ref-transaction', changes, observed: changes.map(({ ref }) => ({ ref, head: after.get(ref) })), error: error && String(error) });
    if (error) throw error;
  } };
  const production = async () => ({
    main: (await api('git/ref/heads/main')).object.sha,
    candidates: (await api('git/ref/heads/candidates')).object.sha,
    variables: await ghJson(['api', 'repos/wangyingang/sing-box-config-manager/actions/variables']),
  });
  const before = await production();
  let passed = false;
  t.after(async () => {
    const live = await rawRefs.list();
    const owned = live.filter(({ ref, head }) => allowedRef(ref) && ownedHeads.get(ref) === head);
    if (owned.length) await refs.update(owned.map(({ ref, head }) => ({ ref, before: head })));
    const remaining = (await rawRefs.list()).filter(({ ref }) => allowedRef(ref));
    const after = await production();
    const evidence = { target, runIds: [...runIds], before, after, observations, failures, passed,
      removedRefs: owned.map(({ ref }) => ref), remaining, at: new Date().toISOString() };
    if (process.env.RULE_CLEANUP_EVIDENCE) await writeFile(process.env.RULE_CLEANUP_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    assert.deepEqual(after, before, 'Production refs or Actions variables changed');
    assert.deepEqual(remaining, [], 'Probe left temporary references with an unknown head');
    console.log(JSON.stringify({ target, runIds: [...runIds], passed, cleaned: true, productionUnchanged: true }));
  });
  try {
    assert.ok(!(await rawRefs.list()).some(({ ref }) => ref === branchRef(target)));
    const head = await createGitCommit(api, { 'README.md': Buffer.from(`Issue 85 isolated cleanup probe ${target}\n`) }, '隔离候选保留与清理验收');
    await api('git/refs', { ref: branchRef(target), sha: head });
    const repository = githubRulesRepository(target, request);
    const download = repository.download;
    repository.download = async url => {
      try { return await download(url); }
      catch (error) { if (error instanceof TypeError) return download(url); throw error; }
    };
    const baseline = githubBaselineTransport(request);
    const sourceCache = new Map<string, Response>();
    let sourceCalls = 0;
    const sourceFetch: typeof fetch = async (url, init) => {
      sourceCalls++;
      const address = String(url).replace(/\/releases\/latest$/, '/releases/tags/20261104112839');
      const cached = sourceCache.get(address); if (cached) return cached.clone();
      const endpoint = new URL(address); assert.equal(endpoint.origin, 'https://api.github.com');
      const accept = new Headers(init?.headers).get('Accept') ?? 'application/vnd.github+json';
      const { stdout } = await promisify(execFile)('gh', ['api', '-H', `Accept: ${accept}`, endpoint.pathname.slice(1)],
        { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
      const response = new Response(new Uint8Array(stdout)); sourceCache.set(address, response.clone()); return response;
    };
    const official = parseBuildConfiguration(readOfficialConfiguration());
    const config = { ...official, sources: { dlc: official.sources.dlc }, ruleSets: official.ruleSets.filter(rule => rule.id === 'openai') };
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
        const staged = await baseline.stage(ref, parent, files, message);
        ownedHeads.set(branchRef(ref), staged);
        return staged;
      } } },
    };
    const input = { context };
    const check = async (label: string, operation: Promise<RulesResult>) => {
      const result = await operation; observations.push({ label, result });
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
    const expired = (await check('publish-expired', syncRules(input))).results[0].current!;
    config.ruleSets[0] = { ...config.ruleSets[0], list: 'anthropic' }; revision++; now = '2026-11-01T00:00:00.000Z';
    const retained = (await check('publish-retained', syncRules(input))).results[0].current!;
    config.ruleSets[0] = { ...config.ruleSets[0], list: 'google-deepmind' }; revision++; now = '2026-11-16T00:00:00.000Z';
    const current = (await check('publish-current', syncRules(input))).results[0].current!;
    const beforeCleanup = await repository.snapshot();
    const oldHistory = await ancestorHeads(beforeCleanup.head);
    const sourceCount = sourceCalls;
    const preview = await check('cleanup-preview', cleanupRuleHistory({ ...input, dryRun: true }));
    assert.deepEqual(preview.cleanup?.plan.discard.candidateIds, [expired.candidateId]);
    assert.deepEqual(new Set(preview.cleanup?.plan.retain.candidateIds), new Set([retained.candidateId, current.candidateId]));
    assert.equal((await repository.snapshot()).head, beforeCleanup.head);
    const cleaned = await check('cleanup', cleanupRuleHistory(input));
    assert.equal(cleaned.cleanup?.phase, 'completed'); assert.equal(sourceCalls, sourceCount);
    const afterCleanup = await repository.snapshot(), newHistory = await ancestorHeads(afterCleanup.head);
    assert.ok([...newHistory].every(head => !oldHistory.has(head)), 'Managed history still reaches the old root');
    assert.ok(newHistory.size < oldHistory.size);
    assert.ok(!afterCleanup.paths.some(path => path.startsWith(`candidates/${expired.candidateId}/`)));
    const status = await getRulesStatus(input); observations.push({ label: 'status-after-cleanup', status });
    assert.equal(status.status, 'success', JSON.stringify(status));
    assert.equal(status.rules?.[0].current?.candidateId, current.candidateId);
    assert.deepEqual(new Set(status.rules?.[0].candidates.map(candidate => candidate.versionId)), new Set([retained.versionId, current.versionId]));
    assert.ok(status.rules?.[0].candidates.every(candidate => candidate.selectable));
    for (const [path, evidence] of Object.entries(current.files)) {
      const bytes = await repository.download(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${afterCleanup.head}/${path}`);
      assert.equal(sha256(bytes), evidence.sha256); assert.equal(bytes.length, evidence.byteLength);
    }
    const pinned = await check('pin-retained', pinRuleVersion({ ...input, id: 'openai', version: retained.versionId! }));
    assert.equal(pinned.results[0].current?.versionId, retained.versionId);
    assert.equal(pinned.results[0].current?.publishedAt, retained.publishedAt);
    assert.equal(sourceCalls, sourceCount);
    observations.push({ label: 'history', before: beforeCleanup.head, after: afterCleanup.head,
      oldReachableCommits: [...oldHistory], newReachableCommits: [...newHistory], sourceCalls });
    passed = true;
  } catch (error) { failures.push(String(error)); throw error; }
});
