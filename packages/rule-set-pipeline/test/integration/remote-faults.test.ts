import { parseBuildConfiguration } from '../../src/configuration.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateRules } from '../../src/update.js';
import { initializeRemoteState, readRemoteState, STATE_PATH } from '../../src/remote-state.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { sha256 } from '../../src/release.js';
import { memoryRepository } from '../fixtures/publication-repository.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const tag = '20261104112839';
const official = parseBuildConfiguration(await readFile(new URL('../../config/rulesets.yml', import.meta.url), 'utf8'));
const configuration = JSON.stringify({ ...official, target: { ...official.target, branch: 'acceptance-recovery' }, ruleSets: [official.ruleSets[0]] });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const candidateWrites = (remote: ReturnType<typeof memoryRepository>) => remote.writes
  .flatMap(files => Object.keys(files).filter(path => path.startsWith('candidates/')));

function upstream() {
  const input = JSON.stringify({ lists: [{ name: 'openai', length: 1, rules: ['domain:openai.com'] }] });
  let latestAllowed = true;
  const fetcher: typeof fetch = async url => {
    const path = String(url);
    if (path.endsWith('/latest') && !latestAllowed) throw new Error('Recovery must not query latest');
    if (path.endsWith('/latest') || path.endsWith('/releases/42')) return Response.json({ id: 42, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({ id: 11 + i, name,
        browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path.endsWith('/assets/11')) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected source request: ${path}`);
  };
  return { fetcher, forbidLatest() { latestAllowed = false; } };
}

async function isolated(run: (directory: string, remote: ReturnType<typeof memoryRepository>, source: ReturnType<typeof upstream>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-faults-'));
  const remote = memoryRepository();
  try {
    await initializeRemoteState(remote.repository, 'acceptance-recovery');
    await run(directory, remote, upstream());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const stageFile of ['domains.json', 'manifest.json', 'readback.json']) {
  test(`${stageFile} 已提交但回复与核实连接丢失，新机器恢复同一候选`, { skip: !binary }, async () => isolated(async (directory, remote, source) => {
    let offline = false;
    const repository = { ...remote.repository, async snapshot(branch?: string) {
      if (offline) throw new Error('Connection unavailable during reconciliation');
      return remote.repository.snapshot(branch);
    } };
    const publication = { ...remote.publication, repository };
    remote.fault((files, applied) => {
      if (applied && Object.keys(files).some(path => path.endsWith(`/${stageFile}`))) {
        offline = true; throw new Error('Commit response lost');
      }
    });
    const common = { binary: binary!, configuration, publication, fetch: source.fetcher };
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'first') }), /PUBLICATION_PENDING/);
    const interrupted = await readRemoteState(remote.repository);
    const candidate = Object.values(interrupted.journal.state.candidates)[0];
    assert.ok(candidate, 'The remote operation must identify the in-flight candidate');
    assert.equal(interrupted.journal.state.pendingOperation?.status, 'pending');
    const committedStage = `candidates/${candidate.id}/${stageFile}`;
    assert.ok(await interrupted.snapshot.read(committedStage));
    offline = false; remote.fault(undefined); source.forbidLatest();
    const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new-machine') });
    assert.equal(recovered.status, 'processed');
    const status = await readRemoteStatus({ repository, publication, binary });
    assert.deepEqual(Object.keys(status.state.candidates), [candidate.id]);
    assert.equal(status.candidateAvailability[candidate.id].status, 'available');
    assert.equal(status.candidateAvailability[candidate.id].verification, 'native');
    assert.equal(status.pendingOperations.length, 0);
    const paths = candidateWrites(remote);
    assert.equal(paths.length, 7);
    assert.equal(new Set(paths).size, 7);
    assert.ok(!remote.writes.some(files => Object.keys(files).some(path => path.startsWith('stable/'))));
  }));
}

test('本地缓存不可替换时保留远端成功，新目录不会重复发布候选', { skip: !binary }, async () => isolated(async (directory, remote, source) => {
  const stateDirectory = join(directory, 'first');
  await mkdir(join(stateDirectory, 'update-state.json'), { recursive: true });
  const common = { binary: binary!, configuration, publication: remote.publication, fetch: source.fetcher };
  const first = await updateRules({ ...common, stateDirectory });
  assert.equal(first.status, 'processed');
  assert.match(first.cacheWarning ?? '', /REMOTE_STATE_SAVED_LOCAL_CACHE_PENDING/);
  const before = await readRemoteStatus({ repository: remote.repository, publication: remote.publication, binary });
  const candidateId = Object.keys(before.state.candidates)[0];
  assert.equal(before.state.candidates[candidateId].status, 'verified');
  const secondDirectory = join(directory, 'new-machine');
  const second = await updateRules({ ...common, stateDirectory: secondDirectory });
  assert.equal(second.status, 'skipped');
  assert.equal(candidateWrites(remote).length, 7);
  const cache = JSON.parse(await readFile(join(secondDirectory, 'update-state.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache.candidates), [candidateId]);
}));

for (const stageFile of ['domains.json', 'manifest.json', 'readback.json']) {
  for (const change of ['maintenance', 'generation', 'head'] as const) {
    test(`${stageFile} 提交前发生 ${change} 变化，旧操作不会写入新的 head`, { skip: !binary }, async () => isolated(async (directory, remote, source) => {
      let injected = false;
      remote.fault((files, applied) => {
        if (applied || injected || !Object.keys(files).some(path => path.endsWith(`/${stageFile}`))) return;
        injected = true;
        // Another writer changes the authoritative repository between the
        // operation's last read and its attempted compare-and-swap commit.
        const latest = JSON.parse(remote.writes.at(-1)![STATE_PATH].toString());
        if (change === 'head') remote.replace('pipeline/other-operation.json', Buffer.from('{}'));
        else {
          if (change === 'maintenance') latest.maintenance = 'maintenance';
          else {
            latest.generation++;
            if (latest.state.pendingOperation) latest.state.pendingOperation.generation = latest.generation;
            for (const candidate of Object.values(latest.state.candidates) as { generation: number }[]) candidate.generation = latest.generation;
          }
          remote.replace(STATE_PATH, encode(latest));
        }
      });
      await assert.rejects(updateRules({ stateDirectory: join(directory, 'old-run'), binary: binary!, configuration,
        publication: remote.publication, fetch: source.fetcher }), /PUBLICATION_(PENDING|CONFLICT)/);
      assert.equal(injected, true);
      const status = await readRemoteStatus({ repository: remote.repository, publication: remote.publication });
      const candidateId = Object.keys(status.state.candidates)[0];
      assert.ok(candidateId);
      assert.equal(candidateWrites(remote).filter(path => path.endsWith(`/${stageFile}`)).length, 0);
      assert.ok(!candidateWrites(remote).includes(`candidates/${candidateId}/readback.json`));
      if (change === 'maintenance') assert.equal(status.maintenance, 'maintenance');
      if (change === 'generation') assert.equal(status.generation, 2);
      assert.ok(status.pendingOperations.length > 0);
    }));
  }
}

for (const missing of ['retained', 'domains.srs', 'build.json', 'readback.json', 'changed-current-bytes']) {
  test(`成功处理后 ${missing} 不再保留，不返回旧候选成功地址`, { skip: !binary }, async () => isolated(async (directory, remote, source) => {
    const common = { binary: binary!, configuration, publication: remote.publication, fetch: source.fetcher };
    await updateRules({ ...common, stateDirectory: join(directory, 'first') });
    const { journal } = await readRemoteState(remote.repository);
    const candidateId = Object.keys(journal.state.candidates)[0];
    if (missing === 'retained') {
      journal.state.candidates[candidateId].retained = false;
      remote.replace(STATE_PATH, encode(journal));
    } else if (missing === 'changed-current-bytes') remote.replace(`candidates/${candidateId}/domains.srs`, Buffer.from('different retained baseline'));
    else remote.remove(`candidates/${candidateId}/${missing}`);
    const writesBefore = remote.writes.length;
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'fresh') }), /CANDIDATE_UNAVAILABLE/);
    assert.equal(remote.writes.length, writesBefore);
    const status = await readRemoteStatus({ repository: remote.repository, publication: remote.publication });
    assert.notEqual(status.candidateAvailability[candidateId].status, 'available');
    assert.equal(status.candidateAvailability[candidateId].evidenceUrl, undefined);
    assert.equal(Object.keys(status.state.configuredProcessed!['openai']).length, 1, 'Processed fact is retained separately from candidate availability');
  }));
}

for (const failure of ['missing-state', 'corrupt-state', 'read-error']) {
  test(`恢复入口遇到 ${failure} 时停止，不下载来源或写入候选`, async () => isolated(async (directory, remote) => {
    if (failure === 'missing-state') remote.remove(STATE_PATH);
    if (failure === 'corrupt-state') remote.replace(STATE_PATH, Buffer.from('{invalid-json'));
    const repository = failure === 'read-error'
      ? { ...remote.repository, async snapshot() { throw new Error('Remote state HTTP 503'); } }
      : remote.repository;
    let sourceReads = 0;
    const writesBefore = remote.writes.length;
    await assert.rejects(updateRules({ stateDirectory: join(directory, 'fresh'), binary: '/must-not-run', configuration,
      publication: { ...remote.publication, repository }, fetch: async () => { sourceReads++; throw new Error('Source must not be read'); } }),
    failure === 'missing-state' ? /STATE_MISSING/ : failure === 'corrupt-state' ? /STATE_CORRUPT/ : /HTTP 503/);
    assert.equal(sourceReads, 0);
    assert.equal(remote.writes.length, writesBefore);
    assert.equal(candidateWrites(remote).length, 0);
  }));
}
