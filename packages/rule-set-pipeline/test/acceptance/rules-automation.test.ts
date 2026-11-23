import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseBuildConfiguration } from '../../src/configuration.js';
import { fixtureConfigurationYaml, formalConfiguration, type FixtureConfiguration } from '../fixtures/formal-configuration.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, ghJson } from '../../src/publication.js';
import type { RulesResult } from '../../src/rules-model.js';
import { sha256 } from '../../src/release.js';

const sourceRepository = 'wangyingang/sing-box-config-manager';
const configurationPath = 'packages/rule-set-pipeline/config/rulesets.yml';
const workflow = 'rule-maintenance.yml';
type Run = { id: number; event: string; head_sha: string; head_branch: string; display_title: string;
  status: string; conclusion: string | null; run_attempt: number; html_url: string };
type Report = { event: string; target: string; exitCode: number; results: RulesResult[] };
type Execution = { runId: string; runAttempt: string; eventSha: string; workflowSha: string; checkoutCommit: string };

/** Opt-in: all writes are confined to two identically named disposable refs. */
test('GitHub 自动生命周期：真实配置 push、五操作共享语义、失败与旧事件当前配置', {
  skip: process.env.RULE_AUTOMATION_PROBE !== '1', timeout: 5_400_000,
}, async t => {
  const implementation = process.env.RULE_AUTOMATION_COMMIT ?? '';
  const implementationBranch = process.env.RULE_AUTOMATION_BRANCH ?? '';
  assert.ok(implementationBranch.trim() && !implementationBranch.startsWith('-'), 'RULE_AUTOMATION_BRANCH must explicitly name the reviewed branch');
  assert.match(implementation, /^[a-f0-9]{40}$/, 'RULE_AUTOMATION_COMMIT must pin the reviewed full commit SHA');
  const exec = promisify(execFile);
  await exec('git', ['check-ref-format', `refs/heads/${implementationBranch}`]);
  const directory = resolve(process.env.RULE_AUTOMATION_EVIDENCE ?? '.verification/rules-automation');
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const sourceIdentity = { commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    status: (await exec('git', ['status', '--porcelain'])).stdout,
    diffSha256: sha256((await exec('git', ['diff', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 })).stdout),
    probeSha256: sha256(await readFile(new URL(import.meta.url))) };
  const target = `acceptance-automation-${randomUUID()}`;
  const ownedRefs = new Set<string>();
  const runs = new Map<number, Run>();
  const observations: { label: string; run: Run; report: Report; execution: Execution }[] = [];
  const configurations: { label: string; commit: string; content: string }[] = [];
  const failures: string[] = [];
  const removedRefs: string[] = [];
  const request = async (repository: string, path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST') => {
    assert.ok([sourceRepository, ARTIFACT_REPOSITORY].includes(repository));
    if (method !== 'GET') {
      if (path === 'git/refs') assert.equal((input as { ref?: string })?.ref, `refs/heads/${target}`);
      else if (path.startsWith('git/refs/')) assert.equal(path, `git/refs/heads/${target}`);
      else if (path === `actions/workflows/${workflow}/dispatches`) {
        const dispatch = input as { ref: string; inputs: { target: string } };
        assert.equal(repository, sourceRepository); assert.equal(dispatch.ref, implementationBranch);
        assert.equal(dispatch.inputs.target, target);
      } else if (/^actions\/runs\/\d+\/(rerun|cancel)$/.test(path)) {
        assert.equal(repository, sourceRepository); assert.ok(runs.has(Number(path.split('/')[2])));
      } else assert.ok(['git/blobs', 'git/trees', 'git/commits'].includes(path), `Unexpected mutation: ${repository}/${path}`);
    }
    return ghJson(['api', `repos/${repository}/${path}`, ...(method === 'GET' ? [] : ['--method', method]),
      ...(input === undefined ? [] : ['--input', '-'])], input);
  };
  const head = async (repository: string, branch: string) => (await request(repository, `git/ref/heads/${branch}`)).object.sha as string;
  const checkImplementation = async () => assert.equal(await head(sourceRepository, implementationBranch), implementation,
    'Reviewed implementation branch moved; do not accept a new head automatically');
  const production = async () => ({
    sourceMain: await head(sourceRepository, 'main'), main: await head(ARTIFACT_REPOSITORY, 'main'),
    candidates: await head(ARTIFACT_REPOSITORY, 'candidates'),
    variables: await request(sourceRepository, 'actions/variables'),
  });
  const before = await production();
  let passed = false;
  const evidence = async (extra: Record<string, unknown> = {}) => writeFile(`${directory}/evidence.json`, JSON.stringify({
    target, implementation, implementationBranch, sourceIdentity, before, configurations, observations, runs: [...runs.values()], failures, removedRefs,
    passed, at: new Date().toISOString(), ...extra,
  }, null, 2) + '\n');
  await evidence();
  t.after(async () => {
    const cleanupErrors: string[] = [];
    let activeWriter = false;
    try {
      // Include a run that started before a dispatch response or poll was lost.
      for (const run of await listRuns()) if (run.head_branch === target || run.display_title.includes(target)) runs.set(run.id, run);
    } catch (error) { cleanupErrors.push(String(error)); activeWriter = true; }
    // Cancel only this probe's in-flight runs before deleting their source/target.
    for (const recorded of runs.values()) {
      try {
        const current: Run = await request(sourceRepository, `actions/runs/${recorded.id}`);
        if (current.status !== 'completed') {
          try { await request(sourceRepository, `actions/runs/${current.id}/cancel`, undefined, 'POST'); }
          catch (error) { if ((await request(sourceRepository, `actions/runs/${current.id}`)).status !== 'completed') throw error; }
          for (let attempt = 0; attempt < 30; attempt++) {
            if ((await request(sourceRepository, `actions/runs/${current.id}`)).status === 'completed') break;
            await new Promise(resolve => setTimeout(resolve, 2_000));
          }
          assert.equal((await request(sourceRepository, `actions/runs/${current.id}`)).status, 'completed', 'Do not remove an active writer target');
        }
      } catch (error) { cleanupErrors.push(String(error)); activeWriter = true; }
    }
    for (const repository of [sourceRepository, ARTIFACT_REPOSITORY]) {
      if (!ownedRefs.has(repository) || activeWriter) continue;
      try {
        await request(repository, `git/refs/heads/${target}`, undefined, 'DELETE');
        removedRefs.push(`${repository}:refs/heads/${target}`);
      } catch (error) { cleanupErrors.push(String(error)); }
    }
    const after = await production().catch(error => { cleanupErrors.push(String(error)); return undefined; });
    const remaining = [];
    for (const repository of [sourceRepository, ARTIFACT_REPOSITORY]) {
      try {
        const refs = await request(repository, `git/matching-refs/heads/${target}`);
        remaining.push(...refs.filter((ref: { ref: string }) => ref.ref === `refs/heads/${target}`));
      } catch (error) { cleanupErrors.push(String(error)); }
    }
    await evidence({ after, remaining, cleanupErrors });
    assert.deepEqual(cleanupErrors, []);
    assert.deepEqual(after, before, 'Production refs and variables must remain unchanged');
    assert.deepEqual(remaining, []);
    console.log(JSON.stringify({ target, passed, removedRefs, productionUnchanged: true }));
  });

  const waitRun = async (select: () => Promise<Run | undefined>, label: string, expectedSha: string, attempt = 1): Promise<Run> => {
    const deadline = Date.now() + 1_800_000;
    while (Date.now() < deadline) {
      await checkImplementation();
      const run = await select();
      if (run) {
        runs.set(run.id, run); await evidence();
        assert.equal(run.head_sha, expectedSha, 'Workflow run event SHA differs from the pinned execution');
        if (run.run_attempt >= attempt && run.status === 'completed') return run;
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const listRuns = async (): Promise<Run[]> => (await request(sourceRepository, `actions/workflows/${workflow}/runs?per_page=100`)).workflow_runs;
  const readReport = async (run: Run, label: string, conclusion: 'success' | 'failure', checkoutCommit: string) => {
    const path = `${directory}/${label}`;
    await mkdir(path, { recursive: true });
    await promisify(execFile)('gh', ['run', 'download', String(run.id), '--repo', sourceRepository,
      '--name', 'rule-maintenance-result', '--dir', path], { timeout: 120_000 });
    const report: Report = JSON.parse(await readFile(`${path}/rule-result.json`, 'utf8'));
    const execution: Execution = JSON.parse(await readFile(`${path}/rule-execution.json`, 'utf8'));
    observations.push({ label, run, report, execution }); await evidence();
    assert.equal(execution.runId, String(run.id), 'Execution artifact belongs to another run');
    assert.equal(execution.runAttempt, String(run.run_attempt), 'Execution artifact belongs to another attempt');
    assert.equal(execution.eventSha, run.head_sha, 'Execution event SHA differs');
    assert.equal(execution.workflowSha, run.head_sha, 'Actual workflow SHA differs from the pinned execution');
    assert.equal(execution.checkoutCommit, checkoutCommit, 'Actual checkout SHA differs from the expected code');
    assert.equal(run.conclusion, conclusion, JSON.stringify(report));
    assert.equal(report.target, target);
    assert.equal(report.exitCode, conclusion === 'success' ? 0 : 1);
    assert.ok(report.results.length);
    console.log(`${label}: ${run.event} ${run.html_url} ${run.conclusion}`);
    return report;
  };
  let sourceHead = implementation;
  const sourceApi = (path: string, input?: unknown) => request(sourceRepository, path, input);
  const publish = async (configuration: FixtureConfiguration, files: Record<string, Buffer>, label: string, conclusion: 'success' | 'failure' = 'success') => {
    await checkImplementation();
    const content = fixtureConfigurationYaml(configuration);
    parseBuildConfiguration(content);
    const parent = await request(sourceRepository, `git/commits/${sourceHead}`);
    const commit = await createGitCommit(sourceApi, { ...files, [configurationPath]: Buffer.from(content) },
      `test(rules): 隔离自动流程 ${label}`, { tree: parent.tree.sha, head: sourceHead });
    configurations.push({ label, commit, content }); await evidence();
    const previous = new Set((await listRuns()).map(run => run.id));
    if (!ownedRefs.has(sourceRepository)) {
      await request(sourceRepository, 'git/refs', { ref: `refs/heads/${target}`, sha: commit });
      ownedRefs.add(sourceRepository);
    } else await request(sourceRepository, `git/refs/heads/${target}`, { sha: commit, force: false }, 'PATCH');
    sourceHead = commit;
    const run = await waitRun(async () => (await listRuns()).find(run => !previous.has(run.id) && run.event === 'push'
      && run.head_branch === target), label, commit);
    const report = await readReport(run, label, conclusion, commit);
    assert.equal(report.event, 'push');
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].operation, 'sync');
    assert.equal(report.results[0].configurationRevision, commit);
    return { run, report, result: report.results[0] };
  };
  const dispatch = async (label: string, operation: string, inputs: Record<string, string> = {}) => {
    await checkImplementation();
    const previous = new Set((await listRuns()).map(run => run.id));
    await request(sourceRepository, `actions/workflows/${workflow}/dispatches`,
      { ref: implementationBranch, inputs: { operation, target, ...inputs } });
    const run = await waitRun(async () => (await listRuns()).find(run => !previous.has(run.id)
      && run.event === 'workflow_dispatch' && run.head_branch === implementationBranch && run.display_title.includes(target)), label, implementation);
    const report = await readReport(run, label, 'success', implementation);
    assert.equal(report.event, 'workflow_dispatch');
    assert.equal(report.results[0].operation, operation);
    assert.equal(report.results[0].configurationRevision, sourceHead);
    return report.results[0];
  };
  try {
    await checkImplementation();
    const artifactHead = await createGitCommit((path, input) => request(ARTIFACT_REPOSITORY, path, input),
      { 'README.md': Buffer.from(`Disposable automation probe ${target}\n`) }, 'test(rules): 初始化隔离自动流程');
    await request(ARTIFACT_REPOSITORY, 'git/refs', { ref: `refs/heads/${target}`, sha: artifactHead });
    ownedRefs.add(ARTIFACT_REPOSITORY);
    const official = formalConfiguration();
    const template = official.ruleSets.find(rule => rule.id === 'china-ip')!;
    const rule = (id: string) => ({ ...template, id, source: id, stablePath: `stable/${id}` });
    const source = (path: string) => ({ repository: sourceRepository, version: 'git-branch' as const, branch: target,
      input: { format: 'cidr-text' as const, path: `test-input/${path}.txt` } });
    let configuration: FixtureConfiguration = { ...official, target: { ...official.target, branch: target },
      sources: { changing: source('old'), deleting: source('delete'), fixed: source('fixed') },
      ruleSets: ['changing', 'deleting', 'fixed'].map(rule) };
    const initial = await publish(configuration, {
      'test-input/old.txt': Buffer.from('10.0.0.0/8\n'), 'test-input/next.txt': Buffer.from('172.16.0.0/12\n'),
      'test-input/delete.txt': Buffer.from('192.168.0.0/16\n'), 'test-input/fixed.txt': Buffer.from('192.0.2.0/24\n'),
      'test-input/added.txt': Buffer.from('198.51.100.0/24\n'),
    }, 'baseline-push');
    assert.deepEqual(initial.result.results.map(result => result.status), ['delivered', 'delivered', 'delivered']);
    const fixedVersion = initial.result.results.find(result => result.id === 'fixed')!.current!.versionId!;
    const previousChanging = initial.result.results.find(result => result.id === 'changing')!.current!.versionId;
    const pinned = await dispatch('pin-fixed', 'pin', { id: 'fixed', version: fixedVersion });
    assert.equal(pinned.results[0].control?.mode, 'pinned');
    configuration = { ...configuration, sources: { changing: source('next'), fixed: source('fixed'), added: source('added') },
      ruleSets: ['changing', 'fixed', 'added'].map(rule) };
    const mixed = await publish(configuration, { 'test-input/fixed.txt': Buffer.from('203.0.113.0/24\n') }, 'mixed-push');
    const byId = new Map(mixed.result.results.map(result => [result.id, result]));
    assert.equal(byId.get('deleting')?.status, 'deleted');
    assert.equal(byId.get('changing')?.status, 'delivered');
    assert.notEqual(byId.get('changing')?.current?.versionId, previousChanging);
    assert.equal(byId.get('added')?.status, 'delivered');
    assert.equal(byId.get('fixed')?.status, 'pinned-skipped');
    assert.equal(byId.get('fixed')?.current?.versionId, fixedVersion);
    const beforePreview = await head(ARTIFACT_REPOSITORY, target);
    const preview = await dispatch('resume-preview', 'resume', { id: 'fixed', dry_run: 'true' });
    assert.equal(preview.dryRun, true);
    assert.equal(await head(ARTIFACT_REPOSITORY, target), beforePreview);
    const resumed = await dispatch('resume-fixed', 'resume', { id: 'fixed' });
    assert.equal(resumed.results[0].control?.mode, 'auto');
    assert.notEqual(resumed.results[0].current?.versionId, fixedVersion);
    configuration = { ...configuration, sources: { ...configuration.sources, changing: source('missing') } };
    const partial = await publish(configuration, { 'test-input/added.txt': Buffer.from('198.18.0.0/15\n') }, 'partial-failure-push', 'failure');
    assert.equal(partial.result.status, 'partial');
    const failed = partial.result.results.find(result => result.id === 'changing')!;
    const successful = partial.result.results.find(result => result.id === 'added')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.current?.versionId, byId.get('changing')?.current?.versionId);
    assert.equal(successful.status, 'delivered');
    assert.notEqual(successful.current?.versionId, byId.get('added')?.current?.versionId);
    await checkImplementation();
    await request(sourceRepository, `actions/runs/${mixed.run.id}/rerun`, undefined, 'POST');
    const rerun = await waitRun(() => request(sourceRepository, `actions/runs/${mixed.run.id}`), 'old-event-rerun', mixed.run.head_sha, mixed.run.run_attempt + 1);
    const latest = await readReport(rerun, 'old-event-rerun', 'failure', sourceHead);
    assert.equal(rerun.head_sha, mixed.run.head_sha, 'The event SHA remains old');
    assert.equal(latest.results[0].configurationRevision, sourceHead, 'The effective configuration must be current');
    assert.equal(latest.results[0].results.find(result => result.id === 'changing')?.status, 'failed');
    assert.equal(latest.results[0].results.find(result => result.id === 'added')?.current?.versionId, successful.current?.versionId);
    assert.ok(!latest.results[0].results.some(result => result.id === 'deleting' && result.status === 'delivered'));
    passed = true;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error)); await evidence(); throw error;
  }
});
