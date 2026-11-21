import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const paths = process.argv.slice(2);
assert.ok(paths.length === 1 || paths.length === 2, 'summarize.mjs BASELINE_JSON [COMPARISON_JSON]');
const reports = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
for (const report of reports) assert.ok(report.samples.length > 0, 'Missing samples');
const [before, after] = reports;
if (after) {
  assert.equal(before.samples.length, after.samples.length, 'rounds');
  for (const key of ['configurationSha256', 'probeSha256', 'fixtureSha256', 'lockSha256', 'node', 'platform', 'binarySha256', 'layout', 'facts']) {
    assert.deepEqual(after[key], before[key], key);
  }
}
function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
console.log(['scenario', 'metric', 'baseline (n=' + before.samples.length + ')',
  ...(after ? ['comparison (n=' + after.samples.length + ')'] : [])].join('\t'));
for (const scenario of Object.keys(before.facts)) {
  for (const key of Object.keys(before.samples[0][scenario])) {
    const values = reports.map(report => {
      const samples = report.samples.map(sample => sample[scenario][key]);
      assert.ok(samples.every(Number.isFinite), key);
      return Number(median(samples).toFixed(2));
    });
    console.log([scenario, key, ...values].join('\t'));
  }
}
