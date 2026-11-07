import assert from 'node:assert/strict';
import test from 'node:test';
import { manageMaintenance } from '../src/maintenance.js';
import { initializeRemoteState, STATE_PATH } from '../src/remote-state.js';
import type { PublicationRepository } from '../src/publication-repository.js';
import type { PublicationTransport } from '../src/publication.js';

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
