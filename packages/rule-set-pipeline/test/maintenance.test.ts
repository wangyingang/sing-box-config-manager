import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gitMaintenanceRefs } from '../src/maintenance-refs.js';
import { manageMaintenance } from '../src/maintenance.js';
import { githubBaselineTransport } from '../src/maintenance-baseline-transport.js';
import { initializeRemoteState, STATE_PATH } from '../src/remote-state.js';
import type { PublicationRepository } from '../src/publication-repository.js';
import { GitHubHttpError, type PublicationTransport } from '../src/publication.js';

const branch = 'acceptance-issue-52';
const now = new Date('2026-11-07T12:00:00Z');
const startAt = '2026-11-01T12:00:00Z';

function remote(initial: Record<string, Buffer> = {}) {
  let head = 'a'.repeat(40), parent: string | undefined;
  let files = { ...initial };
  let commits = 0;
  const repository: PublicationRepository = {
    branch,
    async snapshot() {
      const tree = files;
      return { head, parent, paths: Object.keys(tree), async read(path) { return tree[path]; } };
    },
    async commit(expectedHead, writes) {
      if (head !== expectedHead) throw new Error('PUBLICATION_CONFLICT');
      parent = head;
      head = (++commits).toString(16).padStart(40, '0');
      files = { ...files, ...writes };
      return head;
    },
  };
  const publication: PublicationTransport = {
    repository,
    async commit() { throw new Error('Maintenance must never publish a candidate'); },
    async download() { throw new Error('Unexpected candidate download'); },
  };
  const options = { repository, publication, now, refs: async () => [
    { ref: 'refs/heads/acceptance-other-task', head: 'b'.repeat(40) },
    { ref: 'refs/tags/other-task', head: 'c'.repeat(40) },
  ] };
  return { repository, options };
}

test('清理周期区分关闭、未到期和到期但无须清理，预览和无须清理均不写入', async () => {
  const { repository, options } = remote();
  const { head } = await initializeRemoteState(repository, branch);
  const preview = () => manageMaintenance({ ...options, action: 'preview' });
  assert.equal((await preview()).status, 'disabled');
  assert.equal((await manageMaintenance({ ...options, action: 'enter', schedule: { periodDays: 7, startAt } })).status, 'not-due');
  assert.equal((await manageMaintenance({ ...options, action: 'enter', schedule: { periodDays: 6, startAt } })).status, 'no-cleanup');
  assert.equal((await repository.snapshot()).head, head);
});


test('远端 ready 记录损坏时拒绝恢复和退出', async () => {
  const { repository, options } = remote();
  const { head, journal } = await initializeRemoteState(repository, branch);
  const id = '941f6c16-53dc-49f6-89f9-6549d93723b2';
  const corrupt = { ...journal, maintenance: 'maintenance', generation: 2, maintenanceRun: {
    id, generation: 2, phase: 'ready', oldHeads: { stable: head, journal: head }, isolatedHead: head, plan: {},
  } };
  const corruptHead = await repository.commit(head, { [STATE_PATH]: Buffer.from(JSON.stringify(corrupt)) }, 'Corrupt plan');
  await assert.rejects(manageMaintenance({ ...options, action: 'resume' }), /REMOTE_STATE_CORRUPT: maintenance run/);
  await assert.rejects(manageMaintenance({ ...options, action: 'abort', maintenanceId: id }), /REMOTE_STATE_CORRUPT: maintenance run/);
  assert.equal((await repository.snapshot()).head, corruptHead);
});

