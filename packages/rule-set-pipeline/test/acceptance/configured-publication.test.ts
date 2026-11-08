import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { updateRules, readUpdateState } from '../../src/update.js';
import { sha256 } from '../../src/release.js';

const directory = process.env.RULE_CONFIGURED_PUBLICATION_STATE;
const evidenceFile = process.env.RULE_CONFIGURED_PUBLICATION_EVIDENCE;
const branch = process.env.RULE_CONFIGURED_PUBLICATION_BRANCH;
const binary = process.env.SING_BOX_TEST_BINARY;

test('固定官方三集在隔离分支发布候选并核验 HTTPS 字节', {
  skip: !directory || !evidenceFile || !branch || !binary, timeout: 240_000,
}, async () => {
  assert.match(branch!, /^acceptance-[a-zA-Z0-9._-]+$/);
  const sample = await readFile(new URL('../../config/rulesets.yml', import.meta.url), 'utf8');
  const configuration = sample.replace('branch: main', `branch: ${branch}`);
  const token = process.env.GITHUB_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => { requests.push(String(url)); return fetch(url, init); };
  const result = await updateRules({ stateDirectory: directory!, binary: binary!, configuration,
    sampleTag: '20261104112839', token, fetch: fetcher });
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.results.map(entry => [entry.id, entry.status]), [
    ['openai', 'processed'], ['anthropic', 'processed'], ['google-deepmind', 'processed'],
  ]);
  const persisted = await readUpdateState(directory!);
  const source = persisted.state.pinned[String(result.releaseId)].source!;
  assert.equal(source.tag, '20261104112839');
  assert.equal(requests.filter(url => url.endsWith(`/assets/${source.yaml.id}`)).length, 1);
  assert.equal(requests.filter(url => url.endsWith(`/assets/${source.checksum.id}`)).length, 1);
  assert.equal(persisted.activeRuleVersion, null);
  const evidence = [];
  for (const [index, entry] of result.results.entries()) {
    assert.ok(entry.status === 'processed');
    const manifestResponse = await fetch(entry.candidate.manifestUrl!, { cache: 'no-store' });
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.targetVersion, '1.14.4');
    assert.equal(manifest.sourceFormatVersion, 4);
    assert.deepEqual(manifest.projections.route, manifest.projections['dns-query']);
    assert.deepEqual(manifest.projections['dns-response'], { unavailable: 'empty' });
    assert.deepEqual(manifest.artifacts.map((artifact: { format: string }) => artifact.format), ['source', 'binary']);
    const reportResponse = await fetch(entry.candidate.manifestUrl!.replace('/manifest.json', '/conversion-report.json'), { cache: 'no-store' });
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.inputCount, [25, 19, 49][index]);
    const artifacts = [];
    for (const artifact of manifest.artifacts) {
      const response = await fetch(artifact.url, { cache: 'no-store' });
      assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.length, artifact.byteLength);
      assert.equal(sha256(bytes), artifact.sha256);
      assert.equal(artifact.termCount, report.outputTermCount);
      assert.deepEqual(artifact.requiredCapabilities, []);
      artifacts.push({ url: artifact.url, format: artifact.format, sha256: artifact.sha256,
        byteLength: artifact.byteLength, termCount: artifact.termCount });
    }
    const buildResponse = await fetch(entry.candidate.manifestUrl!.replace('/manifest.json', '/build.json'), { cache: 'no-store' });
    assert.equal(buildResponse.status, 200);
    const build = await buildResponse.json();
    assert.equal(build.id, entry.id);
    assert.equal(build.definition.list, ['openai', 'anthropic', 'google-deepmind'][index]);
    assert.equal(build.source.inputSha256, source.inputSha256);
    assert.equal(build.validation.status, 'passed');
    const remoteEvidence = await fetch(entry.candidate.evidenceUrl!, { cache: 'no-store' });
    assert.equal(remoteEvidence.status, 200);
    const readback = await remoteEvidence.json();
    assert.equal(readback.status, 'remote-verified');
    assert.equal(readback.native.status, 'passed');
    evidence.push({ id: entry.id, candidate: entry.candidate, manifestUrl: entry.candidate.manifestUrl,
      evidenceUrl: entry.candidate.evidenceUrl, inputCount: report.inputCount,
      outputTermCount: report.outputTermCount, artifacts, readbackCount: readback.readback.length });
  }
  await writeFile(evidenceFile!, JSON.stringify({ date: new Date().toISOString(), branch, source,
    requestCounts: { yaml: 1, checksum: 1 }, results: evidence }, null, 2) + '\n', { flag: 'wx' });
});
