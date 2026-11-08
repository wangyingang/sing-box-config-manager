import { readFile } from 'node:fs/promises';
import { updateRules } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import { immutableUrl, type PublicationTransport } from '../../src/publication.js';
import { PublicationWriteError, type PublicationRepository } from '../../src/publication-repository.js';
import { authorizeActivationWrite } from '../../src/manual-activation.js';
import { initializeRemoteState, STATE_PATH } from '../../src/remote-state.js';
import type { BaselineTransport } from '../../src/maintenance-baseline-transport.js';
import { branchRef, type MaintenanceRefTransport } from '../../src/maintenance-refs.js';
import { ActivationWriteError, type ActivationTransport } from '../../src/activation-transport.js';

export async function configuredEnvironment(binary: string, directory: string, branch = 'acceptance-issue-39') {
  const configuration = (await readFile(new URL('../../config/rulesets.yml', import.meta.url), 'utf8')).replace('branch: main', `branch: ${branch}`);
  const ids = ['openai', 'anthropic', 'google-deepmind'];
  let sequence = 0, head = 'a'.repeat(40), mode = '', revision = 0, writes = 0;
  let journalHead = branch === 'main' ? 'b'.repeat(40) : head;
  let readbackHead: string | undefined;
  const parents = new Map<string, string>();
  const retained: Record<string, Buffer> = {};
  const snapshots = new Map<string, Record<string, Buffer>>([[head, {}], [journalHead, {}]]);
  const stored = new Map<string, Buffer>();
  const publishedAt = new Map<string, string>();
  const publish: PublicationTransport['commit'] = async files => {
    const commit = (++sequence).toString(16).padStart(40, '0');
    for (const [path, bytes] of Object.entries(files)) {
      stored.set(immutableUrl(commit, path), bytes);
      retained[path] = bytes;
      publishedAt.set(path, commit);
    }
    return commit;
  };
  const download = async (url: string) => {
    const parsed = new URL(url), parts = parsed.pathname.split('/').slice(3), ref = parts.shift()!, path = parts.join('/');
    if (mode === 'readback' && ref === readbackHead && /^stable\/.+\/(?:domains|route)\.srs$/.test(path)) throw new Error('HTTPS temporarily unavailable');
    const bytes = snapshots.get(ref === branch ? head : ref)?.[path] ?? stored.get(url);
    if (!bytes) throw new Error(`Readback HTTP 404: ${url}`);
    return bytes;
  };
  const coordinationBranch = branch === 'main' ? 'candidates' : branch;
  const scratch = new Map<string, string>();
  const fixedSnapshot = (fixed: string, tree: Record<string, Buffer>) => {
    const parent = parents.get(fixed);
    return { head: fixed, parent, parents: parent ? [parent] : [], paths: Object.keys(tree), async read(path: string) { return tree[path]; } };
  };
  const baseline: BaselineTransport = {
    async stage(ref, parent, files) {
      const existing = scratch.get(branchRef(ref));
      if (existing) return existing;
      const commit = (++sequence).toString(16).padStart(40, '0');
      if (parent) parents.set(commit, parent);
      snapshots.set(commit, { ...parent && snapshots.get(parent), ...files });
      scratch.set(branchRef(ref), commit);
      return commit;
    },
    async snapshot(ref) {
      const fixed = scratch.get(branchRef(ref));
      return fixed ? fixedSnapshot(fixed, snapshots.get(fixed)!) : undefined;
    },
  };
  let switchCount = 0;
  const refs: MaintenanceRefTransport & { switches(): number } = {
    switches: () => switchCount,
    async list() {
      return [...new Map([[branchRef(branch), head], [branchRef(coordinationBranch), branch === 'main' ? journalHead : head], ...scratch])]
        .map(([ref, head]) => ({ ref, head }));
    },
    async update(changes) {
      const heads = new Map((await refs.list()).map(({ ref, head }) => [ref, head]));
      if (changes.some(({ ref, before }) => heads.get(ref) !== before)) throw new Error('STALE_REF');
      if (changes.some(({ ref }) => ref === branchRef(branch))) switchCount++;
      for (const { ref, after } of changes) {
        if (ref === branchRef(branch)) head = after!;
        if (ref === branchRef(coordinationBranch)) journalHead = after!;
        if (ref === branchRef(branch) || ref === branchRef(coordinationBranch)) continue;
        if (after) scratch.set(ref, after);
        else scratch.delete(ref);
      }
    },
  };
  const repository: PublicationRepository = {
    branch: coordinationBranch,
    async snapshot(target = coordinationBranch) {
      if (target !== branch && target !== coordinationBranch) {
        const snapshot = await baseline.snapshot(target);
        if (!snapshot) throw new Error(`Missing branch: ${target}`);
        return snapshot;
      }
      const fixed = target === branch ? head : journalHead;
      const tree = { ...(target === coordinationBranch && !switchCount ? retained : {}), ...snapshots.get(fixed) };
      return fixedSnapshot(fixed, tree);
    },
    async lastChange(at, path) {
      if (!snapshots.get(at)?.[path] && publishedAt.has(path)) return publishedAt.get(path)!;
      while (parents.has(at) && snapshots.get(at)?.[path] === snapshots.get(parents.get(at)!)?.[path]) at = parents.get(at)!;
      return at;
    },
    async commit(expected, files) {
      const current = branch === 'main' ? journalHead : head;
      if (current !== expected) throw new Error('PUBLICATION_CONFLICT');
      const commit = (++sequence).toString(16).padStart(40, '0');
      parents.set(commit, current);
      snapshots.set(commit, { ...snapshots.get(current), ...files });
      if (branch === 'main') journalHead = commit;
      else head = commit;
      if (mode === 'registration' && files[STATE_PATH]) {
        mode = '';
        throw new PublicationWriteError(commit, 'registration response lost');
      }
      return commit;
    },
  };
  await initializeRemoteState(repository, branch);
  let beforeSwitch: (() => Promise<void>) | undefined;
  const transport: ActivationTransport = {
    branch, repository, async head() { if (mode === 'unknown-head') throw new Error('offline'); return head; }, download,
    async commit(expected, files, _message, reservation) {
      if (mode === 'rejected') throw new Error('Server rejected before requesting the ref update');
      await beforeSwitch?.();
      if (reservation) await authorizeActivationWrite(repository, branch, expected, files, reservation);
      // No await between compare and update: model the remote atomic ref operation.
      if (head !== expected) throw new Error('ACTIVATION_CONFLICT');
      writes++;
      const commit = (++sequence).toString(16).padStart(40, '0');
      snapshots.set(commit, { ...snapshots.get(head), ...files });
      parents.set(commit, head);
      if (mode === 'not-applied') {
        throw new ActivationWriteError(commit, 'lost reply');
      }
      head = commit;
      if (mode === 'readback') readbackHead = commit;
      if (mode === 'unknown') {
        mode = 'unknown-head';
        throw new ActivationWriteError(commit, 'lost reply and connection');
      }
      if (mode === 'applied' || mode === 'superseded') {
        if (mode === 'superseded') {
          head = (++sequence).toString(16).padStart(40, '0');
          snapshots.set(head, { ...snapshots.get(commit) });
          parents.set(head, commit);
        }
        throw new ActivationWriteError(commit, 'lost reply');
      }
      return commit;
    },
  };
  const candidates = async () => {
    revision++;
    const input = JSON.stringify({ lists: ['openai', 'anthropic', 'google-deepmind'].map(name => ({ name, length: 1, rules: [`domain:${name}-${revision}.example`] })) });
    const tag = '20261104112839';
    const fetcher: typeof fetch = async url => {
      const path = String(url);
      if (path.endsWith('/latest')) return Response.json({ id: 42, tag_name: tag, assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({ id: 11 + i, name, browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
      if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
      if (path.endsWith('/assets/11')) return new Response(input);
      if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
      throw new Error(`Unexpected source: ${path}`);
    };
    const result = await updateRules({ stateDirectory: `${directory}/build-${revision}`, configuration, binary,
      fetch: fetcher, publication: { commit: publish, download } });
    return Object.fromEntries(result.results.map(entry => {
      if (entry.status !== 'processed') throw new Error(JSON.stringify(entry));
      return [entry.id, entry.candidate];
    }));
  };
  const subscription = (id: string) => {
    const formats = { binary: { url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/${id}/domains.srs`, requiredCapabilities: [] },
      source: { url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/${id}/domains.json`, requiredCapabilities: [] } };
    return { schemaVersion: 2, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      projections: { route: { formats }, 'dns-query': { formats: structuredClone(formats) }, 'dns-response': { unavailable: 'empty' } } };
  };
  return { ids, candidates, subscription, transport, repository, baseline, refs, stored, snapshots, configuration, publish, head: () => head,
    writes: () => writes, beforeSwitch(hook: () => Promise<void>) { beforeSwitch = hook; }, fail(value: string) { mode = value; },
    options: (id: string, evidenceUrl: string) => ({ logicalId: id, configuration, stateDirectory: directory,
      subscription: subscription(id), binary, expectedHead: head, candidateEvidenceUrl: evidenceUrl, transport }) };
}

export function upstream(revision: number, rules: Record<string, string> = {}) {
  const requests: string[] = [];
  const tag = `2026110411283${revision}`;
  const input = JSON.stringify({ lists: ['openai', 'anthropic', 'google-deepmind', 'openai-alt'].map(name =>
    ({ name, length: 1, rules: [rules[name] ?? `domain:${name}.example`] })) });
  const fetcher: typeof fetch = async url => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith('/latest') || path.endsWith(`/releases/${revision}`)) return Response.json({ id: revision, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({ id: 11 + i, name,
        browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path.endsWith('/assets/11')) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected source: ${path}`);
  };
  return { fetcher, requests };
}
