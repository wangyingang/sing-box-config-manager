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
import type { RulesContext } from '../../src/rules-context.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { sha256 } from '../../src/release.js';

/** One real Git/HTTPS lifecycle; only upstream discovery and config commits are pinned. */
test('GitHub 隔离分支：新增→换列表→pin→resume→删除，生产 refs/开关不变', {
  skip: process.env.RULE_OPERATIONS_PROBE !== '1', timeout: 1_200_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY;
  assert.ok(binary);
  const token = process.env.GH_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const target = `acceptance-issue-84-${randomUUID()}`;
  const immutable = new Map<string, Promise<any>>();
  const request: typeof ghJson = async (args, input) => {
    const endpoint = args[1]; const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    if (method !== 'GET' && endpoint.includes('/git/refs/heads/')) assert.ok(endpoint.endsWith(`/git/refs/heads/${target}`));
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
    if (cacheable) immutable.set(endpoint, call);
    return call;
  };
  const api = (path: string, input?: unknown, method = 'POST') => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`, '--method', method, '--input', '-'], input);
  const production = async () => ({
    main: (await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/ref/heads/main`])).object.sha,
    candidates: (await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/ref/heads/candidates`])).object.sha,
    variables: await ghJson(['api', 'repos/wangyingang/sing-box-config-manager/actions/variables']),
  });
  const before = await production();
  const observations: unknown[] = [];
  let created = false;
  t.after(async () => {
    if (created) await api(`git/refs/heads/${target}`, undefined, 'DELETE');
    const after = await production(); assert.deepEqual(after, before);
    const evidence = { target, before, after, observations, cleaned: created, at: new Date().toISOString() };
    if (process.env.RULE_OPERATIONS_EVIDENCE) await writeFile(process.env.RULE_OPERATIONS_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ target, cleaned: created, productionUnchanged: true }));
  });
  const head = await createGitCommit((path, input) => api(path, input), { 'README.md': Buffer.from(`Issue 84 isolated probe ${target}\n`) }, '隔离规则操作验收');
  await api('git/refs', { ref: `refs/heads/${target}`, sha: head }); created = true;
  const repository = githubRulesRepository(target, request);
  const download = repository.download;
  repository.download = async url => {
    try { return await download(url); }
    catch (error) { if (error instanceof TypeError) return download(url); throw error; }
  };
  const sources = new Map<string, Response>();
  const sourceFetch: typeof fetch = async (url, init) => {
    const address = String(url).replace(/\/releases\/latest$/, '/releases/tags/20261104112839');
    const cached = sources.get(address); if (cached) return cached.clone();
    const endpoint = new URL(address);
    assert.equal(endpoint.origin, 'https://api.github.com');
    const accept = new Headers(init?.headers).get('Accept') ?? 'application/vnd.github+json';
    // gh follows authenticated Release asset redirects reliably in this host.
    const { stdout } = await promisify(execFile)('gh', ['api', '-H', `Accept: ${accept}`, endpoint.pathname.slice(1)],
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
    const response = new Response(new Uint8Array(stdout));
    sources.set(address, response.clone());
    return response;
  };
  const official = parseBuildConfiguration(readOfficialConfiguration());
  let config = { ...official, sources: { dlc: official.sources.dlc }, ruleSets: official.ruleSets.filter(rule => rule.id === 'openai') };
  let revision = 1;
  const context: RulesContext = { repository, targetBranch: target, allowWrites: true, binary, token,
    readConfiguration: async () => ({ revision: String(revision).padStart(40, '0'), origin: 'isolated-github-probe', content: stringify(config) }),
    fetch: sourceFetch,
  };
  const input = { context };
  async function check(label: string, operation: Promise<Awaited<ReturnType<typeof syncRules>>>) {
    const result = await operation; observations.push({ label, result });
    assert.equal(result.status, 'success', JSON.stringify(result));
    const status = await getRulesStatus(input); assert.equal(status.status, 'success', JSON.stringify(status));
    observations.push({ label, status });
    // Verify stable bytes at this exact containing commit over HTTPS.
    const snapshot = await repository.snapshot();
    for (const rule of status.rules ?? []) for (const [path, evidence] of Object.entries(rule.current?.files ?? {})) {
      const bytes = await repository.download(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${snapshot.head}/${path}`);
      assert.equal(sha256(bytes), evidence.sha256); assert.equal(bytes.length, evidence.byteLength);
    }
    console.log(`${label}: ${result.status}`); return result;
  }
  const first = await check('add', syncRules(input)); const original = first.results[0].current!.versionId!;
  config.ruleSets[0] = { ...config.ruleSets[0], list: 'anthropic' }; revision++;
  const changed = await check('change-list', syncRules(input));
  assert.notEqual(changed.results[0].current!.versionId, original);
  await check('pin', pinRuleVersion({ ...input, id: 'openai', version: original }));
  await check('resume', resumeRuleUpdates({ ...input, id: 'openai' }));
  config = { ...config, ruleSets: [], sources: {} as typeof config.sources }; revision++;
  await check('delete', syncRules(input));
  const final = await repository.snapshot(); assert.ok(!final.paths.some(path => /^(stable|candidates)\//.test(path)));
});
