import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.env.RULE_TOOL_EXPERIMENT;
assert.ok(['baseline', 'reuse'].includes(mode), 'Set RULE_TOOL_EXPERIMENT to baseline or reuse');
const operations = new AsyncLocalStorage();
const checkingInput = new AsyncLocalStorage();
const observations = [];

export function observeSync(sync) {
  return async function (...args) {
    const metrics = { eligibleChecks: 0, fullHashes: 0, byteMatches: 0, maxRetainedBytes: 0 };
    const state = { metrics };
    try { return await operations.run(state, () => sync.apply(this, args)); }
    finally {
      delete state.previous;
      observations.push(metrics);
    }
  };
}

export function observeEligibility(check) {
  return function (...args) {
    return checkingInput.run(true, () => check.apply(this, args));
  };
}

export function observedDigest(bytes, hash) {
  const state = operations.getStore();
  if (!state || !checkingInput.getStore()) return hash(bytes);
  const { metrics } = state;
  metrics.eligibleChecks++;
  if (state.previous?.bytes.equals(bytes)) {
    metrics.byteMatches++;
    return state.previous.digest;
  }
  metrics.fullHashes++;
  const digest = hash(bytes);
  if (mode === 'reuse') {
    state.previous = { bytes, digest };
    metrics.maxRetainedBytes = Math.max(metrics.maxRetainedBytes, bytes.byteLength);
  }
  return digest;
}

// Keep the version command, the following full file read, and the build's final
// drift check in their original positions. Only the digest of that read is varied.
const src = join(process.cwd(), 'src');
const replacements = new Map([
  [join(src, 'native.ts'), ['sha256(await readFile(path))', 'observedDigest(await readFile(path), sha256)']],
  [join(src, 'rules-operations.ts'), [null, 'syncRules = observeSync(syncRules);']],
  [join(src, 'rules-success.ts'), [null, 'reuseVerifiedInput = observeEligibility(reuseVerifiedInput);']],
]);
const installed = new Set();
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const file = url.startsWith('file:') && fileURLToPath(url);
  const edit = replacements.get(file);
  if (!edit) return loaded;
  let source = Buffer.from(loaded.source).toString();
  const [original, replacement] = edit;
  if (original) {
    assert.equal(source.split(original).length, 2, 'Unexpected sing-box file digest site');
    source = source.replace(original, replacement);
  } else {
    source += '\n' + replacement;
  }
  installed.add(file);
  source += '\nimport { observedDigest, observeSync, observeEligibility } from ' + JSON.stringify(import.meta.url) + ';\n';
  return { ...loaded, source };
} });

if (process.env.RULE_TOOL_OBSERVATIONS) process.once('exit', code => {
  if (code !== 0) return;
  assert.equal(installed.size, replacements.size, 'Missing experiment instrumentation');
  writeFileSync(process.env.RULE_TOOL_OBSERVATIONS, JSON.stringify({
    mode, operations: observations, maxRssKiB: process.resourceUsage().maxRSS,
  }), { flag: 'wx' });
});
