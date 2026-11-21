import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, loadInputs, reference, replay } from './inputs.mjs';
import { begin, countFetch, finish, instrument, observeRepository } from './timing.mjs';

const [mode, directory, checkout, destination, roundsText = '3'] = process.argv.slice(2);
assert.ok(['prepare', 'run'].includes(mode) && directory, 'prepare INPUTS | run INPUTS CHECKOUT NEW_JSON [ROUNDS]');
const bytes = await loadInputs(directory, mode === 'prepare');
if (mode === 'prepare') {
  console.log('Fixed inputs verified.');
  process.exit(0);
}
assert.ok(checkout && destination && process.env.SING_BOX_TEST_BINARY, 'Set SING_BOX_TEST_BINARY and supply CHECKOUT and NEW_JSON');
const rounds = Number(roundsText);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
const target = resolve(checkout);
const binary = resolve(process.env.SING_BOX_TEST_BINARY);
instrument(target);
const pipeline = join(target, 'packages/rule-set-pipeline');
const load = name => import(pathToFileURL(join(pipeline, name)).href);
const { rulesEnvironment } = await load('test/fixtures/rules-environment.ts');
const { syncRules } = await load('src/rules-operations.ts');
const configuration = await readFile(join(pipeline, 'config/rulesets.yml'), 'utf8');
const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
const measuredPaths = ['packages/rule-set-pipeline/src', 'packages/rule-set-pipeline/config',
  'packages/rule-set-pipeline/test/fixtures/rules-environment.ts', 'pnpm-lock.yaml'];
assert.equal(git('status', '--porcelain', '--', ...measuredPaths), '', 'Commit the measured implementation first');
const probeSha256 = digest(Buffer.concat(await Promise.all(['measure.mjs', 'inputs.mjs', 'timing.mjs'].map(name =>
  readFile(new URL(name, import.meta.url))))));
const scenarios = { first: reference.ruleSets.map(row => row.id), unchanged: [],
  'same-source': ['openai', 'anthropic'], 'multi-source': ['gfw', 'onedrive'] };
const streams = Object.fromEntries(Object.keys(scenarios).map(name => [name, replay(bytes, name)]));
const started = '2026-11-20T00:00:00.000Z';
const changedAt = '2026-11-21T00:00:00.000Z';

async function runScenario(scenario, seed, initial) {
  const environment = rulesEnvironment(binary, 'main', seed?.());
  const { context } = environment;
  const source = streams[scenario];
  context.fetch = countFetch(source.fetch);
  context.readConfiguration = async () => ({ revision: '1'.repeat(40), origin: 'local-replay', content: configuration });
  context.now = () => new Date(scenario === 'first' ? started : changedAt);
  observeRepository(context.repository);

  begin();
  const start = performance.now();
  const result = await syncRules({ context });
  const totalMs = performance.now() - start;
  const { ms, counts } = finish();
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.results.length, 16);
  const selected = new Map(result.results.map(row => [row.id, row]));
  assert.equal(selected.size, 16);
  assert.deepEqual(result.results.filter(row => row.status === 'delivered').map(row => row.id).sort(), [...scenarios[scenario]].sort());
  for (const phase of ['snapshotCheck', 'source', 'toolIdentity']) assert.ok(ms[phase] > 0, 'Missing measurement for ' + phase);
  assert.equal(counts.commits, environment.writes.length);
  if (scenario === 'unchanged') {
    assert.equal(counts.commits, 0);
    assert.equal(counts.nativeBuilds, 0);
  } else {
    assert.ok(ms.gitWrite > 0 && counts.commits > 0);
    assert.ok(ms.native > 0 && counts.nativeBuilds > 0);
  }

  const actual = await context.repository.snapshot(context.targetBranch);
  const facts = {};
  for (const { id, definition, artifacts } of reference.ruleSets) {
    const row = selected.get(id);
    const delivered = scenarios[scenario].includes(id);
    const newIdentity = source.identities[definition.source];
    const currentIdentity = delivered ? newIdentity : streams.first.identities[definition.source];
    assert.equal(row.status, delivered ? 'delivered' : 'unchanged', id);
    assert.equal(row.control.mode, 'auto', id);
    assert.equal(row.successfulInput.source.inputSha256, newIdentity.inputSha256, id);
    assert.equal(row.successfulInput.source.commit, newIdentity.commit, id);
    const record = JSON.parse((await actual.read(definition.stablePath + '/activation.json')).toString());
    assert.deepEqual(record, row.current);
    assert.equal(record.source.inputSha256, currentIdentity.inputSha256, id);
    assert.equal(record.source.commit, currentIdentity.commit, id);
    assert.equal(record.publishedAt, delivered && scenario !== 'first' ? changedAt : started);
    if (initial) assert.equal(record.versionId === initial.get(id).current.versionId, !delivered, id);
    const hashes = {};
    assert.deepEqual(Object.keys(record.files).sort(), artifacts.map(file => definition.stablePath + '/' + file.file).sort());
    for (const [path, evidence] of Object.entries(record.files)) {
      const content = await actual.read(path);
      const hash = digest(content);
      assert.equal(content.length, evidence.byteLength, path);
      assert.equal(hash, evidence.sha256, path);
      const golden = artifacts.find(file => file.file === basename(path));
      if (!delivered || scenario === 'first') assert.equal(hash, golden.sha256, path);
      else {
        assert.notEqual(hash, golden.sha256, path);
        if (path.endsWith('.json')) {
          const rules = JSON.parse(content.toString()).rules;
          assert.ok(rules.some(rule => rule.domain_suffix?.includes('benchmark-' + id + '.invalid')), id);
        }
      }
      hashes[basename(path)] = hash;
    }
    facts[id] = { status: row.status, publishedAt: record.publishedAt, currentSource: currentIdentity,
      observedSource: newIdentity, files: hashes };
  }
  return { metric: { totalMs, ...ms, ...counts }, facts,
    ...(scenario === 'first' && { seed: environment.checkpoint(), initial: selected }) };
}

const facts = {}, samples = [];
for (let round = 1; round <= rounds; round++) {
  const measurements = {};
  let baseline;
  for (const scenario of Object.keys(scenarios)) {
    const sample = await runScenario(scenario, baseline?.seed, baseline?.initial);
    if (scenario === 'first') baseline = sample;
    measurements[scenario] = sample.metric;
    if (facts[scenario]) assert.deepEqual(sample.facts, facts[scenario]);
    else facts[scenario] = sample.facts;
    console.error('Round', round, scenario, Math.round(sample.metric.totalMs), 'ms');
  }
  samples.push(measurements);
}
const evidence = { commit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD:packages/rule-set-pipeline/src'),
  probeSha256, configurationSha256: digest(configuration), node: process.version, platform: process.platform + '/' + process.arch,
  binarySha256: digest(await readFile(binary)), binaryVersion: execFileSync(binary, ['version'], { encoding: 'utf8' }).split('\n')[0],
  layout: 'local in-memory candidates/main, replayed upstream and artifact transport', facts, samples };
await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
