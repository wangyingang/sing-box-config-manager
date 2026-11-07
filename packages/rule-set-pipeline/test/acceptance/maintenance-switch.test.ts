import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { githubActivation } from '../../src/activation-transport.js';
import { checkRules } from '../../src/check-rules.js';
import { branchRef, gitMaintenanceRefs } from '../../src/maintenance-refs.js';
import { manageMaintenance } from '../../src/maintenance.js';
import { createGitCommit } from '../../src/publication-repository.js';
import { ARTIFACT_REPOSITORY, ghJson, githubPublication } from '../../src/publication.js';
import { initializeRemoteState } from '../../src/remote-state.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { upstream } from '../integration/configured-activation-fixture.js';

test('GitHub 隔离分支切换和 HTTPS 回读中断后从远端完成收尾', {
  skip: process.env.RULE_MAINTENANCE_SWITCH_PROBE !== '1', timeout: 900_000,
}, async t => {
  const binary = process.env.SING_BOX_TEST_BINARY;
  assert.ok(binary, 'Set SING_BOX_TEST_BINARY to sing-box 1.14.4');
  const target = `acceptance-issue-54-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'rule-maintenance-switch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const refs = gitMaintenanceRefs();
  const api = (path: string, input?: unknown) => ghJson(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  const root = await createGitCommit(api, { 'README.md': Buffer.from(`Isolation probe ${target}\n`) }, target);
  await api('git/refs', { ref: branchRef(target), sha: root });

  const publication = githubPublication(undefined, target);
  const repository = publication.repository!;
  const activation = githubActivation(target);
  const logicalId = 'ai-anthropic';
  const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/stable/${logicalId}`;
  const formats = {
    binary: { url: `${prefix}/domains.srs`, requiredCapabilities: [] },
    source: { url: `${prefix}/domains.json`, requiredCapabilities: [] },
  };
  const subscription = { schemaVersion: 2, systemRuleSetId: logicalId, targetVersion: '1.14.4', sourceFormatVersion: 4,
    projections: { route: { formats }, 'dns-query': { formats }, 'dns-response': { unavailable: 'empty' } } };
  let maintenanceId: string | undefined;
  try {
    await initializeRemoteState(repository, target);
    const configuration = (await readFile(new URL('../../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8'))
      .replace('branch: main', `branch: ${target}`);
    const options = { binary, configuration, publication, activation, selectedIds: [logicalId],
      subscriptions: { [logicalId]: subscription }, stateDirectory: join(directory, 'before') };
    const first = await checkRules({ ...options, fetch: upstream(1).fetcher });
    assert.equal(first.results[0]?.status, 'activated', JSON.stringify(first));
    const latest = upstream(2, { anthropic: 'domain:second-acceptance.example' });
    const second = await checkRules({ ...options, fetch: latest.fetcher });
    assert.equal(second.results[0]?.status, 'activated', JSON.stringify(second));
    const before = await readRemoteStatus({ ...options, repository });
    const stable = await publication.download(formats.binary.url);

    let disconnect = true;
    let switches = 0;
    const maintenance = { repository, binary, activation, publication: { ...publication, async download(url: string) {
      if (disconnect && url.startsWith(prefix)) throw new Error('Injected stable URL readback outage');
      return publication.download(url);
    } }, refTransport: { ...refs, async update(changes: Parameters<typeof refs.update>[0]) {
      await refs.update(changes);
      if (changes.some(change => change.ref === branchRef(target))) {
        switches++;
        throw new Error('Injected lost push reply');
      }
    } } };
    const entered = await manageMaintenance({ ...maintenance, action: 'enter', manual: true });
    maintenanceId = entered.run?.id;
    assert.equal(entered.status, 'isolated', JSON.stringify(entered));
    const prepared = await manageMaintenance({ ...maintenance, action: 'prepare' });
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    assert.equal(prepared.run?.phase, 'prepared');
    if (prepared.run?.phase !== 'prepared') throw new Error('Expected prepared baseline');
    const switched = await manageMaintenance({ ...maintenance, action: 'switch' });
    assert.equal(switched.status, 'failed', JSON.stringify(switched));
    assert.match(JSON.stringify(switched), /Injected stable URL readback outage/);
    assert.equal((await repository.snapshot()).head, prepared.run.baseline.stages.journal.head);
    assert.ok((await refs.list()).some(({ ref }) => ref === branchRef(`maintenance-${maintenanceId}-old-journal`)));
    disconnect = false;
    const completed = await manageMaintenance({ ...maintenance, action: 'resume' });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(switches, 1);
    assert.deepEqual(await publication.download(formats.binary.url), stable);
    const after = await readRemoteStatus({ ...options, repository });
    assert.equal(after.activeRuleVersions[logicalId].activation.id, before.activeRuleVersions[logicalId].activation.id);
    assert.deepEqual(after.rollbackTargets[logicalId], []);
    assert.ok(!(await refs.list()).some(({ ref }) => ref.startsWith(`refs/heads/maintenance-${maintenanceId}-`)));
    const checked = await checkRules({ ...options, fetch: latest.fetcher, stateDirectory: join(directory, 'fresh') });
    assert.equal(checked.results[0]?.status, 'unchanged', JSON.stringify(checked));
    t.diagnostic(JSON.stringify({ target, maintenanceId, generation: after.generation, oldHead: before.head,
      baselineHead: prepared.run.baseline.stages.journal.head, reopenedHead: after.head, sha256: after.activeRuleVersions[logicalId].activation.files[`stable/${logicalId}/domains.srs`].sha256 }));
  } finally {
    const owned = (await refs.list()).filter(({ ref }) => ref === branchRef(target)
      || maintenanceId && ref.startsWith(`refs/heads/maintenance-${maintenanceId}-`));
    await refs.update(owned.map(({ ref, head }) => ({ ref, before: head })));
    const remaining = new Set((await refs.list()).map(({ ref }) => ref));
    assert.ok(owned.every(({ ref }) => !remaining.has(ref)), 'Isolation probe left temporary refs');
  }
});
