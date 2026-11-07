import { readFile } from 'node:fs/promises';
import { updateRules } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import { immutableUrl, type PublicationTransport } from '../../src/publication.js';
import { PublicationWriteError, type PublicationRepository } from '../../src/publication-repository.js';
import { authorizeActivationWrite } from '../../src/manual-activation.js';
import { initializeRemoteState, STATE_PATH } from '../../src/remote-state.js';
import { ActivationWriteError, type ActivationTransport } from '../../src/activation-transport.js';

export async function configuredEnvironment(binary: string, directory: string, branch = 'acceptance-issue-39') {
  const configuration = (await readFile(new URL('../../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8')).replace('branch: main', `branch: ${branch}`);
  const ids = ['ai-openai', 'ai-anthropic', 'ai-google-deepmind'];
  let sequence = 0, head = 'a'.repeat(40), mode = '', revision = 0, writes = 0;
  let journalHead = branch === 'main' ? 'b'.repeat(40) : head;
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
    if (mode === 'readback' && ref === head && path.endsWith('/domains.srs')) throw new Error('HTTPS temporarily unavailable');
    const bytes = snapshots.get(ref === branch ? head : ref)?.[path] ?? stored.get(url);
    if (!bytes) throw new Error(`Readback HTTP 404: ${url}`);
    return bytes;
  };
  const coordinationBranch = branch === 'main' ? 'candidates' : branch;
  const repository: PublicationRepository = {
    branch: coordinationBranch,
    async snapshot(target = coordinationBranch) {
      const fixed = target === branch ? head : journalHead;
      const tree = { ...(target === coordinationBranch ? retained : {}), ...snapshots.get(fixed) };
      return { head: fixed, parent: parents.get(fixed), paths: Object.keys(tree), async read(path) { return tree[path]; } };
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
  return { ids, candidates, subscription, transport, repository, stored, snapshots, configuration, publish, head: () => head,
    writes: () => writes, beforeSwitch(hook: () => Promise<void>) { beforeSwitch = hook; }, fail(value: string) { mode = value; },
    options: (id: string, evidenceUrl: string) => ({ logicalId: id, configuration, stateDirectory: directory,
      subscription: subscription(id), binary, expectedHead: head, candidateEvidenceUrl: evidenceUrl, transport }) };
}
