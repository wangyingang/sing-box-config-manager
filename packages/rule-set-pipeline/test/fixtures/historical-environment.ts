import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { parseBuildConfiguration } from '../../src/configuration.js';
import { sha256 } from '../../src/release.js';
import type { RulesContext } from '../../src/rules-context.js';
import type { RuleWrites, RulesRepository } from '../../src/rules-repository.js';

/** Replay captured Git bytes, never the old business writer. Only external storage is replaced. */
export async function historicalEnvironment(name: 'shared' | 'split' | 'srs-only' | 'incomplete', binary = '/must-not-run') {
  const capture: { schemaVersion: number; configuration: string; target: string; branch: string;
    provenance: { sourceCommit: string }; heads: Record<string, string>;
    trees: Record<string, Record<string, string>>; downloads: Record<string, string>; blobs: Record<string, string> }
    = JSON.parse(await readFile(new URL(`./historical/${name}.json`, import.meta.url), 'utf8'));
  assert.equal(capture.schemaVersion, 1);
  assert.equal(capture.provenance.sourceCommit, '1f9ad68d5bf99915e0ce57834023f3b6b7796e98');
  const blobs = new Map(Object.entries(capture.blobs).map(([digest, base64]) => {
    const bytes = Buffer.from(base64, 'base64');
    assert.equal(sha256(bytes), digest, `Historical blob ${digest}`);
    return [digest, bytes];
  }));
  const blob = (digest: string) => {
    const bytes = blobs.get(digest);
    assert.ok(bytes, `Missing historical blob ${digest}`);
    return Buffer.from(bytes);
  };
  const heads = new Map(Object.entries(capture.heads));
  const trees = new Map(Object.entries(capture.trees).map(([head, tree]) =>
    [head, new Map(Object.entries(tree).map(([path, digest]) => [path, blob(digest)]))]));
  const downloads = new Map(Object.entries(capture.downloads).map(([url, digest]) => [url, blob(digest)]));
  const writes: { branch: string; files: RuleWrites }[] = [];
  let content = capture.configuration;
  let revision = 1;
  let beforeWrite: ((files: RuleWrites) => void) | undefined;
  const repository: RulesRepository = {
    branch: capture.branch,
    async snapshot(branch = capture.branch) {
      const head = heads.get(branch) ?? branch;
      const tree = trees.get(head);
      assert.ok(tree, `Missing captured snapshot ${branch}`);
      return { head, paths: [...tree.keys()], async read(path) { const bytes = tree.get(path); return bytes && Buffer.from(bytes); } };
    },
    async lastChange(head, path) {
      const bytes = trees.get(head)?.get(path);
      const entry = [...downloads].find(([url, original]) => url.endsWith(`/${path}`) && original.equals(bytes!));
      return entry ? new URL(entry[0]).pathname.split('/')[3] : head;
    },
    async download(url) {
      const [ref, ...parts] = new URL(url).pathname.split('/').slice(3);
      const bytes = downloads.get(url) ?? trees.get(heads.get(ref) ?? ref)?.get(parts.join('/'));
      if (!bytes) throw new Error(`Historical readback HTTP 404: ${url}`);
      return Buffer.from(bytes);
    },
    async commit(branch, expected, files, _message, guard) {
      await guard();
      beforeWrite?.(files);
      assert.equal(heads.get(branch), expected, 'Historical storage CAS');
      const tree = new Map(trees.get(expected));
      for (const [path, bytes] of Object.entries(files)) {
        if (bytes === null) tree.delete(path);
        else tree.set(path, Buffer.from(bytes));
      }
      const head = sha256(`historical-test-commit-${writes.length}`).slice(0, 40);
      trees.set(head, tree); heads.set(branch, head); writes.push({ branch, files });
      return head;
    },
  };
  const context: RulesContext = { binary, targetBranch: capture.target, allowWrites: true, repository,
    readConfiguration: async () => ({ revision: String(revision).padStart(40, '0'), origin: 'captured-history', content }),
    fetch: async () => { throw new Error('Historical conversion must not read upstream'); } };
  return { context, heads, writes, config: () => parseBuildConfiguration(content),
    configure(configuration: ReturnType<typeof parseBuildConfiguration>) { content = stringify(configuration); revision++; },
    legacyRepository: { branch: repository.branch, snapshot: repository.snapshot, commit: async () => { throw new Error('Historical reader must not write'); } },
    beforeWrite(hook?: typeof beforeWrite) { beforeWrite = hook; } };
}
