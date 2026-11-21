import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

let current;
export function begin() {
  current = { active: new Set(), ms: { snapshotCheck: 0, source: 0, native: 0, toolIdentity: 0, gitWrite: 0 },
    counts: { snapshots: 0, reads: 0, stableReads: 0, stableBytes: 0, checkReads: 0, checkBytes: 0, commits: 0, upstream: 0, nativeBuilds: 0, toolInspections: 0 } };
}
export function finish() {
  const { ms, counts } = current;
  current = undefined;
  return { ms, counts };
}

// Count nested checks of the same phase once in this serial benchmark.
export function timed(group, fn, counter) {
  return async function (...args) {
    if (!current || current.active.has(group)) return fn.apply(this, args);
    const run = current;
    if (counter) run.counts[counter]++;
    const start = performance.now();
    run.active.add(group);
    try { return await fn.apply(this, args); }
    finally {
      run.ms[group] += performance.now() - start;
      run.active.delete(group);
    }
  };
}

export function timedInput(resolve) {
  const probe = timed('source', resolve);
  return async function (...args) {
    const input = await probe(...args);
    return { ...input, read: timed('source', input.read),
      ...(input.unchanged && { unchanged: timed('source', input.unchanged) }) };
  };
}

// Instrument benchmark-process module bindings after load. Internal and external
// callers share the wrappers. Source files and the on-disk build identity stay intact.
export function instrument(root) {
  const src = join(root, 'packages/rule-set-pipeline/src');
  const suffixes = new Map([
    [join(src, 'rules-delivery.ts'), "readRuleDeliveries = time('snapshotCheck', readRuleDeliveries); ensureRulePathAvailable = time('snapshotCheck', ensureRulePathAvailable);"],
    [join(src, 'rules-build.ts'), 'resolveRulesInput = timeInput(resolveRulesInput);'],
    [join(src, 'native.ts'), "buildWithTool = time('native', buildWithTool, 'nativeBuilds'); inspectBinary = time('toolIdentity', inspectBinary, 'toolInspections');"],
  ]);
  const instrumentation = 'import { timed as time, timedInput as timeInput } from ' + JSON.stringify(import.meta.url) + ';\n';
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const suffix = url.startsWith('file:') && suffixes.get(fileURLToPath(url));
    if (!suffix) return loaded;
    return { ...loaded, source: Buffer.from(loaded.source).toString() + '\n' + instrumentation + suffix + '\n' };
  } });
}

export function observeRepository(repo) {
  const snapshot = repo.snapshot;
  repo.snapshot = async (...args) => {
    if (current) current.counts.snapshots++;
    const view = await snapshot(...args);
    return { ...view, async read(path) {
      const bytes = await view.read(path);
      if (current) {
        current.counts.reads++;
        if (path.startsWith('stable/')) {
          current.counts.stableReads++;
          current.counts.stableBytes += bytes?.length ?? 0;
          if (current.active.has('snapshotCheck')) {
            current.counts.checkReads++;
            current.counts.checkBytes += bytes?.length ?? 0;
          }
        }
      }
      return bytes;
    } };
  };
  const commit = repo.commit;
  repo.commit = timed('gitWrite', (...args) => {
    if (current) current.counts.commits++;
    return commit(...args);
  });
}

export function countFetch(fetch) {
  return (...args) => {
    if (current) current.counts.upstream++;
    return fetch(...args);
  };
}
