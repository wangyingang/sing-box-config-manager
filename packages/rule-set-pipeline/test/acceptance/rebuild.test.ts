import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { rebuildRules, updateRules, readUpdateState } from '../../src/update.js';
import { githubPublication } from '../../src/publication.js';

// Explicit opt-in; append only to this issue's isolated branch, never stable paths.
const directory = process.env.RULE_REBUILD_STATE;
const evidenceFile = process.env.RULE_REBUILD_EVIDENCE;
const branch = process.env.RULE_REBUILD_BRANCH;
const binary = process.env.SING_BOX_TEST_BINARY;
test('固定官方 Release 真实重建、HTTPS 回读、历史保留与正常更新跳过', {
  skip: !directory || !evidenceFile || !branch || !binary,
}, async () => {
  assert.match(branch!, /^acceptance-issue-22-[a-zA-Z0-9._-]+$/);
  const token = process.env.GITHUB_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const publication = githubPublication(undefined, branch!);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => { requests.push(String(url)); return fetch(url, init); };
  const options = { stateDirectory: directory!, binary: binary!, token, fetch: fetcher, publication };
  const first = await updateRules({ ...options, sampleTag: '20261102130044' });
  assert.equal(first.status, 'processed', 'Use a fresh issue-22 state directory');
  if (first.status !== 'processed') return;
  const before = await readUpdateState(directory!);
  const firstStateBytes = await readFile(`${directory}/update-state.json`, 'utf8');
  // A real native failure exercises retry without appending a remote failed candidate.
  await assert.rejects(rebuildRules({ ...options, release: '20261102130044', binary: '/missing-issue-22-binary' }));
  assert.deepEqual((await readUpdateState(directory!)).state.processed, before.state.processed);
  const requestStart = requests.length;
  const rebuilt = await rebuildRules({ ...options, release: '20261102130044' });
  assert.equal(rebuilt.status, 'processed');
  if (rebuilt.status !== 'processed') return;
  const source = before.state.pinned['431467724'].source!;
  assert.equal(source.inputSha256, 'bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee');
  assert.equal(rebuilt.candidate.buildId, first.candidate.buildId);
  assert.notEqual(rebuilt.candidate.id, first.candidate.id);
  assert.ok(requests.slice(requestStart).every(url => !url.endsWith('/latest')));
  const historyReadback = [];
  for (const item of first.readback) {
    const actual = await publication.download(item.url);
    const { sha256 } = await import('../../src/release.js');
    assert.equal(sha256(actual), item.sha256);
    historyReadback.push({ ...item, retained: true });
  }
  for (const file of ['domains.json', 'domains.srs']) {
    const original: { sha256: string; byteLength: number } = first.readback.find(r => r.url.endsWith(`/${file}`))!;
    const repeated: { sha256: string; byteLength: number } = rebuilt.readback.find(r => r.url.endsWith(`/${file}`))!;
    assert.equal(repeated.sha256, original.sha256);
    assert.equal(repeated.byteLength, original.byteLength);
  }
  const start = requests.length;
  // Exercise normal update/latest while fixing its response to the sample identity.
  const skipped = await updateRules({ ...options, binary: '/must-not-run', fetch: async (url, init) => {
    requests.push(String(url));
    assert.ok(String(url).endsWith('/latest'), 'skip must not download assets');
    return fetch(`https://api.github.com/repos/v2fly/domain-list-community/releases/${source.releaseId}`, init);
  } });
  assert.equal(skipped.status, 'skipped');
  assert.equal(requests.length, start + 1);
  const after = await readUpdateState(directory!);
  assert.deepEqual(after.state.processed, before.state.processed);
  assert.equal(after.activeRuleVersion, null);
  const build = JSON.parse((await publication.download(`https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${rebuilt.candidate.metadataCommit}/candidates/${rebuilt.candidate.id}/build.json`)).toString());
  assert.equal(build.operation, 'rebuild');
  const evidence = { date: new Date().toISOString(), branch, source, first, rebuilt, historyReadback,
    firstState: JSON.parse(firstStateBytes), after, requests, build, skipped,
    skipProbe: 'normal update requested latest; acceptance adapter returned fixed sample Release metadata' };
  await writeFile(evidenceFile!, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
});