test('GitHub 临时分支创建回复丢失后采用已有的无父提交，拒绝采用冲突内容', async () => {
  const ref = 'maintenance-941f6c16-53dc-49f6-89f9-6549d93723b2-files';
  const root = 'a'.repeat(40), tree = 'b'.repeat(40), blob = 'c'.repeat(40);
  const path = 'pipeline/baseline.json', content = Buffer.from('{}');
  let created = false, commitCount = 0;
  const transport = githubBaselineTransport(async (args, input) => {
    const endpoint = args[1].replace('repos/wangyingang/sing-box-rule-artifacts', '');
    switch (endpoint) {
      case '': return { private: false };
      case `/git/ref/heads/${ref}`:
        if (!created) throw new GitHubHttpError(404, 'Scratch ref absent');
        return { object: { sha: root } };
      case '/git/blobs': return { sha: blob };
      case '/git/trees':
        assert.deepEqual(input, { tree: [{ path, mode: '100644', type: 'blob', sha: blob }] });
        return { sha: tree };
      case '/git/commits':
        assert.deepEqual(input, { message: 'prepare', tree, parents: [] });
        commitCount++;
        return { sha: root };
      case '/git/refs':
        assert.deepEqual(input, { ref: `refs/heads/${ref}`, sha: root });
        assert.ok(!created);
        created = true;
        throw new Error('Create response lost');
      case `/git/commits/${root}`: return { tree: { sha: tree }, parents: [] };
      case `/git/trees/${tree}?recursive=1`: return { tree: [{ path, type: 'blob', mode: '100644', sha: blob }] };
      case `/git/blobs/${blob}`: return { encoding: 'base64', content: content.toString('base64'), size: content.length };
      default: throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
  });
  assert.equal(await transport.stage(ref, undefined, { [path]: content }, 'prepare'), root);
  assert.equal(await transport.stage(ref, undefined, { [path]: content }, 'prepare'), root);
  await assert.rejects(transport.stage(ref, undefined, { [path]: Buffer.from('conflict') }, 'prepare'), /Baseline content conflict/);
  assert.equal(commitCount, 1);
});

test('重试拒绝父链相同但篡改继承文件的临时分支', async () => {
  const ref = 'maintenance-941f6c16-53dc-49f6-89f9-6549d93723b2-metadata';
  const parent = 'a'.repeat(40), commit = 'b'.repeat(40), baseTree = 'c'.repeat(40), tree = 'd'.repeat(40);
  const inherited = { path: 'README.md', mode: '100644', type: 'blob', sha: 'e'.repeat(40) };
  const transport = githubBaselineTransport(async args => {
    const endpoint = args[1].replace('repos/wangyingang/sing-box-rule-artifacts', '');
    switch (endpoint) {
      case '': return { private: false };
      case `/git/ref/heads/${ref}`: return { object: { sha: commit } };
      case `/git/commits/${commit}`: return { tree: { sha: tree }, parents: [{ sha: parent }] };
      case `/git/commits/${parent}`: return { tree: { sha: baseTree }, parents: [] };
      case `/git/trees/${baseTree}?recursive=1`: return { tree: [inherited] };
      case `/git/trees/${tree}?recursive=1`: return { tree: [{ ...inherited, sha: 'f'.repeat(40) }] };
      default: throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
  });
  await assert.rejects(transport.stage(ref, parent, {}, 'prepare'), /Baseline inherited content conflict.*README.md/);
});

test('Git 原子切换拒绝任何与租约不符的引用，即使它已经指向目标提交', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-ref-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote.git');
  const git = async (...args: string[]) => (await promisify(execFile)('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args,
  ], { cwd: directory })).stdout.trim();
  await git('init', '--bare', remote);
  const tree = await git('--git-dir', remote, 'hash-object', '-w', '-t', 'tree', '/dev/null');
  const before = await git('--git-dir', remote, 'commit-tree', tree, '-m', 'before');
  const after = await git('--git-dir', remote, 'commit-tree', tree, '-m', 'after');
  const main = 'refs/heads/stable', journal = 'refs/heads/journal';
  await git('--git-dir', remote, 'update-ref', main, before);
  await git('--git-dir', remote, 'update-ref', journal, after);
  const transport = gitMaintenanceRefs(remote);
  const changes = [main, journal].map(ref => ({ ref, before, after }));
  await assert.rejects(transport.update(changes));
  assert.deepEqual(Object.fromEntries((await transport.list()).map(({ ref, head }) => [ref, head])), { [main]: before, [journal]: after });

  await git('--git-dir', remote, 'update-ref', journal, before);
  await git('--git-dir', remote, 'config', 'receive.advertiseAtomic', 'false');
  await assert.rejects(transport.update(changes));
  assert.ok((await transport.list()).every(ref => ref.head === before));
  await git('--git-dir', remote, 'config', 'receive.advertiseAtomic', 'true');
  await transport.update(changes);
  assert.ok((await transport.list()).every(ref => ref.head === after));
  await transport.update([{ ref: journal, before: after }]);
  assert.deepEqual(await transport.list(), [{ ref: main, head: after }]);
});
