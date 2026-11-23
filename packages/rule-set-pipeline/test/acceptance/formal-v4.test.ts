import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { ghJson, ARTIFACT_REPOSITORY, GitHubHttpError, immutableUrl } from '../../src/publication.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { sha256 } from '../../src/release.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import type { RulesContext } from '../../src/rules-context.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { githubRulesRepository } from '../../src/rules-repository.js';
import { getRulesStatus, readSchedulePreflight } from '../../src/rules-status.js';
import { formalSourceVerifier } from './formal-v4-sources.js';

const exec = promisify(execFile);
const positives: Record<string, string[]> = {
  openai: ['chatgpt.com'], anthropic: ['claude.ai'], 'google-deepmind': ['deepmind.google'],
  'china-ip': ['223.5.5.5'], 'chatgpt-voice': ['102.37.57.54'],
  'china-domains': ['baidu.com'], global: ['google.com'], apple: ['apple.com'],
  microsoft: ['microsoft.com'], docker: ['docker.com'], github: ['github.com'],
  google: ['google.com'], youtube: ['youtube.com'], gfw: ['google.com'],
  onedrive: ['onedrive.live.com', 'example-1drv.invalid'], stream: ['tubi.tv'],
};

test('the 16 formal v4 rule sets deliver from an empty GitHub target', {
  skip: process.env.RULE_FORMAL_V4_PROBE !== '1', timeout: 3_600_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY;
  const evidencePath = process.env.RULE_FORMAL_V4_EVIDENCE;
  assert.ok(binary && evidencePath, 'Set SING_BOX_TEST_BINARY and RULE_FORMAL_V4_EVIDENCE');
  const target = `acceptance-issue-174-${randomUUID()}`;
  const configuration = readOfficialConfiguration();
  const { ruleSets, target: configuredTarget, candidateRetentionDays } = parseBuildConfiguration(configuration);
  assert.deepEqual(ruleSets.map(rule => rule.id).sort(), Object.keys(positives).sort());
  const sha = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const worktreeStatus = (await exec('git', ['status', '--porcelain'])).stdout;
  const evidence = {
    target: { repository: ARTIFACT_REPOSITORY, branch: target }, configuredTarget, candidateRetentionDays,
    source: { sha, worktreeStatus, diffSha256: sha256((await exec('git', ['diff', 'HEAD'])).stdout), configurationSha256: sha256(configuration),
      probeSha256: sha256(await readFile(new URL(import.meta.url))) },
    binary: { sha256: sha256(await readFile(binary)), version: (await exec(binary, ['version'])).stdout.trim() },
    startedAt: new Date().toISOString(), endedAt: '',
    start: null as unknown, end: null as unknown, seed: '', finalHead: '',
    removed: false, outcomes: {} as Record<string, unknown>, rules: [] as unknown[], upstreamRequests: [] as unknown[],
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  const archive = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const local = await mkdtemp(join(tmpdir(), 'rule-formal-v4-'));
  t.after(() => rm(local, { recursive: true, force: true }));
  const token = process.env.GH_TOKEN ?? (await exec('gh', ['auth', 'token'])).stdout.trim();
  const request: typeof ghJson = async (args, input) => {
    const endpoint = args[1];
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    assert.ok(endpoint === `repos/${ARTIFACT_REPOSITORY}` || endpoint.startsWith(`repos/${ARTIFACT_REPOSITORY}/`));
    if (method !== 'GET') {
      if (endpoint.endsWith('/git/refs')) assert.equal((input as { ref: string }).ref, `refs/heads/${target}`);
      else assert.ok(endpoint.endsWith(`/refs/heads/${target}`) || /\/git\/(blobs|trees|commits)$/.test(endpoint), endpoint);
    }
    const response = await fetch(`https://api.github.com/${endpoint}`, { method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
    const body = await response.text();
    if (!response.ok) throw new GitHubHttpError(response.status, `${method} ${endpoint}: HTTP ${response.status}`);
    return body ? JSON.parse(body) : null;
  };
  const api = (path: string, input?: unknown, method = 'POST') => request(
    ['api', `repos/${ARTIFACT_REPOSITORY}/${path}`, '--method', method, ...(input === undefined ? [] : ['--input', '-'])], input);
  const refPrefix = `repos/${ARTIFACT_REPOSITORY}/git/`;
  const matching = () => request(['api', refPrefix + `matching-refs/heads/${target}`]);
  const production = async () => {
    const [main, candidates, data] = await Promise.all([
      request(['api', refPrefix + 'ref/heads/main']),
      request(['api', refPrefix + 'ref/heads/candidates']),
      ghJson(['api', 'repos/wangyingang/sing-box-config-manager/actions/variables']),
    ]);
    return { main: main.object.sha, candidates: candidates.object.sha,
      variables: data.variables.filter(({ name }: { name: string }) => ['RULE_UPDATE_ENABLED', 'RULE_CLEANUP_ENABLED'].includes(name)) };
  };

  evidence.start = await production();
  assert.deepEqual(await matching(), []);
  t.after(async () => {
    try {
      if ((await matching()).some(({ ref }: { ref: string }) => ref === `refs/heads/${target}`)) {
        await api(`git/refs/heads/${target}`, undefined, 'DELETE');
      }
      assert.deepEqual(await matching(), []);
      evidence.removed = true;
      evidence.end = await production();
      assert.deepEqual(evidence.end, evidence.start);
    } finally {
      evidence.endedAt = new Date().toISOString();
      await archive();
    }
  });
  evidence.seed = await createGitCommit(api, { 'README.md': Buffer.from(`# Isolated v4 acceptance — ${target}\n`) },
    '初始化 v4 隔离验收分支');
  await api('git/refs', { ref: `refs/heads/${target}`, sha: evidence.seed });
  const repository = githubRulesRepository(target, request);
  const context: RulesContext = {
    repository, targetBranch: target, allowWrites: true, binary, token,
    readConfiguration: async () => ({ revision: sha, content: configuration, origin: 'formal-v4-checkout' }),
    async fetch(url, init) {
      const response = await fetch(url, init);
      // Signed redirect URLs contain transient credentials. Record only the host/path.
      const address = new URL(String(url));
      evidence.upstreamRequests.push({ endpoint: address.origin + address.pathname, status: response.status });
      return response;
    },
  };
  const input = { context, onProgress: ({ stage, logicalId }: { stage: string; logicalId?: string }) => console.log(stage, logicalId ?? '') };
  const empty = await repository.snapshot();
  assert.equal(empty.head, evidence.seed);
  assert.deepEqual(empty.paths, ['README.md']);
  await archive();
  const initial = await getRulesStatus(input);
  assert.equal(initial.status, 'success', initial.error ?? '');
  assert.equal(initial.rules?.length, 16);
  assert.ok(initial.rules?.every(rule => !rule.current && !rule.candidateCount));
  const synced = await syncRules(input);
  evidence.outcomes.sync = synced;
  await archive();
  assert.equal(synced.status, 'success', JSON.stringify(synced.results.filter(rule => rule.error)));
  assert.equal(synced.results.filter(rule => rule.status === 'delivered').length, 16);
  assert.equal(synced.readbackRequests?.length, 64);

  const status = await getRulesStatus(input);
  assert.equal(status.status, 'success', status.error ?? '');
  evidence.outcomes.status = status;
  const snapshot = await repository.snapshot();
  evidence.finalHead = snapshot.head;
  const verifySource = formalSourceVerifier(snapshot.head);
  for (const definition of ruleSets) {
    const rule = status.rules?.find(({ id }) => id === definition.id);
    assert.ok(rule?.current, definition.id);
    const { current, id } = rule;
    assert.equal(rule.deliveryState, 'delivered', id);
    assert.equal(rule.configurationDifference, 'none', id);
    assert.equal(rule.control?.mode, 'auto', id);
    assert.equal(rule.candidateCount, 1, id);
    assert.ok(rule.candidates.some(candidate => candidate.id === current.candidateId && candidate.current && candidate.selectable), id);
    const expected = `stable/${id}/${id === 'china-ip' || id === 'chatgpt-voice' ? 'ips' : 'domains'}`;
    assert.deepEqual(Object.keys(current.files).sort(), [expected + '.json', expected + '.srs']);
    const stablePrefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/`;
    assert.deepEqual(rule.stableUrls.slice().sort(), [stablePrefix + expected + '.json', stablePrefix + expected + '.srs']);
    assert.deepEqual(current.subscription, {
      schemaVersion: 3, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      formats: { source: { url: stablePrefix + expected + '.json' }, binary: { url: stablePrefix + expected + '.srs' } },
    });
    const candidate = `candidates/${current.candidateId}`;
    const readJson = async (file: string) => JSON.parse((await snapshot.read(`${candidate}/${file}`))!.toString());
    const [manifest, build, report] = await Promise.all([
      readJson('manifest.json'), readJson('build.json'), readJson('conversion-report.json'),
    ]);
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.id, id);
    assert.equal(manifest.revision, current.candidateId);
    assert.equal(Object.hasOwn(manifest, 'projections'), false);
    assert.equal(Object.hasOwn(build.definition, 'usages'), false);
    assert.equal(Object.hasOwn(report, 'usageCounts'), false);
    assert.equal(build.validation.status, 'passed');
    assert.deepEqual(build.definition, definition);
    assert.deepEqual(build.source, current.source);
    assert.ok(report.outputTermCount > 0, id);
    const files = [];
    let sourceVerification;
    for (const format of ['source', 'binary'] as const) {
      const extension = format === 'source' ? 'json' : 'srs';
      const path = `${expected}.${extension}`;
      const artifact = manifest.artifacts.find((item: { format: string }) => item.format === format);
      const commit = await repository.lastChange(snapshot.head, path);
      const fixedDelivery = immutableUrl(commit, path);
      const checked = current.files[path];
      assert.equal(artifact.sha256, checked.sha256);
      assert.equal(artifact.byteLength, checked.byteLength);
      const bytes = await snapshot.read(path);
      assert.ok(bytes);
      for (const url of [artifact.url, fixedDelivery, stablePrefix + path]) {
        const readback = await repository.download(url);
        assert.deepEqual(readback, bytes, url);
      }
      if (format === 'source') {
        sourceVerification = await verifySource({ id, candidateId: current.candidateId, source: current.source, artifactUrl: artifact.url, artifact: bytes });
      }
      assert.equal(sha256(bytes), checked.sha256);
      assert.equal(bytes.length, checked.byteLength);
      const localPath = join(local, `${id}.${extension}`);
      await writeFile(localPath, bytes);
      const matches = [];
      for (const [value, expected] of [...positives[id].map(value => [value, true] as const),
        [id === 'china-ip' || id === 'chatgpt-voice' ? '192.0.2.1' : 'no-match-example.invalid', false] as const]) {
        const result: { stdout: string; stderr: string } = await exec(binary, ['rule-set', 'match', localPath, value, '--format', format]);
        const matched: boolean = (result.stdout + result.stderr).includes('match rules.');
        assert.equal(matched, expected, `${id} ${format} ${value}`);
        matches.push({ value, matched });
      }
      files.push({ format, sha256: checked.sha256, byteLength: checked.byteLength, commit, candidateUrl: artifact.url,
        fixedDelivery, stableUrl: stablePrefix + path, matches });
    }
    evidence.rules.push({ id, definition, source: current.source, input: rule.expectedSource, version: current.versionId,
      selectable: true, sourceVerification, terms: report.outputTermCount, unsupported: report.unsupportedTypeCounts, native: build.validation, files });
    console.log('verified', id);
    await archive();
  }

  const version = status.rules?.find(rule => rule.id === 'onedrive')?.current?.versionId;
  assert.ok(version);
  const pin = await pinRuleVersion({ ...input, id: 'onedrive', version });
  evidence.outcomes.pin = pin;
  assert.equal(pin.status, 'success', pin.error ?? '');
  assert.equal(pin.results[0].control?.mode, 'pinned');
  const resumed = await resumeRuleUpdates({ ...input, id: 'onedrive' });
  evidence.outcomes.resume = resumed;
  assert.equal(resumed.status, 'success', resumed.error ?? '');
  assert.equal(resumed.results[0].control?.mode, 'auto');
  const preflight = await readSchedulePreflight({ context });
  evidence.outcomes.preflight = preflight;
  assert.equal(preflight.status, 'success', preflight.error ?? '');
  assert.equal(preflight.results.filter(rule => rule.current).length, 16);
  const cleanup = await cleanupRuleHistory({ ...input, dryRun: true });
  evidence.outcomes.cleanup = cleanup;
  assert.equal(cleanup.status, 'success', cleanup.error ?? '');
  assert.equal(cleanup.cleanup?.plan.retain.candidateIds.length, 16);
});
