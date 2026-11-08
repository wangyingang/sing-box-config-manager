import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { activateRules, rollbackRules } from '../../src/activation.js';
import { githubActivation } from '../../src/activation-transport.js';
import { checkRules, resumeRules } from '../../src/check-rules.js';
import { githubBaselineTransport } from '../../src/maintenance-baseline-transport.js';
import { branchRef, gitMaintenanceRefs } from '../../src/maintenance-refs.js';
import { manageMaintenance } from '../../src/maintenance.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, githubPublication, type ghJson } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { initializeRemoteState } from '../../src/remote-state.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { workflowRules } from '../../src/rule-workflow.js';
import { updateRules } from '../../src/update.js';

const originalTag = '20261104112839';
const updatedTag = '20261108011013';
const ids = ['openai', 'anthropic', 'google-deepmind'];
const sourceAt = (tag: string): typeof fetch => (url, init) =>
  fetch(String(url).replace(/\/releases\/latest$/, `/releases/tags/${tag}`), init);

test('从空的 GitHub 隔离分支使用正式配置完成三集生命周期', {
  skip: process.env.RULE_OFFICIAL_CONFIG_PROBE !== '1', timeout: 1_500_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY;
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY to sing-box 1.14.4');
  const token = process.env.GH_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  assert.ok(token, 'Authenticate gh for the isolated GitHub probe');
  const target = `acceptance-issue-67-${randomUUID()}`;
  const refs = gitMaintenanceRefs();
  const productionHeads = async () => (await refs.list()).filter(({ ref }) => ['main', 'candidates'].some(name => ref === branchRef(name)));
  const production = await productionHeads();
  const root = await mkdtemp(join(tmpdir(), 'official-rulesets-'));
  let maintenanceId: string | undefined;
  t.after(async () => {
    try {
      const owned = (await refs.list()).filter(({ ref }) => ref === branchRef(target)
        || maintenanceId && ref.startsWith(`refs/heads/maintenance-${maintenanceId}-`));
      await refs.update(owned.map(({ ref, head }) => ({ ref, before: head })));
      const remaining = new Set((await refs.list()).map(({ ref }) => ref));
      assert.ok(owned.every(({ ref }) => !remaining.has(ref)));
      assert.deepEqual(await productionHeads(), production);
      console.log(JSON.stringify({ target, cleanup: 'temporary refs deleted', production }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Only immutable Git objects are cached. Ref updates and HTTPS readback use GitHub.
  const immutable = new Map<string, Promise<unknown>>();
  const github: typeof ghJson = async (args, input) => {
    const [command, endpoint, methodOption, method] = args;
    assert.equal(command, 'api');
    assert.ok(endpoint === `repos/${ARTIFACT_REPOSITORY}` || endpoint.startsWith(`repos/${ARTIFACT_REPOSITORY}/`));
    const response = await fetch(`https://api.github.com/${endpoint}`, {
      method: methodOption === '--method' ? method : 'GET',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.text();
    if (!response.ok) throw new GitHubHttpError(response.status, `GitHub HTTP ${response.status}: ${endpoint}: ${body}`);
    return body ? JSON.parse(body) : null;
  };
  const request: typeof ghJson = (args, input) => {
    const endpoint = args[1];
    if (args.length !== 2 || endpoint !== `repos/${ARTIFACT_REPOSITORY}`
      && !/\/git\/(commits|trees|blobs)\/[a-f0-9]{40}(?:\?recursive=1)?$/.test(endpoint)) return github(args, input);
    const existing = immutable.get(endpoint);
    if (existing) return existing;
    const result = github(args, input).catch(error => { immutable.delete(endpoint); throw error; });
    immutable.set(endpoint, result);
    return result;
  };
  const api = (path: string, input: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`, '--method', 'POST', '--input', '-'], input);
  const initial = await createGitCommit(api, { 'README.md': Buffer.from(`Fresh isolation probe ${target}\n`) }, target);
  const publication = githubPublication(request, target);
  const repository = publication.repository!;
  const activation = githubActivation(target, request);
  const { configuration, subscriptions } = workflowRules(target);
  const common = { configuration, binary, publication, stateDirectory: join(root, 'first'), token: process.env.GITHUB_TOKEN ?? token };
  const check = { ...common, activation, subscriptions };
  const status = () => readRemoteStatus({ repository, publication, binary, activation });

  await api('git/refs', { ref: branchRef(target), sha: initial });
  await initializeRemoteState(repository, target);
  console.log(JSON.stringify({ target, initial, production }));

  const published = await updateRules({ ...common, sampleTag: originalTag });
  assert.deepEqual(published.results.map(result => [result.id, result.status]), ids.map(id => [id, 'processed']));
  assert.ok(!(await repository.snapshot()).paths.some(path => path.startsWith('stable/')));
  console.log(JSON.stringify({ candidateOnly: published.results.map(result => result.status === 'processed'
    ? { id: result.id, candidate: result.candidate.id, evidenceUrl: result.candidate.evidenceUrl } : result) }));

  const first = await checkRules({ ...check, fetch: sourceAt(originalTag) });
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert.deepEqual(first.results.map(result => [result.id, result.status]), ids.map(id => [id, 'activated']));
  const original = (await status()).activeRuleVersions;
  assert.deepEqual(Object.keys(original).sort(), [...ids].sort());
  for (const id of ids) assert.equal(original[id].activation.source.tag, originalTag);
  console.log(JSON.stringify({ first: Object.fromEntries(ids.map(id => [id, original[id].activation])) }));

  const second = await checkRules({ ...check, fetch: sourceAt(updatedTag) });
  assert.equal(second.exitCode, 0, JSON.stringify(second));
  assert.deepEqual(second.results.map(result => [result.id, result.status]),
    [['openai', 'unchanged'], ['anthropic', 'activated'], ['google-deepmind', 'unchanged']]);
  const changed = (await status()).activeRuleVersions;
  assert.equal(changed.anthropic.activation.source.tag, updatedTag);
  for (const id of ['openai', 'google-deepmind']) assert.equal(changed[id].activation.id, original[id].activation.id);

  const manual = { configuration, binary, transport: activation, logicalId: 'anthropic',
    subscription: subscriptions.anthropic, stateDirectory: join(root, 'manual') };
  const rollback = await rollbackRules({ ...manual, expectedHead: await activation.head(),
    historicalActivationCommit: original.anthropic.commit });
  assert.deepEqual(rollback.activation.files, original.anthropic.activation.files);
  const fresh = { ...check, stateDirectory: join(root, 'fresh'), fetch: sourceAt(updatedTag) };
  const paused = await checkRules({ ...fresh, selectedIds: ['anthropic'] });
  assert.equal(paused.results[0]?.status, 'paused', JSON.stringify(paused));
  const resumed = await resumeRules({ ...fresh, logicalId: 'anthropic' });
  assert.equal(resumed.results[0]?.status, 'activated', JSON.stringify(resumed));
  assert.deepEqual((await status()).activeRuleVersions.anthropic.activation.files, changed.anthropic.activation.files);

  const pinned = await activateRules({ ...manual, expectedHead: await activation.head(),
    candidateEvidenceUrl: original.anthropic.activation.candidateEvidenceUrl });
  const before = await status();
  assert.equal(before.activeRuleVersions.anthropic.control?.pauseAutomaticActivation, true);
  assert.equal(before.activeRuleVersions.anthropic.control?.pauseAutomaticRetry, false);
  console.log(JSON.stringify({ updated: changed.anthropic.activation, rollback: rollback.commit, resumed: resumed.results[0], pin: pinned.commit }));

  const maintenance = { repository, binary, activation, publication, baseline: githubBaselineTransport(request), refTransport: refs };
  const entered = await manageMaintenance({ ...maintenance, action: 'enter', manual: true });
  maintenanceId = entered.run?.id;
  assert.equal(entered.status, 'isolated', JSON.stringify(entered));
  const prepared = await manageMaintenance({ ...maintenance, action: 'prepare' });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  const completed = await manageMaintenance({ ...maintenance, action: 'switch' });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));

  const after = await status();
  assert.equal(after.generation, before.generation + 1);
  assert.deepEqual(Object.keys(after.activeRuleVersions).sort(), [...ids].sort());
  for (const id of ids) {
    const active = after.activeRuleVersions[id];
    assert.equal(active.activation.id, before.activeRuleVersions[id].activation.id);
    assert.deepEqual(active.activation.files, before.activeRuleVersions[id].activation.files);
    assert.deepEqual(active.control, before.activeRuleVersions[id].control);
    assert.deepEqual(after.rollbackTargets[id], []);
    for (const [path, expected] of Object.entries(active.activation.files as Record<string, { sha256: string; byteLength: number }>)) {
      assert.match(path, new RegExp(`^stable/${id}/domains\\.(json|srs)$`));
      const bytes = await publication.download(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${path}`);
      assert.equal(sha256(bytes), expected.sha256);
      assert.equal(bytes.length, expected.byteLength);
    }
  }
  await assert.rejects(rollbackRules({ ...manual, stateDirectory: join(root, 'after-cleanup'), expectedHead: await activation.head(),
    historicalActivationCommit: changed.anthropic.commit }), /ROLLBACK_UNAVAILABLE/);
  const recovered = await checkRules({ ...fresh, stateDirectory: join(root, 'after-cleanup') });
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.deepEqual(recovered.results.map(result => [result.id, result.status]),
    [['openai', 'unchanged'], ['anthropic', 'paused'], ['google-deepmind', 'unchanged']]);
  console.log(JSON.stringify({ maintenanceId, generation: after.generation, final: after.activeRuleVersions }));
});
