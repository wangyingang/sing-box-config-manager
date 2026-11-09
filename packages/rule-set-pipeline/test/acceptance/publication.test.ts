import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { updateRules, readUpdateState } from '../../src/update.js';

// Explicit opt-in: creates public immutable commits; never runs in ordinary CI.
const directory = process.env.RULE_PUBLICATION_STATE;
const evidenceFile = process.env.RULE_PUBLICATION_EVIDENCE;
const binary = process.env.SING_BOX_TEST_BINARY;
test('固定官方样本真实发布、HTTPS 回读及持久化成功证据', { skip: !directory || !evidenceFile || !binary }, async () => {
  const token = process.env.GITHUB_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => { requests.push(String(url)); return fetch(url, init); };
  const result = await updateRules({ stateDirectory: directory!, binary: binary!, sampleTag: '20261102130044', token, fetch: fetcher });
  assert.equal(result.status, 'processed', 'Use a fresh isolated state directory for this acceptance run');
  if (result.status !== 'processed') return;
  const persisted = await readUpdateState(directory!);
  const source = persisted.state.pinned['431467724'].source!;
  assert.equal(source.tag, '20261102130044');
  assert.equal(source.inputSha256, 'bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee');
  assert.equal(result.readback.length, 7);
  assert.deepEqual(persisted.activeRuleVersions, {});
  const evidence = { date: new Date().toISOString(), source, result, persisted, requests };
  await writeFile(evidenceFile!, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
});
