import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { rebuildRules, updateRules, readUpdateState } from '../../src/update.js';
import { githubPublication } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';

const directory = process.env.RULE_CONFIGURED_REBUILD_STATE;
const evidenceFile = process.env.RULE_CONFIGURED_REBUILD_EVIDENCE;
const branch = process.env.RULE_CONFIGURED_REBUILD_BRANCH;
const binary = process.env.SING_BOX_TEST_BINARY;
const tag = '20261104112839';

test('固定官方 Release 增选与单集重建保留历史候选，稳定入口不切换', {
  skip: !directory || !evidenceFile || !branch || !binary, timeout: 300_000,
}, async () => {
  assert.match(branch!, /^acceptance-issue-38-[a-zA-Z0-9._-]+$/);
  const sample = await readFile(new URL('../../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8');
  const configuration = sample.replace('branch: main', `branch: ${branch}`);
  const exec = promisify(execFile);
  const token = process.env.GITHUB_TOKEN ?? (await exec('gh', ['auth', 'token'])).stdout.trim();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => { requests.push(String(url)); return fetch(url, init); };
  const publication = githubPublication(undefined, branch!);
  const options = { stateDirectory: directory!, binary: binary!, configuration, token, fetch: fetcher, publication };
  const first = await updateRules({ ...options, sampleTag: tag, selectedIds: ['ai-openai'] });
  assert.equal(first.status, 'processed', 'Use a fresh issue-38 state directory');
  const original = first.results[0];
  assert.ok(original.status === 'processed');
  const expanded = await updateRules({ ...options, sampleTag: tag, selectedIds: ['ai-openai', 'ai-anthropic'] });
  assert.deepEqual(expanded.results.map(entry => [entry.id, entry.status]), [['ai-openai', 'skipped'], ['ai-anthropic', 'processed']]);
  const anthropic = expanded.results[1];
  assert.ok(anthropic.status === 'processed');
  const before = await readUpdateState(directory!);
  const failed = await rebuildRules({ ...options, binary: '/missing-issue-38-binary', selectedIds: ['ai-openai'], release: tag });
  assert.equal(failed.status, 'failed');
  assert.deepEqual((await readUpdateState(directory!)).state.configuredProcessed, before.state.configuredProcessed);
  const requestStart = requests.length;
  const rebuilt = await rebuildRules({ ...options, selectedIds: ['ai-openai'], release: tag });
  assert.equal(rebuilt.status, 'processed');
  const repeated = rebuilt.results[0];
  assert.ok(repeated.status === 'processed');
  assert.notEqual(repeated.candidate.id, original.candidate.id);
  assert.equal(repeated.candidate.buildId, original.candidate.buildId);
  assert.equal(repeated.candidate.operation, 'rebuild');
  assert.equal(repeated.candidate.previousCandidateId, original.candidate.id);
  assert.ok(requests.slice(requestStart).every(url => !url.endsWith('/latest')));
  const after = await readUpdateState(directory!);
  assert.deepEqual(after.state.configuredProcessed, before.state.configuredProcessed);
  assert.equal(after.activeRuleVersion, null);
  for (const entry of [original, anthropic]) assert.deepEqual(after.state.candidates[entry.candidate.id], before.state.candidates[entry.candidate.id]);
  const evidence = [];
  for (const entry of [original, anthropic, repeated]) {
    const readback: { url: string; sha256: string; byteLength: number; exactBytes: true; retained: true }[] = [];
    for (const file of entry.readback) {
      const bytes = await publication.download(file.url);
      assert.equal(bytes.length, file.byteLength);
      assert.equal(sha256(bytes), file.sha256);
      readback.push({ ...file, retained: true });
    }
    const manifest = JSON.parse((await publication.download(entry.candidate.manifestUrl!)).toString());
    const build = JSON.parse((await publication.download(entry.candidate.manifestUrl!.replace('/manifest.json', '/build.json'))).toString());
    const remoteEvidence = JSON.parse((await publication.download(entry.candidate.evidenceUrl!)).toString());
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.targetVersion, '1.14.4');
    assert.equal(manifest.sourceFormatVersion, 4);
    assert.deepEqual(manifest.projections.route, manifest.projections['dns-query']);
    assert.deepEqual(manifest.projections['dns-response'], { unavailable: 'empty' });
    assert.deepEqual(manifest.artifacts.map((artifact: { format: string }) => artifact.format), ['source', 'binary']);
    assert.equal(build.source.inputSha256, before.state.pinned[String(first.releaseId)].source!.inputSha256);
    assert.equal(build.validation.status, 'passed');
    assert.equal(remoteEvidence.status, 'remote-verified');
    assert.equal(remoteEvidence.native.status, 'passed');
    for (const artifact of manifest.artifacts) {
      const file = readback.find(item => item.url === artifact.url)!;
      assert.equal(file.sha256, artifact.sha256);
      assert.equal(file.byteLength, artifact.byteLength);
      assert.equal(artifact.termCount, entry.id === 'ai-openai' ? 25 : 19);
    }
    evidence.push({ id: entry.id, candidate: entry.candidate, manifest, build, readback });
  }
  // This adapter fixes the official latest response to the sample; it does not
  // claim this historical Release is currently latest.
  const skipped = await updateRules({ ...options, selectedIds: ['ai-openai', 'ai-anthropic'], binary: '/must-not-run',
    fetch: async (url, init) => {
      assert.ok(String(url).endsWith('/latest'), 'skip must not fetch source assets');
      return fetch(`https://api.github.com/repos/v2fly/domain-list-community/releases/${first.releaseId}`, init);
    } });
  assert.equal(skipped.status, 'skipped');
  assert.ok(skipped.results[0].status === 'skipped');
  assert.equal(skipped.results[0].candidateId, original.candidate.id);
  await writeFile(evidenceFile!, JSON.stringify({ date: new Date().toISOString(), branch,
    source: before.state.pinned[String(first.releaseId)].source, first, expanded, failed, rebuilt,
    after, evidence, requests, skipped, skipProbe: 'latest metadata adapter returned fixed official sample' }, null, 2) + '\n', { flag: 'wx' });
});
