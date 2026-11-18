import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const load = file => import(pathToFileURL(join(root, 'packages/rule-set-pipeline', file)).href);
const { cleanupEnvironment, fourSetCleanupEnvironment } = await load('test/fixtures/cleanup-environment.ts');
const { syncRules, pinRuleVersion, resumeRuleUpdates } = await load('src/rules-operations.ts');
const { cleanupRuleHistory } = await load('src/rules-cleanup.ts');
const { getRulesStatus } = await load('src/rules-status.ts');
const { runRuleAutomation } = await load('src/rule-workflow.ts');
const realBinary = resolve(process.env.SING_BOX_TEST_BINARY);
const temporary = await mkdtemp(join(tmpdir(), 'pipeline-operation-counts-'));
const wrapper = join(temporary, 'sing-box');
const trace = wrapper + '.log';
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const measurements = [];

function watch(env) {
  const git = [];
  const raw = [];
  const upstream = [];
  const { context } = env;
  const readConfiguration = context.readConfiguration;
  context.readConfiguration = (...args) => { git.push(['configuration']); return readConfiguration(...args); };
  const repo = context.repository;
  const repositorySnapshot = repo.snapshot;
  repo.snapshot = async (...args) => {
    git.push(['snapshot', args[0] ?? repo.branch]);
    const snapshot = await repositorySnapshot(...args);
    return { ...snapshot, async read(path) { git.push(['blob', path]); return snapshot.read(path); } };
  };
  const lastChange = repo.lastChange;
  repo.lastChange = (...args) => { git.push(['lastChange', args[1]]); return lastChange(...args); };
  const download = repo.download;
  repo.download = url => { raw.push(url); return download(url); };
  const baselineSnapshot = env.baseline.snapshot;
  env.baseline.snapshot = async ref => {
    git.push(['baselineSnapshot', ref]);
    const snapshot = await baselineSnapshot(ref);
    if (!snapshot) return snapshot;
    return { ...snapshot, async read(path) { git.push(['blob', path]); return snapshot.read(path); } };
  };
  const refsList = env.refs.list;
  env.refs.list = (...args) => { git.push(['refsList']); return refsList(...args); };
  const upstreamFetch = context.fetch;
  context.fetch = (url, init) => { upstream.push(String(url)); return upstreamFetch(url, init); };

  return async (scenario, run, expected = ['success']) => {
    await writeFile(trace, '');
    git.length = raw.length = upstream.length = 0;
    const [commits, stages, refTransactions] = [env.writes.length, env.stageWrites.length, env.refWrites.length];
    const start = performance.now();
    const result = await run();
    const elapsedMs = performance.now() - start;
    assert.ok(expected.includes(result.status), `${scenario}: ${JSON.stringify(result)}`);
    const commands = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean);
    measurements.push({ scenario, status: result.status, elapsedMs,
      selected: result.results?.map(rule => ({ id: rule.id, result: rule.status })),
      cleanupPhase: result.cleanup?.phase,
      raw: [...raw], upstream: [...upstream], git: [...git],
      native: {
        compile: commands.filter(cmd => cmd.startsWith('rule-set compile ')).length,
        decompile: commands.filter(cmd => cmd.startsWith('rule-set decompile ')).length,
        jsonLoad: commands.filter(cmd => cmd.startsWith('rule-set match ') && cmd.endsWith('--format source')).length,
        srsLoad: commands.filter(cmd => cmd.startsWith('rule-set match ') && cmd.endsWith('--format binary')).length,
        other: commands.filter(cmd => !/^rule-set (compile|decompile|match) /.test(cmd)).length,
      },
      writes: {
        commits: env.writes.length - commits,
        stages: env.stageWrites.length - stages,
        refTransactions: env.refWrites.length - refTransactions,
        refChanges: env.refWrites.slice(refTransactions).reduce((total, changes) => total + changes.length, 0),
      },
    });
    return result;
  };
}

async function success(run) {
  const result = await run();
  assert.equal(result.status, 'success', JSON.stringify(result));
  return result;
}

