import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { stringify } from 'yaml';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, ghJson } from '../../src/publication.js';
import { githubRulesRepository } from '../../src/rules-repository.js';
import type { RulesContext } from '../../src/rules-context.js';
import type { RuleDelivery, RulesResult } from '../../src/rules-model.js';
import { candidateFiles } from '../../src/candidate-publication.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { sha256 } from '../../src/release.js';

const originalTag = '20261104112839', updatedTag = '20261108011013';
const originalCommit = 'f162630c8cdad6ced5ef59e606cc93919123ac57';
const updatedCommit = '62bc1fc8b015bece77271b568e10d6337915bc96';

/** Only discovery is pinned. Source bytes, Git writes and HTTPS readback are real. */
test('GitHub 四集双来源：新增、独立更新、换源、逐集 pin/resume、删除，生产 refs/开关不变', {
  skip: process.env.RULE_OPERATIONS_PROBE !== '1', timeout: 2_400_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY, evidencePath = process.env.RULE_OPERATIONS_EVIDENCE;
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY');
  assert.ok(evidencePath, 'Set RULE_OPERATIONS_EVIDENCE to a new file');
  const exec = promisify(execFile);
  const token = process.env.GH_TOKEN ?? (await exec('gh', ['auth', 'token'])).stdout.trim();
  const target = `acceptance-issue-96-${randomUUID()}`;
  assert.match(target, /^acceptance-issue-96-[a-f0-9-]+$/);
  const sourceIdentity = { commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    status: (await exec('git', ['status', '--porcelain'])).stdout,
    diffSha256: sha256((await exec('git', ['diff', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 })).stdout),
    probeSha256: sha256(await readFile(new URL(import.meta.url))), binary,
    command: 'RULE_OPERATIONS_PROBE=1 pnpm --dir packages/rule-set-pipeline test:acceptance:rules' };
  const observations: unknown[] = [], requests: string[] = [], readbacks: unknown[] = [];
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
      if (!response.ok) throw new GitHubHttpError(response.status, `${method} ${endpoint}: HTTP ${response.status}`);
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
      before, after, observations, requests, readbacks, created, remaining, cleanupErrors }, null, 2) + '\n');
    assert.deepEqual(cleanupErrors, []); assert.deepEqual(remaining, []); assert.deepEqual(after, before);
    console.log(JSON.stringify({ target, cleaned: true, productionUnchanged: true, evidencePath }));
  });
  const head = await createGitCommit((path, input) => api(path, input), { 'README.md': Buffer.from(`Issue 96 isolated probe ${target}\n`) }, '隔离四集交付验收');
  await api('git/refs', { ref: `refs/heads/${target}`, sha: head }); created = true;
  const repository = githubRulesRepository(target, request);
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
  const context: RulesContext = { repository, targetBranch: target, allowWrites: true, binary, token,
    readConfiguration: async () => ({ revision: String(revision).padStart(40, '0'), origin: 'isolated-github-probe', content: stringify(config) }),
    fetch: sourceFetch,
  };
  const input = { context };
  const stableBytes = new Map<string, Buffer>();
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
  async function check(label: string, operation: () => Promise<RulesResult>, onlyId?: string) {
    const prior = await getRulesStatus(input); assert.equal(prior.status, 'success', JSON.stringify(prior));
    const oldHead = (await repository.snapshot()).head;
    const result = await operation(); observations.push({ label, result });
    assert.equal(result.status, 'success', JSON.stringify(result));
    // New context/session, not a local success index.
    const status = await getRulesStatus({ context: { ...context } }); assert.equal(status.status, 'success', JSON.stringify(status));
    observations.push({ label, status });
    const snapshot = await repository.snapshot();
    for (const rule of status.rules ?? []) {
      for (const [path, expected] of Object.entries(rule.current?.files ?? {})) {
        const immutableBytes = await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`, expected);
        assert.deepEqual(await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${path}`, expected), immutableBytes);
        stableBytes.set(`${rule.current!.versionId}/${path}`, immutableBytes);
      }
      if (onlyId && rule.id !== onlyId) {
        assert.deepEqual(rule.current, prior.rules?.find(x => x.id === rule.id)?.current);
        for (const path of [...Object.keys(rule.current!.files), `${config.ruleSets.find(x => x.id === rule.id)!.stablePath}/activation.json`]) {
          assert.deepEqual(await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`),
            await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${oldHead}/${path}`));
        }
      }
    }
    console.log(`${label}: ${result.status}`); return result;
  }
  async function inspectCandidate(current: RuleDelivery, expectedCount?: number) {
    const prefix = current.candidateEvidenceUrl.replace(/readback.json$/, '');
    const retained = await repository.snapshot();
    const readback = JSON.parse((await readBytes(current.candidateEvidenceUrl)).toString());
    assert.equal(readback.status, 'remote-verified'); assert.equal(readback.native.status, 'passed');
    assert.equal(readback.candidateId, current.candidateId); assert.equal(readback.versionId, current.versionId);
    const files = [];
    for (const file of candidateFiles(config.ruleSets.find(x => x.id === current.logicalId))) {
      const bytes = await retained.read(`candidates/${current.candidateId}/${file}`); assert.ok(bytes);
      const observed = await readBytes(prefix + file, { sha256: sha256(bytes), byteLength: bytes.length });
      for (const entry of readback.readback.filter((x: { url: string }) => x.url.endsWith('/' + file))) {
        assert.deepEqual(await readBytes(entry.url, entry), observed);
      }
      files.push({ file, sha256: sha256(bytes), byteLength: bytes.length });
    }
    assert.equal(readback.readback.length, 6);
    const manifest = JSON.parse((await readBytes(prefix + 'manifest.json')).toString());
    const report = JSON.parse((await readBytes(prefix + 'conversion-report.json')).toString());
    const build = JSON.parse((await readBytes(prefix + 'build.json')).toString());
    assert.equal(manifest.id, current.logicalId); assert.equal(manifest.targetVersion, '1.14.4'); assert.equal(manifest.sourceFormatVersion, 4);
    assert.equal(build.id, current.logicalId); assert.deepEqual(build.source, current.source); assert.equal(build.validation.status, 'passed');
    assert.deepEqual(build.source, JSON.parse((await readBytes(prefix + 'source.json')).toString()));
    if (expectedCount !== undefined) assert.equal(report.inputCount, expectedCount);
    assert.deepEqual(manifest.artifacts.map((x: { format: string }) => x.format), ['source', 'binary']);
    assert.deepEqual(manifest.projections.route, manifest.projections[current.logicalId === 'china-ip' ? 'dns-response' : 'dns-query']);
    assert.deepEqual(manifest.projections[current.logicalId === 'china-ip' ? 'dns-query' : 'dns-response'], { unavailable: 'empty' });
    for (const artifact of manifest.artifacts) {
      await readBytes(artifact.url, artifact); assert.equal(artifact.termCount, report.outputTermCount); assert.deepEqual(artifact.requiredCapabilities, []);
    }
    observations.push({ candidate: current.candidateId, source: current.source, manifest, report, build, readback, files });
  }
  const first = await check('add-four', () => syncRules(input));
  assert.deepEqual(first.results.map(x => [x.id, x.status]), ['openai', 'anthropic', 'google-deepmind', 'china-ip'].map(id => [id, 'delivered']));
  for (const [i, entry] of first.results.entries()) {
    const source = entry.current!.source;
    if (i < 3) { assert.ok('tag' in source); assert.equal(source.tag, originalTag); } else assert.equal(source.commit, originalCommit);
    await inspectCandidate(entry.current!, [25, 19, 49][i]);
  }
  const domainSource = first.results[0].current!.source;
  assert.ok('yaml' in domainSource);
  for (const suffix of ['/latest', `/assets/${domainSource.yaml.id}`, `/assets/${domainSource.checksum.id}`, '/branches/ip-lists', '/china46.txt']) {
    assert.equal(requests.filter(url => url.endsWith(suffix)).length, 1, suffix);
  }
  commit = updatedCommit;
  const cidr = await check('cidr-only', () => syncRules(input), 'china-ip');
  assert.deepEqual(cidr.results.map(x => x.status), ['unchanged', 'unchanged', 'unchanged', 'delivered']);
  assert.equal(cidr.results[3].current?.source.commit, updatedCommit);
  tag = updatedTag;
  const updated = await check('release-update', () => syncRules(input));
  assert.deepEqual(updated.results.map(x => x.status), ['unchanged', 'delivered', 'unchanged', 'unchanged']);
  for (const id of ['openai', 'anthropic', 'google-deepmind', 'china-ip']) {
    const original = first.results.find(x => x.id === id)!.current!;
    if (id !== 'china-ip') {
      config.ruleSets.find(x => x.id === id)!.list = id === 'openai' ? 'anthropic' : 'openai'; revision++;
      await check(`change-list-${id}`, () => syncRules(input), id);
    }
    const pin = await check(`pin-${id}`, () => pinRuleVersion({ ...input, id, version: original.versionId! }), id);
    assert.equal(pin.results[0].control?.mode, 'pinned'); assert.deepEqual(pin.results[0].current?.files, original.files);
    for (const path of Object.keys(original.files)) assert.deepEqual(await readBytes(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${path}`, original.files[path]), stableBytes.get(`${original.versionId}/${path}`));
    const start = requests.length;
    const pinned = await check(`pinned-sync-${id}`, () => syncRules(input));
    assert.equal(pinned.results.find(x => x.id === id)?.status, 'pinned-skipped');
    if (id === 'china-ip') assert.ok(requests.slice(start).every(url => !url.includes('gaoyifan/')));
    const resumed = await check(`resume-${id}`, () => resumeRuleUpdates({ ...input, id }), id);
    assert.equal(resumed.results[0].control?.mode, 'auto'); assert.notEqual(resumed.results[0].current?.versionId, original.versionId);
    // Historical candidate evidence and immutable artifact bytes remain readable.
    await inspectCandidate(original);
  }
  // Preserve the single-publication probe's independent fixed identity/SHA assertion
  // through the current operation, using a real source/list change on one rule.
  tag = '20261102130044'; config.ruleSets[0].list = 'category-ai-!cn'; revision++;
  const sample = await check('fixed-original-sample', () => syncRules(input));
  assert.deepEqual(sample.results.find(x => x.id === 'openai')!.current!.source,
    JSON.parse(await readFile(new URL('../fixtures/20261102130044.source.json', import.meta.url), 'utf8')));
  await inspectCandidate(sample.results.find(x => x.id === 'openai')!.current!, 214);
  const beforeUnchanged = (await repository.snapshot()).head;
  const unchanged = await check('same-input', () => syncRules(input));
  assert.ok(unchanged.results.every(x => x.status === 'unchanged')); assert.equal((await repository.snapshot()).head, beforeUnchanged);
  config.ruleSets = []; config.sources = {}; revision++;
  await check('delete-all', () => syncRules(input));
  const final = await repository.snapshot(); assert.ok(!final.paths.some(path => /^(stable|candidates)\//.test(path)));
});
