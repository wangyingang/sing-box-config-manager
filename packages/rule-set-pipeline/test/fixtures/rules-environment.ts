import { isDeepStrictEqual } from 'node:util';
import type { BuildConfiguration } from '../../src/configuration.js';
import { stringify } from 'yaml';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { sha256 } from '../../src/release.js';
import type { RulesContext } from '../../src/rules-context.js';
import type { RulesRepository, RuleWrites } from '../../src/rules-repository.js';

interface RulesFixtureHistory {
  heads: Map<string, string>;
  trees: Map<string, Map<string, Buffer>>;
  parents: Map<string, string>;
}

/** Real in-memory Git snapshots/CAS, with the same external boundary as GitHub. */
export function rulesEnvironment(binary: string, target = 'acceptance-issue-84', persisted?: RulesFixtureHistory) {
  let sequence = 2;
  if (persisted) for (const head of persisted.trees.keys()) sequence = Math.max(sequence, Number.parseInt(head, 16));
  const journalBranch = target === 'main' ? 'candidates' : target;
  const heads = persisted?.heads ?? new Map([[target, '1'.padStart(40, '0')], [journalBranch, '1'.padStart(40, '0')]]);
  const trees = persisted?.trees ?? new Map<string, Map<string, Buffer>>([['1'.padStart(40, '0'), new Map()]]);
  const parents = persisted?.parents ?? new Map<string, string>();
  const writes: { branch: string; files: RuleWrites }[] = [];
  const requests: string[] = [];
  const official = parseBuildConfiguration(readOfficialConfiguration());
  let config: BuildConfiguration = { ...official, target: { ...official.target, branch: target }, sources: { dlc: official.sources.dlc },
    ruleSets: official.ruleSets.filter(rule => ['openai', 'anthropic'].includes(rule.id)) };
  let revision = 1;
  let upstreamRevision = 1;
  let sourceFailure: boolean | string = false;
  const contents: Record<string, string> = {};
  const history = new Map<number, Record<string, string>>([[1, {}]]);
  let beforeWrite: ((files: RuleWrites) => Promise<void>) | undefined;
  const repository: RulesRepository = {
    branch: journalBranch,
    async snapshot(branch = journalBranch) {
      const head = heads.get(branch)!;
      const tree = trees.get(head)!;
      return { head, parent: parents.get(head), paths: [...tree.keys()], async read(path) { return tree.get(path); } };
    },
    async lastChange(head, path) {
      if (!trees.get(head)?.has(path)) throw new Error(`Missing Git path: ${head}/${path}`);
      while (parents.has(head) && isDeepStrictEqual(trees.get(head)?.get(path), trees.get(parents.get(head)!)?.get(path))) head = parents.get(head)!;
      return head;
    },
    async commit(branch, expected, files, _message, guard) {
      await beforeWrite?.(files);
      await guard();
      if (heads.get(branch) !== expected) throw new Error('RULE_WRITE_CONFLICT');
      const next = new Map(trees.get(expected));
      for (const [path, bytes] of Object.entries(files)) {
        if (bytes === null) next.delete(path);
        else next.set(path, bytes);
      }
      const head = (++sequence).toString(16).padStart(40, '0');
      parents.set(head, expected); trees.set(head, next); heads.set(branch, head);
      writes.push({ branch, files });
      return head;
    },
    async download(url) {
      const [ref, ...parts] = new URL(url).pathname.split('/').slice(3);
      const bytes = trees.get(heads.get(ref) ?? ref)?.get(parts.join('/'));
      if (!bytes) throw new Error(`Readback HTTP 404: ${url}`);
      return bytes;
    },
  };
  const fetcher: typeof fetch = async address => {
    const url = String(address); requests.push(url);
    if (sourceFailure === true || typeof sourceFailure === 'string' && url.includes(sourceFailure)) throw new Error('Upstream unavailable');
    const match = /repos\/([^/]+\/[^/]+)\//.exec(url);
    const repository = match?.[1] ?? 'v2fly/domain-list-community';
    const requested = /\/releases\/(\d+)$/.exec(url)?.[1];
    const asset = /\/assets\/(\d+)$/.exec(url)?.[1];
    const version = requested ? Number(requested) : asset ? Math.floor(Number(asset) / 10) : upstreamRevision;
    const tag = `release-${version}`;
    const retained = history.get(version)!;
    const input = JSON.stringify({ lists: ['openai', 'anthropic', 'google-deepmind', 'other'].map(name =>
      ({ name, length: 1, rules: [retained[name] ?? `domain:${name}.example`] })) });
    const checksum = `${sha256(input)}  dlc.dat_plain.yml\n`;
    if (url.includes('/releases/') && !url.includes('/assets/')) return Response.json({ id: version, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, index) => ({ id: version * 10 + 1 + index, name,
        state: 'uploaded', digest: `sha256:${sha256(index === 0 ? input : checksum)}`,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` })) });
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (asset && Number(asset) % 10 === 1) return new Response(input);
    if (asset && Number(asset) % 10 === 2) return new Response(checksum);
    throw new Error(`Unexpected input: ${url}`);
  };
  const context: RulesContext = { repository, targetBranch: target, allowWrites: true, binary, fetch: fetcher,
    now: () => new Date('2026-11-16T08:15:30.123Z'),
    readConfiguration: async () => ({ revision: String(revision).padStart(40, '0'), content: stringify(config, { aliasDuplicateObjects: false }), origin: 'isolated-fixture' }) };
  return { context, writes, requests, heads, trees, parents,
    config: () => structuredClone(config),
    configure(next: typeof config) { config = next; revision++; },
    upstream(rules: Record<string, string>) { Object.assign(contents, rules); upstreamRevision++; history.set(upstreamRevision, { ...contents }); },
    failSource(value: boolean | string) { sourceFailure = value; },
    beforeWrite(callback?: typeof beforeWrite) { beforeWrite = callback; },
  };
}
