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
import { manageMaintenance, type MaintenanceRequest } from '../../src/maintenance.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, githubPublication, type ghJson } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { initializeRemoteState } from '../../src/remote-state.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { runRuleWorkflow, workflowRules } from '../../src/rule-workflow.js';
import { updateRules } from '../../src/update.js';

const originalTag = '20261104112839';
const updatedTag = '20261108011013';
const originalCommit = 'f162630c8cdad6ced5ef59e606cc93919123ac57';
const updatedCommit = '62bc1fc8b015bece77271b568e10d6337915bc96';
const domains = ['openai', 'anthropic', 'google-deepmind'];
const china = 'china-ip';
const ids = [...domains, china];

// Pin discovery for reproducibility. All Release metadata/assets and Git file
// bytes come from GitHub; confirm both selected commits are on ip-lists.
const sourceAt = (tag: string, commit: string): typeof fetch => async (url, init) => {
  const address = String(url);
  if (address === 'https://api.github.com/repos/gaoyifan/china-operator-ip/branches/ip-lists') {
    const branch = await fetch(address, init);
    assert.ok(branch.ok, `Branch lookup HTTP ${branch.status}`);
    const { name, commit: { sha: head } } = await branch.json();
    assert.equal(name, 'ip-lists');
    assert.match(head, /^[a-f0-9]{40}$/);
    if (head !== commit) {
      const compare = await fetch(`https://api.github.com/repos/gaoyifan/china-operator-ip/compare/${commit}...${head}?per_page=1`, init);
      assert.ok(compare.ok, `Commit comparison HTTP ${compare.status}`);
      assert.equal((await compare.json()).merge_base_commit.sha, commit);
    }
    return Response.json({ name, commit: { sha: commit } });
  }
  return fetch(address.replace(/\/releases\/latest$/, `/releases/tags/${tag}`), init);
};

