import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(process.argv[2] ?? new URL('results.json', import.meta.url), 'utf8'));
const previous = JSON.parse(await readFile(new URL('../issue-156/comparison.json', import.meta.url), 'utf8'));
const experiment = createHash('sha256');
for (const file of ['run.mjs', 'hook.mjs']) experiment.update(await readFile(new URL(file, import.meta.url)));
assert.equal(report.experimentSha256, experiment.digest('hex'), 'Different experiment runner or instrumentation');
assert.deepEqual(report.facts, previous.facts, '16-rule deliveries differ from the accepted reference');
assert.equal(report.probeSha256, previous.probeSha256, 'Different public-sync measuring probe');
assert.ok(report.samples.length > 0);
function median(values) {
  assert.ok(values.every(Number.isFinite));
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
console.log('scenario\tmetric\tbaseline median\treuse median\tpaired median savings');
for (const scenario of Object.keys(report.facts)) {
  for (const key of ['totalMs', 'toolIdentity', 'toolInspections', 'eligibleChecks', 'fullHashes', 'byteMatches',
    'maxRetainedBytes', 'nativeBuilds', 'commits']) {
    const values = mode => report.samples.map(pair => pair[mode].metrics[scenario][key]);
    const baseline = values('baseline'), reuse = values('reuse');
    console.log([scenario, key, median(baseline), median(reuse),
      median(baseline.map((before, i) => before - reuse[i]))].map(v => typeof v === 'number' ? +v.toFixed(2) : v).join('\t'));
  }
}
for (const mode of ['baseline', 'reuse']) {
  const peaks = report.samples.map(pair => pair[mode].maxRssKiB / 1024);
  console.log(mode, 'Node process peak RSS median MiB', median(peaks).toFixed(2));
}
