import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateRules } from '../../src/activation.js';
import type { PublicationRepository } from '../../src/publication-repository.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { configuredEnvironment } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

test('真实原生候选仅激活SRS后，远端status核验当前版本与历史回滚目标', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-binary-status-'));
  try {
    const env = await configuredEnvironment(binary!, directory);
    const first = await env.candidates(), second = await env.candidates(), id = 'ai-openai';
    const subscription: any = env.subscription(id);
    delete subscription.projections.route.formats.source;
    delete subscription.projections['dns-query'].formats.source;
    const previous = await activateRules({ ...env.options(id, first[id].evidenceUrl!), subscription });
    const current = await activateRules({ ...env.options(id, second[id].evidenceUrl!), subscription });
    assert.deepEqual(Object.keys(current.activation.files), [`stable/${id}/domains.srs`]);
    assert.equal(env.snapshots.get(env.head())![`stable/${id}/domains.json`], undefined);
    const journal = { schemaVersion: 1, id: 'binary-status', generation: 1, maintenance: 'open', targetBranch: env.transport.branch,
      state: { schemaVersion: 1, pinned: {}, processed: {}, candidates: {} } };
    const repository: PublicationRepository = {
      branch: env.transport.branch,
      async snapshot() {
        const files = new Map(Object.entries(env.snapshots.get(env.head())!));
        for (const [url, bytes] of env.stored) files.set(new URL(url).pathname.split('/').slice(4).join('/'), bytes);
        files.set('pipeline/state.json', encode(journal));
        files.set('pipeline/identity.json', encode({ schemaVersion: 1, id: journal.id, targetBranch: journal.targetBranch }));
        return { head: env.head(), paths: [...files.keys()], async read(path) { return files.get(path); } };
      },
      async commit() { throw new Error('status must not write'); },
    };
    const writes = env.writes();
    const result = await readRemoteStatus({ repository, binary, activation: env.transport,
      publication: { async commit() { throw new Error('status must not write'); }, download: env.transport.download } });
    assert.equal(result.activeRuleVersions[id].activation.candidateId, second[id].id);
    assert.equal(result.activeRuleVersions[id].candidate.verification, 'native');
    assert.deepEqual(result.rollbackTargets[id].map(target => [target.commit, target.candidateId, target.verification]),
      [[previous.commit, first[id].id, 'native']]);
    assert.deepEqual(result.pendingOperations, []);
    assert.equal(env.writes(), writes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