try {
  await writeFile(wrapper, `#!/bin/sh
printf '%s\\n' "$*" >> "$0.log"
exec ${shellQuote(realBinary)} "$@"
`, { mode: 0o700 });

  const one = cleanupEnvironment(wrapper, 'main');
  const config = one.config();
  config.ruleSets = [config.ruleSets[0]];
  one.configure(config);
  const single = { context: one.context };
  const oneRun = watch(one);
  await oneRun('single-first', () => syncRules(single));

  const four = fourSetCleanupEnvironment(wrapper, 'main');
  const all = { context: four.context };
  const openai = { ...all, id: 'openai' };
  const fourRun = watch(four);
  const first = await fourRun('four-first', () => syncRules(all));
  const initialVersion = first.results.find(rule => rule.id === 'openai').current.versionId;
  await fourRun('unchanged', () => syncRules(all));
  await fourRun('status', () => getRulesStatus(all));
  const preview = { ...openai, dryRun: true };
  await fourRun('sync-preview', () => syncRules(preview));
  await fourRun('pin-preview', () => pinRuleVersion({ ...preview, version: initialVersion }));
  await fourRun('resume-preview', () => resumeRuleUpdates(preview));
  const idle = fourSetCleanupEnvironment(wrapper, 'main');
  const noReclaim = { context: idle.context };
  await success(() => syncRules(noReclaim));
  const idleRun = watch(idle);
  await idleRun('cleanup-no-reclaim', () => cleanupRuleHistory(noReclaim));

  four.upstream({ openai: 'domain:schedule-probe.example' });
  await success(() => syncRules(all));
  await fourRun('schedule-unchanged', async () => {
    const reports = [];
    const exitCode = await runRuleAutomation({ event: 'schedule', target: 'main' }, line => reports.push(JSON.parse(line)), four.context);
    assert.equal(exitCode, 0, JSON.stringify(reports));
    return { status: 'success' };
  });
  four.upstream({ other: 'domain:unused.example' });
  await fourRun('new-input-same-rules', () => syncRules(all));

  four.clock('2026-12-20T00:00:00.000Z');
  four.upstream({ openai: 'domain:replacement.example' });
  await success(() => syncRules(all));
  await fourRun('pin-switch', () => pinRuleVersion({ ...openai, version: initialVersion }));

  const old = fourSetCleanupEnvironment(wrapper, 'main');
  const reclaim = { context: old.context };
  await success(() => syncRules(reclaim));
  old.clock('2026-12-20T00:00:00.000Z');
  old.upstream({ openai: 'domain:replacement.example' });
  await success(() => syncRules(reclaim));
  const reclaimRun = watch(old);
  const cleaned = await reclaimRun('cleanup-reclaim', () => cleanupRuleHistory(reclaim));
  assert.equal(cleaned.cleanup.plan.retain.candidateIds.length, 4);
  assert.equal(cleaned.cleanup.plan.retain.active.length, 4);

  one.upstream({ openai: 'domain:recover.example' });
  one.failDownload(url => {
    if (url.includes('/stable/') && url.endsWith('.srs')) throw new Error('stable SRS readback unavailable');
  });
  await oneRun('stable-readback-failed', () => syncRules(single), ['pending', 'partial', 'failed']);
  one.failDownload();
  await oneRun('stable-readback-recovered', () => syncRules(single));

  const gitText = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({ source: gitText('rev-parse', 'HEAD'), gitStatus: gitText('status', '--porcelain'),
    trackedDiffSha256: sha256(gitText('diff', '--binary', 'HEAD')),
    probeSha256: sha256(await readFile(fileURLToPath(import.meta.url))), wrapperSha256: sha256(await readFile(wrapper)),
    node: process.version, platform: `${process.platform}/${process.arch}`, command: process.argv,
    singBox: { path: realBinary, sha256: sha256(await readFile(realBinary)),
      version: execFileSync(realBinary, ['version'], { encoding: 'utf8' }) },
    exitCode: 0, measurements }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
