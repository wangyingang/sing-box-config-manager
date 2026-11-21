import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const paths = process.argv.slice(2);
assert.ok(paths.length === 1 || paths.length === 2, 'summarize.mjs BASELINE_JSON [COMPARISON_JSON]');
const reports = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const [before, after] = reports;
if (after) {
  for (const key of ['configurationSha256', 'probeSha256', 'node', 'platform', 'binarySha256', 'layout', 'facts']) {
    assert.deepEqual(after[key], before[key], key);
  }
}
function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const metrics = ['totalMs', 'snapshotCheck', 'source', 'native', 'toolIdentity', 'gitWrite', 'checkReads',
  'checkBytes', 'stableReads', 'reads', 'snapshots', 'upstream', 'nativeBuilds', 'toolInspections', 'commits'];
console.log(['scenario', 'metric', 'baseline', ...(after ? ['comparison'] : [])].join('\t'));
for (const scenario of Object.keys(before.facts)) {
  for (const key of metrics) {
    const values = reports.map(report => {
      assert.ok(report.samples.length > 0);
      const samples = report.samples.map(sample => sample[scenario][key]);
      assert.ok(samples.every(Number.isFinite), key);
      return Number(median(samples).toFixed(2));
    });
    console.log([scenario, key, ...values].join('\t'));
  }
}
