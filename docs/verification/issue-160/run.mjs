import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [inputsArg, outputArg, count = '5'] = process.argv.slice(2);
const pairs = Number(count);
assert.ok(inputsArg && outputArg && Number.isSafeInteger(pairs) && pairs > 0,
  'node run.mjs INPUT_DIRECTORY NEW_RESULT_JSON [PAIRS]');
assert.ok(process.env.SING_BOX_TEST_BINARY, 'Set SING_BOX_TEST_BINARY to the absolute path to sing-box 1.14.4');
const inputs = resolve(inputsArg), output = resolve(outputArg);
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../../..');
const measure = resolve(here, '../issue-155/measure.mjs');
const hook = join(here, 'hook.mjs');
const experimentSha256 = createHash('sha256').update(await readFile(import.meta.filename)).update(await readFile(hook)).digest('hex');
const scenarios = { first: 0, unchanged: 16, 'same-source': 14, 'multi-source': 14 };
const samples = [];
let identity;
const work = await mkdtemp(join(tmpdir(), 'rules-tool-pairs-'));
try {
  for (let pair = 1; pair <= pairs; pair++) {
    const order = pair % 2 ? ['baseline', 'reuse'] : ['reuse', 'baseline'];
    const sample = { pair, order };
    for (const mode of order) {
      const raw = join(work, pair + '-' + mode);
      const observations = raw + '-tools';
      execFileSync(process.execPath, ['--import', 'tsx', '--import', hook, measure, 'run', inputs, root, raw, '1'], {
        cwd: join(root, 'packages/rule-set-pipeline'), stdio: 'inherit',
        env: { ...process.env, RULE_TOOL_EXPERIMENT: mode, RULE_TOOL_OBSERVATIONS: observations },
      });
      const { samples: [metrics], ...currentIdentity } = JSON.parse(await readFile(raw, 'utf8'));
      if (identity) assert.deepEqual(currentIdentity, identity, 'Different build, inputs or rule outcomes');
      else identity = currentIdentity;
      const detail = JSON.parse(await readFile(observations, 'utf8'));
      assert.equal(detail.mode, mode);
      assert.deepEqual(Object.keys(metrics), Object.keys(scenarios));
      assert.equal(detail.operations.length, Object.keys(scenarios).length);
      for (const [index, [name, expected]] of Object.entries(scenarios).entries()) {
        const checks = detail.operations[index];
        assert.equal(checks.eligibleChecks, expected, name);
        const hashes = mode === 'baseline' ? expected : Math.min(1, expected);
        assert.equal(checks.fullHashes, hashes, name);
        assert.equal(checks.byteMatches, expected - hashes, name);
        Object.assign(metrics[name], checks);
      }
      sample[mode] = { metrics, maxRssKiB: detail.maxRssKiB };
    }
    for (const name of Object.keys(scenarios)) {
      for (const key of ['toolInspections', 'nativeBuilds', 'commits', 'upstream', 'reads', 'stableBytes']) {
        assert.equal(sample.baseline.metrics[name][key], sample.reuse.metrics[name][key], name + ' ' + key);
      }
    }
    samples.push(sample);
  }
  await writeFile(output, JSON.stringify({ experimentSha256, ...identity, samples }, null, 2) + '\n', { flag: 'wx' });
} finally {
  await rm(work, { recursive: true, force: true });
}