test('从空的 GitHub 隔离分支使用正式配置完成四集双来源生命周期', {
  skip: process.env.RULE_OFFICIAL_CONFIG_PROBE !== '1', timeout: 1_500_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY;
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY to sing-box 1.14.4');
  const token = process.env.GH_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  assert.ok(token, 'Authenticate gh for the isolated GitHub probe');
  const target = `acceptance-issue-73-${randomUUID()}`;
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
  const originalSource = sourceAt(originalTag, originalCommit);
  const updatedSource = sourceAt(updatedTag, updatedCommit);
  const status = () => readRemoteStatus({ repository, publication, binary, activation });

  await api('git/refs', { ref: branchRef(target), sha: initial });
  await initializeRemoteState(repository, target);
  console.log(JSON.stringify({ target, initial, production }));

  for (const selectedIds of [domains, [china]]) {
    const published = await updateRules({ ...common, selectedIds, fetch: originalSource });
    assert.deepEqual(published.results.map(result => [result.id, result.status]), selectedIds.map(id => [id, 'processed']));
    assert.ok(!(await repository.snapshot()).paths.some(path => path.startsWith('stable/')));
    for (const result of published.results) {
      assert.equal(result.status, 'processed');
      assert.ok(result.readback.length > 0 && result.readback.every(file => file.exactBytes));
      const build = result.readback.find(file => file.url.endsWith('/build.json'));
      assert.ok(build, 'Missing candidate build record');
      const { source, tool } = JSON.parse((await publication.download(build.url)).toString());
      console.log(JSON.stringify({ candidateOnly: result.id, source, tool,
        candidate: result.candidate.id, evidenceUrl: result.candidate.evidenceUrl, readback: result.readback }));
    }
  }

  const maintenance = { repository, binary, activation, publication, baseline: githubBaselineTransport(request), refTransport: refs };
  async function workflow(operation: 'daily' | 'check' | 'cleanup', input?: { fetcher: typeof fetch; directory: string }) {
    const observations: Record<string, unknown> = {};
    const maintenanceResults: Partial<Record<MaintenanceRequest['action'], Awaited<ReturnType<typeof manageMaintenance>>>> = {};
    const code = await runRuleWorkflow({ operation, target, updateEnabled: false, cleanupEnabled: false }, {
      async check() {
        assert.ok(input, 'Unexpected check during manual cleanup');
        return checkRules({ ...check, fetch: input.fetcher, stateDirectory: join(root, input.directory) });
      },
      async maintenance(request) {
        const result = await manageMaintenance({ ...maintenance, ...request });
        maintenanceId ??= result.run?.id;
        maintenanceResults[request.action] = result;
        return result;
      },
    }, (name, result) => {
      observations[name] = result;
    });
    assert.equal(code, 0, JSON.stringify(observations));
    return { observations, maintenanceResults };
  }

  const { observations: first } = await workflow('daily', { fetcher: originalSource, directory: 'first-check' });
  const original = (await status()).activeRuleVersions;
  assert.deepEqual(Object.keys(original).sort(), [...ids].sort());
  for (const id of domains) assert.equal(original[id].activation.source.tag, originalTag);
  assert.equal(original[china].activation.source.commit, originalCommit);
  console.log(JSON.stringify({ first, active: Object.fromEntries(ids.map(id => [id, original[id].activation])) }));

  const { observations: second } = await workflow('check', { fetcher: updatedSource, directory: 'second-check' });
  const changedStatus = await status();
  const changed = changedStatus.activeRuleVersions;
  assert.equal(changed.anthropic.activation.source.tag, updatedTag);
  assert.equal(changed[china].activation.source.commit, updatedCommit);
  assert.notDeepEqual(changed[china].activation.files, original[china].activation.files);
  for (const id of ['openai', 'google-deepmind']) assert.equal(changed[id].activation.id, original[id].activation.id);

  const manual = { configuration, binary, transport: activation, logicalId: china,
    subscription: subscriptions[china], stateDirectory: join(root, 'manual') };
  const originalRollback = changedStatus.rollbackTargets[china].find(entry => entry.id === original[china].activation.id);
  assert.ok(originalRollback, 'The initial China IP activation must be available for rollback');
  console.log(JSON.stringify({ second, changedSources: { anthropic: changed.anthropic.activation.source,
    [china]: changed[china].activation.source }, originalRollback }));
  const rollback = await rollbackRules({ ...manual, expectedHead: await activation.head(),
    historicalActivationCommit: originalRollback.commit });
  assert.deepEqual(rollback.activation.files, original[china].activation.files);
  const fresh = { ...check, stateDirectory: join(root, 'fresh'), fetch: updatedSource };
  const paused = await checkRules({ ...fresh, selectedIds: [china] });
  assert.equal(paused.results[0]?.status, 'paused', JSON.stringify(paused));
  const resumed = await resumeRules({ ...fresh, logicalId: china });
  assert.deepEqual(resumed.results.map(result => [result.id, result.status]), [[china, 'activated']], JSON.stringify(resumed));
  assert.deepEqual((await status()).activeRuleVersions[china].activation.files, changed[china].activation.files);

  const pinned = await activateRules({ ...manual, expectedHead: await activation.head(),
    candidateEvidenceUrl: original[china].activation.candidateEvidenceUrl });
  const before = await status();
  assert.equal(before.activeRuleVersions[china].control?.pauseAutomaticActivation, true);
  assert.equal(before.activeRuleVersions[china].control?.pauseAutomaticRetry, false);
  assert.deepEqual(before.activeRuleVersions[china].activation.files, original[china].activation.files);
  const discardedRollback = before.rollbackTargets[china].find(entry => entry.id === changed[china].activation.id);
  assert.ok(discardedRollback, 'The superseded China IP activation must be retained before cleanup');
  console.log(JSON.stringify({ rollback: rollback.commit, paused, resumed, pin: pinned.commit, discardedRollback }));

  const { observations: cleanup, maintenanceResults } = await workflow('cleanup');
  const entered = maintenanceResults.enter;
  assert.equal(entered?.status, 'isolated');
  assert.ok(entered.run?.plan?.discard.candidateIds.length);
  assert.ok(entered.run.plan.discard.activations[china]?.length);
  assert.equal(maintenanceResults.switch?.status, 'completed');
  console.log(JSON.stringify({ maintenanceId, cleanup }));

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
      assert.match(path, new RegExp(`^stable/${id}/${id === china ? 'route' : 'domains'}\\.(json|srs)$`));
      const bytes = await publication.download(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${path}`);
      assert.equal(sha256(bytes), expected.sha256);
      assert.equal(bytes.length, expected.byteLength);
    }
  }
  await assert.rejects(rollbackRules({ ...manual, stateDirectory: join(root, 'after-cleanup'), expectedHead: await activation.head(),
    historicalActivationCommit: discardedRollback.commit }), /ROLLBACK_UNAVAILABLE/);
  const recovered = await checkRules({ ...fresh, stateDirectory: join(root, 'after-cleanup') });
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.deepEqual(recovered.results.map(result => [result.id, result.status]),
    [['openai', 'unchanged'], ['anthropic', 'unchanged'], ['google-deepmind', 'unchanged'], [china, 'paused']]);
  console.log(JSON.stringify({ maintenanceId, generation: after.generation, recovered, final: after.activeRuleVersions }));
});
