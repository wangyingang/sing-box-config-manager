import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BaselineTransport } from '../../src/maintenance-baseline-transport.js';
import type { MaintenanceRefTransport, RefChange } from '../../src/maintenance-refs.js';
import type { PublicationSnapshot } from '../../src/publication-repository.js';
import { parseRulesJournal, RULE_STATE_PATH } from '../../src/rules-model.js';
import { syncRules } from '../../src/rules-operations.js';
import type { RulesRepository } from '../../src/rules-repository.js';
import { baselineV4Configuration } from './formal-configuration.js';
import { checkpointFixture, rulesEnvironment } from './rules-environment.js';

/** The ordinary rules fixture plus immutable roots and atomic, leased ref updates. */
interface CleanupFixtureState {
  rules: NonNullable<Parameters<typeof rulesEnvironment>[2]>;
  parents: Map<string, string[]>;
  now: Date;
}

export function cleanupEnvironment(binary: string, target = 'acceptance-issue-85', state?: CleanupFixtureState) {
  const env = rulesEnvironment(binary, target, state?.rules);
  const original = env.context.repository;
  const parents = state?.parents ?? new Map<string, string[]>();
  const blockedHeads = new Set<string>();
  const stageWrites: string[] = [];
  const refWrites: RefChange[][] = [];
  let now = state?.now ?? new Date('2026-11-16T00:00:00.000Z');
  let stageFault: ((ref: string) => void | Promise<void>) | undefined;
  let beforeRefs: ((changes: RefChange[]) => void | Promise<void>) | undefined;
  let afterRefs: ((changes: RefChange[]) => void | Promise<void>) | undefined;
  let downloadFault: ((url: string) => void | Promise<void>) | undefined;

  const snapshot = async (ref: string): Promise<PublicationSnapshot> => {
    const head = env.heads.get(ref) ?? ref;
    assert.ok(!blockedHeads.has(head), `Old Git history used: ${ref}`);
    const tree = env.trees.get(head);
    assert.ok(tree, `Unknown snapshot: ${ref}`);
    const lineage = parents.get(head) ?? [];
    return { head, parents: lineage, parent: lineage.length === 1 ? lineage[0] : undefined,
      paths: [...tree.keys()], async read(path) { return tree.get(path); } };
  };
  const repository: RulesRepository = {
    ...original,
    snapshot: (ref = original.branch) => snapshot(ref),
    async commit(...args) {
      const head = await original.commit(...args);
      parents.set(head, [args[1]]);
      return head;
    },
    async lastChange(head, path) {
      if (!env.trees.get(head)?.has(path)) throw new Error(`Missing Git path: ${head}/${path}`);
      assert.ok(!blockedHeads.has(head), `Old path history used: ${head}`);
      while (parents.get(head)?.length === 1) {
        const parent = parents.get(head)![0];
        if (!isDeepStrictEqual(env.trees.get(head)?.get(path), env.trees.get(parent)?.get(path))) break;
        head = parent;
        assert.ok(!blockedHeads.has(head), `Old path history used: ${head}`);
      }
      return head;
    },
    async download(url) {
      await downloadFault?.(url);
      const ref = new URL(url).pathname.split('/')[3];
      assert.ok(!blockedHeads.has(env.heads.get(ref) ?? ref), `Old artifact address used: ${url}`);
      return original.download(url);
    },
  };
  const baseline: BaselineTransport = {
    async snapshot(ref) { return env.heads.has(ref) ? snapshot(ref) : undefined; },
    async stage(ref, parent, files, message) {
      await stageFault?.(ref);
      const tree = new Map(parent ? env.trees.get(parent) : undefined);
      for (const [path, bytes] of Object.entries(files)) tree.set(path, bytes);
      const existing = env.heads.get(ref);
      if (existing) {
        assert.deepEqual(parents.get(existing), parent ? [parent] : [], `Stage parent changed: ${ref}`);
        assert.deepEqual(env.trees.get(existing), tree, `Stage bytes changed: ${ref}`);
        return existing;
      }
      const hash = createHash('sha1').update(message).update(parent ?? '');
      for (const [path, bytes] of [...tree].sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update(bytes);
      const head = hash.digest('hex');
      env.trees.set(head, tree); parents.set(head, parent ? [parent] : []); env.heads.set(ref, head);
      stageWrites.push(ref);
      return head;
    },
  };
  const refs: MaintenanceRefTransport = {
    async list() { return [...env.heads].map(([branch, head]) => ({ ref: branch.startsWith('refs/') ? branch : `refs/heads/${branch}`, head })); },
    async update(changes) {
      if (!changes.length) return;
      await beforeRefs?.(changes);
      assert.equal(new Set(changes.map(change => change.ref)).size, changes.length, 'Duplicate ref transaction');
      for (const { ref, before } of changes) {
        assert.ok(ref.startsWith('refs/heads/'), `Unexpected ref: ${ref}`);
        assert.equal(env.heads.get(ref.slice('refs/heads/'.length)), before, `Stale ref lease: ${ref}`);
      }
      for (const { ref, after } of changes) {
        const branch = ref.slice('refs/heads/'.length);
        if (after) { assert.ok(env.trees.has(after), `Missing commit: ${after}`); env.heads.set(branch, after); }
        else env.heads.delete(branch);
      }
      refWrites.push(structuredClone(changes));
      await afterRefs?.(changes);
    },
  };
  env.context.repository = repository;
  env.context.now = () => now;
  env.context.cleanup = { baseline, refs };
  return { ...env, baseline, refs, parents, blockedHeads, stageWrites, refWrites,
    checkpoint() {
      const rules = env.checkpoint(), cleanup = checkpointFixture({ parents, now });
      return (): CleanupFixtureState => ({ rules: rules(), ...cleanup() });
    },
    clock(iso: string) { now = new Date(iso); },
    failStage(callback?: typeof stageFault) { stageFault = callback; },
    beforeRefs(callback?: typeof beforeRefs) { beforeRefs = callback; },
    afterRefs(callback?: typeof afterRefs) { afterRefs = callback; },
    failDownload(callback?: typeof downloadFault) { downloadFault = callback; },
    async journal() {
      const bytes = await (await repository.snapshot()).read(RULE_STATE_PATH);
      assert.ok(bytes, 'Missing rules journal');
      return parseRulesJournal(bytes);
    },
    reachable(branch = repository.branch) {
      const result = new Set<string>();
      const visit = (head: string) => { if (result.has(head)) return; result.add(head); (parents.get(head) ?? []).forEach(visit); };
      visit(env.heads.get(branch)!);
      return result;
    },
  };
}

/** Four curated sets, real native builds, deterministic URL and Git/CIDR inputs. */
export function fourSetCleanupEnvironment(binary: string, target: string) {
  const env = cleanupEnvironment(binary, target);
  const config = baselineV4Configuration(false);
  config.target.branch = target;
  env.configure(config);
  return env;
}

/** Replace the current OpenAI delivery and age its predecessor out of the retention window. */
export async function publishReplacementForCleanup(env: ReturnType<typeof cleanupEnvironment>) {
  const candidates = Object.values((await env.journal()).candidates).filter(candidate => candidate.logicalId === 'openai');
  assert.equal(candidates.length, 1, 'Expected one published OpenAI candidate');
  const [current] = candidates;
  assert.ok(current.publishedAt);
  env.clock(new Date(Date.parse(current.publishedAt) + (env.config().candidateRetentionDays + 1) * 86_400_000).toISOString());
  env.upstream({ openai: 'domain:replacement-for-cleanup.example' });
  const result = await syncRules({ context: env.context });
  assert.equal(result.status, 'success', JSON.stringify(result));
  const replacement = result.results.find(rule => rule.id === 'openai')?.current;
  assert.ok(replacement);
  assert.notEqual(replacement.candidateId, current.id);
  return current.id;
}
