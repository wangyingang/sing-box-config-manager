import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactManifestSchema } from '../../../config-compiler/src/index.js';
import { NATIVE_VALIDATION_POLICY } from '../../src/native.js';
import test from 'node:test';
import { stringify } from 'yaml';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, ghJson } from '../../src/publication.js';
import { githubRulesRepository } from '../../src/rules-repository.js';
import type { RulesContext } from '../../src/rules-context.js';
import type { RuleDelivery, RulesResult } from '../../src/rules-model.js';
import { candidateFiles, RULE_READBACK_VERSION } from '../../src/candidate-publication.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { sha256 } from '../../src/release.js';
import { countNativeCommands } from '../fixtures/native-commands.js';

const originalTag = '20261104112839', updatedTag = '20261108011013';
const originalCommit = 'f162630c8cdad6ced5ef59e606cc93919123ac57';
const updatedCommit = '62bc1fc8b015bece77271b568e10d6337915bc96';

/** Only discovery is pinned. Source bytes, Git writes and HTTPS readback are real. */
test('GitHub 四集双来源：新增、独立更新、换源、逐集 pin/resume、删除，生产 refs/开关不变', {
  skip: process.env.RULE_OPERATIONS_PROBE !== '1', timeout: 3_600_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY, evidencePath = process.env.RULE_OPERATIONS_EVIDENCE;
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY');
  assert.ok(evidencePath, 'Set RULE_OPERATIONS_EVIDENCE to a new file');
  const firstOnly = process.env.RULE_OPERATIONS_FIRST_ONLY === '1';
  const exec = promisify(execFile);
  const token = process.env.GH_TOKEN ?? (await exec('gh', ['auth', 'token'])).stdout.trim();
  const target = `acceptance-issue-96-${randomUUID()}`;
  assert.match(target, /^acceptance-issue-96-[a-f0-9-]+$/);
  const sourceIdentity = { commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    status: (await exec('git', ['status', '--porcelain'])).stdout,
    diffSha256: sha256((await exec('git', ['diff', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 })).stdout),
    probeSha256: sha256(await readFile(new URL(import.meta.url))), binary, binarySha256: sha256(await readFile(binary)),
    command: `RULE_OPERATIONS_PROBE=1 ${firstOnly ? 'RULE_OPERATIONS_FIRST_ONLY=1 ' : ''}pnpm --dir packages/rule-set-pipeline test:acceptance:rules` };
  const observations: unknown[] = [], requests: string[] = [], readbacks: unknown[] = [];
  const acquisitionAttempts: { label: string; attempt: number; requests: string[] }[] = [];
  const nativeTrace = await mkdtemp(join(tmpdir(), 'rule-operations-native-'));
  t.after(async () => rm(nativeTrace, { recursive: true, force: true }));
  const tracedBinary = join(nativeTrace, 'sing-box');
  const tracePath = join(nativeTrace, 'commands');
  const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(tracedBinary, `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(tracePath)}
exec ${shellQuote(binary)} "$@"
`, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  // Reserve the evidence destination before the first remote mutation.
  await writeFile(evidencePath, JSON.stringify({ target, sourceIdentity, startedAt, status: 'started' }, null, 2) + '\n', { flag: 'wx' });
  const immutable = new Map<string, Promise<any>>();
  const request: typeof ghJson = async (args, input) => {
    const endpoint = args[1], method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    assert.ok(endpoint === `repos/${ARTIFACT_REPOSITORY}` || endpoint.startsWith(`repos/${ARTIFACT_REPOSITORY}/`));
    if (method !== 'GET') {
      assert.ok(/^repos\/[^/]+\/[^/]+\/git\/(blobs|trees|commits|refs(?:\/heads\/[^/]+)?)$/.test(endpoint), endpoint);
      if (endpoint.endsWith('/git/refs')) assert.equal((input as { ref: string }).ref, `refs/heads/${target}`);
      if (endpoint.includes('/git/refs/heads/')) assert.ok(endpoint.endsWith(`/git/refs/heads/${target}`));
    }
    const cacheable = method === 'GET' && /\/git\/(commits|trees|blobs)\/[a-f0-9]{40}(?:\?recursive=1)?$/.test(endpoint);
    if (cacheable && immutable.has(endpoint)) return immutable.get(endpoint);
    const call = (async () => {
      const response = await fetch(`https://api.github.com/${endpoint}`, { method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
      const body = await response.text();
      if (!response.ok) {
        let reason = ''; try { reason = JSON.parse(body).message ?? ''; } catch { /* Non-JSON gateway response. */ }
        throw new GitHubHttpError(response.status, `${method} ${endpoint}: HTTP ${response.status} ${reason}`);
      }
      return body ? JSON.parse(body) : null;
    })();
    if (cacheable) { immutable.set(endpoint, call); call.catch(() => immutable.delete(endpoint)); }
    return call;
  };
  const api = (path: string, input?: unknown, method = 'POST') => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`, '--method', method, '--input', '-'], input);
  const production = async () => ({
    main: (await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/ref/heads/main`])).object.sha,
    candidates: (await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/ref/heads/candidates`])).object.sha,
    variables: (await ghJson(['api', 'repos/wangyingang/sing-box-config-manager/actions/variables'])).variables
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
  });
  const before = await production();
  const checkpoint = async (status: string) => writeFile(evidencePath, JSON.stringify({ target, sourceIdentity, startedAt,
    status, before, observations, requests, acquisitionAttempts, readbacks }, null, 2) + '\n');
  await checkpoint('production-snapshotted');
  let created = false;
  t.after(async () => {
    const cleanupErrors: string[] = [];
    // A lost create-ref response can still have created the branch.
    const refs = await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/matching-refs/heads/${target}`]).catch(error => {
      cleanupErrors.push(String(error)); return [];
    });
    if (refs.some((ref: { ref: string }) => ref.ref === `refs/heads/${target}`)) {
      await api(`git/refs/heads/${target}`, undefined, 'DELETE').catch(error => cleanupErrors.push(String(error)));
    }
    const remaining = await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/matching-refs/heads/${target}`]).catch(error => {
      cleanupErrors.push(String(error)); return null;
    });
    const after = await production().catch(error => { cleanupErrors.push(String(error)); return null; });
    await writeFile(evidencePath, JSON.stringify({ target, sourceIdentity, startedAt, endedAt: new Date().toISOString(),
      before, after, observations, requests, acquisitionAttempts, readbacks, created, remaining, cleanupErrors }, null, 2) + '\n');
    assert.deepEqual(cleanupErrors, []); assert.deepEqual(remaining, []); assert.deepEqual(after, before);
    console.log(JSON.stringify({ target, cleaned: true, productionUnchanged: true, evidencePath }));
  });
  const head = await createGitCommit((path, input) => api(path, input), { 'README.md': Buffer.from(`Issue 96 isolated probe ${target}\n`) }, '隔离四集交付验收');
  await api('git/refs', { ref: `refs/heads/${target}`, sha: head }); created = true;
  const repository = githubRulesRepository(target, request);
  const download = repository.download;
  repository.download = async url => {
    try { return await download(url); }
    catch (error) { if (error instanceof TypeError) return download(url); throw error; }
  };
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
  const config = parseBuildConfiguration(readOfficialConfiguration()); config.target.branch = target;
  let revision = 1;
  const context: RulesContext = { repository, targetBranch: target, allowWrites: true, binary: tracedBinary, token,
    readConfiguration: async () => ({ revision: String(revision).padStart(40, '0'), origin: 'isolated-github-probe', content: stringify(config) }),
    fetch: sourceFetch,
  };
  const input = { context, onProgress: (event: { stage: string; id?: string }) => console.log(JSON.stringify(event)) };
  const stableBytes = new Map<string, Buffer>();
  let checkedStatus: Awaited<ReturnType<typeof getRulesStatus>> | undefined;
  async function readBytes(url: string, expected?: { sha256: string; byteLength: number }) {
    const deadline = Date.now() + 480_000; let attempts = 0;
    do {
      attempts++;
      const bytes = await repository.download(url).catch(() => undefined);
      if (bytes && (!expected || sha256(bytes) === expected.sha256 && bytes.length === expected.byteLength)) {
        readbacks.push({ url, sha256: sha256(bytes), byteLength: bytes.length, attempts, at: new Date().toISOString() });
        return bytes;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    throw new Error(`HTTPS failed to converge: ${url}`);
  }
  async function check(label: string, operation: () => Promise<RulesResult>, onlyId?: string, canonical = true) {
    const prior = await getRulesStatus(input); assert.equal(prior.status, 'success', JSON.stringify(prior));
    const oldHead = (await repository.snapshot()).head;
    const runAttempt = async (attempt: number) => {
      const start = requests.length;
      const result = await operation();
      acquisitionAttempts.push({ label, attempt, requests: requests.slice(start) });
      observations.push({ label, attempt, result }); return result;
    };
    let result = await runAttempt(1);
    for (let attempt = 2; result.status !== 'success' && attempt <= 3; attempt++) {
      const failures = result.results.filter(x => x.status === 'failed' || x.status === 'pending');
      const transient = /HTTP 5\d\d|HTTP 422.*(?:taking too long|try again)|fetch failed|timeout/i;
      if (!failures.length || !failures.every(x => transient.test(x.error ?? ''))) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Retry the public operation. Its normal session/heads/writeId reconciliation
      // decides what was applied; never replay a low-level ref request here.
      result = await runAttempt(attempt);
    }
    assert.equal(result.status, 'success', JSON.stringify(result));
    // New context/session, not a local success index.
    const status = await getRulesStatus({ context: { ...context } }); assert.equal(status.status, 'success', JSON.stringify(status));
    assert.deepEqual(status.readbackRequests, []);
    observations.push({ label, status }); checkedStatus = status;
    const snapshot = await repository.snapshot();
    for (const rule of status.rules ?? []) {
      for (const [path, expected] of Object.entries(rule.current?.files ?? {})) {
        const immutableBytes = await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`, expected);
        if (canonical) assert.deepEqual(await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${path}`, expected), immutableBytes);
        const key = `${rule.current!.versionId}/${path}`;
        if (!stableBytes.has(key)) stableBytes.set(key, immutableBytes);
      }
      if (onlyId && rule.id !== onlyId) {
        assert.deepEqual(rule.current, prior.rules?.find(x => x.id === rule.id)?.current);
        for (const path of [...Object.keys(rule.current!.files), `${config.ruleSets.find(x => x.id === rule.id)!.stablePath}/activation.json`]) {
          assert.deepEqual(await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`),
            await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${oldHead}/${path}`));
        }
      }
    }
    await checkpoint(`completed:${label}`);
    console.log(`${label}: ${result.status}`); return result;
  }
  async function inspectCandidate(current: RuleDelivery, expectedCount?: number, expectedList = current.logicalId) {
    const retained = await repository.snapshot();
    const prefix = `candidates/${current.candidateId}/`;
    const readGit = async (file: string) => {
      const bytes = await retained.read(prefix + file);
      assert.ok(bytes, `missing Git record: ${prefix}${file}`);
      return bytes;
    };
    const readback = JSON.parse((await readGit('readback.json')).toString());
    assert.equal(readback.schemaVersion, RULE_READBACK_VERSION);
    assert.equal(readback.status, 'remote-verified');
    assert.equal(readback.candidateId, current.candidateId); assert.equal(readback.versionId, current.versionId);
    assert.equal(readback.readback.length, 2);
    const files = [];
    for (const file of candidateFiles(config.ruleSets.find(x => x.id === current.logicalId))) {
      const bytes = await readGit(file);
      for (const entry of readback.readback.filter((x: { url: string }) => x.url.endsWith('/' + file))) {
        assert.deepEqual(await readBytes(entry.url, entry), bytes);
      }
      files.push({ file, sha256: sha256(bytes), byteLength: bytes.length });
    }
    const manifest = artifactManifestSchema.parse(JSON.parse((await readGit('manifest.json')).toString()), '');
    const report = JSON.parse((await readGit('conversion-report.json')).toString());
    const build = JSON.parse((await readGit('build.json')).toString());
    assert.equal(manifest.id, current.logicalId); assert.equal(manifest.targetVersion, '1.14.4'); assert.equal(manifest.sourceFormatVersion, 4);
    assert.equal(build.id, current.logicalId);
    assert.equal(build.definition.list, current.logicalId === 'china-ip' ? 'all' : expectedList);
    assert.deepEqual(build.source, current.source); assert.equal(build.validation.status, 'passed');
    assert.equal(build.validation.policy, NATIVE_VALIDATION_POLICY);
    assert.deepEqual(build.source, JSON.parse((await readGit('source.json')).toString()));
    if (expectedCount !== undefined) assert.equal(report.inputCount, expectedCount);
    assert.deepEqual(manifest.artifacts.map((x: { format: string }) => x.format), ['source', 'binary']);
    assert.deepEqual(manifest.projections.route, manifest.projections[current.logicalId === 'china-ip' ? 'dns-response' : 'dns-query']);
    assert.deepEqual(manifest.projections[current.logicalId === 'china-ip' ? 'dns-query' : 'dns-response'], { unavailable: 'empty' });
    for (const artifact of manifest.artifacts) {
      await readBytes(artifact.url, artifact);
      if (artifact.format === 'source') {
        assert.equal(artifact.termCount, report.outputTermCount);
        if (expectedCount !== undefined) assert.equal(artifact.termCount, expectedCount);
      } else assert.ok(!Object.hasOwn(artifact, 'termCount'));
      assert.deepEqual(artifact.requiredCapabilities, []);
    }
    observations.push({ candidate: current.candidateId, source: current.source, manifest, report, build, readback, files });
    await checkpoint(`verified-candidate:${current.logicalId}`);
  }
  assert.deepEqual((await repository.snapshot()).paths, ['README.md']);
  const empty = await getRulesStatus(input);
  assert.equal(empty.status, 'success', JSON.stringify(empty));
  assert.ok(empty.rules?.every(rule => rule.deliveryState === 'not-delivered' && rule.candidateCount === 0));
  const first = await check('add-four', () => syncRules(input));
  const nativeCommands = (await readFile(tracePath, 'utf8')).trim().split('\n');
  const nativeCounts = countNativeCommands(nativeCommands);
  observations.push({ label: 'first-delivery-native-processes', nativeCommands, nativeCounts });
  await checkpoint('first-delivery-native-processes');
  assert.equal(nativeCounts.decompile, 0);
  assert.equal(nativeCounts.compile, config.ruleSets.length);
  assert.equal(nativeCounts.sourceLoad, config.ruleSets.length);
  assert.equal(nativeCounts.binaryLoad, config.ruleSets.length);
  assert.deepEqual(first.results.map(x => x.id), ['openai', 'anthropic', 'google-deepmind', 'china-ip']);
  assert.ok(first.results.every(x => x.current && ['delivered', 'unchanged'].includes(x.status)));
  assert.deepEqual(checkedStatus?.rules?.map(x => x.candidateCount), [1, 1, 1, 1]);
  for (const [i, entry] of first.results.entries()) {
    const source = entry.current!.source;
    if (i < 3) { assert.ok('tag' in source); assert.equal(source.tag, originalTag); } else assert.equal(source.commit, originalCommit);
    await inspectCandidate(entry.current!, [25, 19, 49][i]);
  }
  if (firstOnly) return;
  const domainSource = first.results[0].current!.source;
  assert.ok('yaml' in domainSource);
  for (const suffix of ['/latest', `/assets/${domainSource.yaml.id}`, `/assets/${domainSource.checksum.id}`, '/branches/ip-lists', '/china46.txt']) {
    assert.equal(acquisitionAttempts[0].requests.filter(url => url.endsWith(suffix)).length, 1, suffix);
  }
  commit = updatedCommit;
  const cidr = await check('cidr-only', () => syncRules(input), 'china-ip');
  assert.deepEqual(cidr.results.slice(0, 3).map(x => x.status), ['unchanged', 'unchanged', 'unchanged']);
  assert.notEqual(cidr.results[3].current?.versionId, first.results[3].current?.versionId);
  assert.equal(cidr.results[3].current?.source.commit, updatedCommit);
  tag = updatedTag;
  const updated = await check('release-update', () => syncRules(input));
  assert.ok(updated.results.filter(x => x.id !== 'anthropic').every(x => x.status === 'unchanged'));
  const updatedAnthropic = updated.results.find(x => x.id === 'anthropic')!.current!;
  assert.ok('tag' in updatedAnthropic.source); assert.equal(updatedAnthropic.source.tag, updatedTag);
  assert.notEqual(updatedAnthropic.versionId, first.results[1].current?.versionId);
  const ids = ['openai', 'anthropic', 'google-deepmind', 'china-ip'];
  for (const id of ids.filter(id => id !== 'china-ip')) {
    config.ruleSets.find(x => x.id === id)!.list = id === 'openai' ? 'anthropic' : 'openai'; revision++;
    await check(`change-list-${id}`, () => syncRules(input), id, false);
  }
  const latest = new Map((await getRulesStatus(input)).rules!.map(rule => [rule.id, rule.current!]));
  async function canonicalReadback(label: string) {
    const status = await getRulesStatus(input); assert.equal(status.status, 'success', JSON.stringify(status));
    await Promise.all((status.rules ?? []).flatMap(rule => Object.entries(rule.current!.files).map(async ([path, expected]) => {
      const bytes = await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${path}`, expected);
      assert.deepEqual(bytes, stableBytes.get(`${rule.current!.versionId}/${path}`));
    })));
    observations.push({ label, status }); await checkpoint(label);
  }
  // Preserve every intermediate immutable snapshot; observe canonical URLs only
  // once all four switches settle, as in the old activation/rollback probes.
  for (const id of ids) {
    const original = first.results.find(x => x.id === id)!.current!;
    const pin = await check(`pin-${id}`, () => pinRuleVersion({ ...input, id, version: original.versionId! }), id, false);
    assert.equal(pin.results[0].control?.mode, 'pinned'); assert.equal(pin.results[0].current?.versionId, original.versionId);
    assert.deepEqual(pin.results[0].current?.files, original.files);
  }
  await canonicalReadback('canonical-all-pinned');
  const start = requests.length;
  const pinned = await check('all-pinned-sync', () => syncRules(input), undefined, false);
  assert.ok(pinned.results.every(x => x.status === 'pinned-skipped')); assert.equal(requests.length, start);
  for (const id of ids) {
    const original = first.results.find(x => x.id === id)!.current!;
    const resumed = await check(`resume-${id}`, () => resumeRuleUpdates({ ...input, id }), id, false);
    assert.equal(resumed.results[0].control?.mode, 'auto'); assert.notEqual(resumed.results[0].current?.versionId, original.versionId);
    assert.deepEqual(resumed.results[0].current?.files, latest.get(id)!.files);
    assert.deepEqual(resumed.results[0].current?.source, latest.get(id)!.source);
    await inspectCandidate(original);
  }
  await canonicalReadback('canonical-all-resumed');
  // Preserve the single-publication probe's independent fixed identity/SHA assertion
  // through the current operation, using a real source/list change on one rule.
  tag = '20261102130044'; config.ruleSets[0].list = 'category-ai-!cn'; revision++;
  const sample = await check('fixed-original-sample', () => syncRules(input));
  assert.deepEqual(sample.results.find(x => x.id === 'openai')!.current!.source,
    JSON.parse(await readFile(new URL('../fixtures/20261102130044.source.json', import.meta.url), 'utf8')));
  await inspectCandidate(sample.results.find(x => x.id === 'openai')!.current!, 214, 'category-ai-!cn');
  const beforeUnchanged = (await repository.snapshot()).head;
  const unchanged = await check('same-input', () => syncRules(input));
  assert.ok(unchanged.results.every(x => x.status === 'unchanged')); assert.equal((await repository.snapshot()).head, beforeUnchanged);
  config.ruleSets = []; config.sources = {}; revision++;
  await check('delete-all', () => syncRules(input));
  const final = await repository.snapshot(); assert.ok(!final.paths.some(path => /^(stable|candidates)\//.test(path)));
});
