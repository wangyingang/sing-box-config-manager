import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { activateRules, parseBuildConfiguration, readUpdateState, updateRules } from '../../src/index.js';
import { githubActivation } from '../../src/activation-transport.js';
import { githubPublication, ARTIFACT_REPOSITORY, immutableUrl } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { syntheticCandidate } from '../integration/activation-client-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const branch = process.env.RULE_CONFIGURED_ACTIVATION_BRANCH;
const directory = process.env.RULE_CONFIGURED_ACTIVATION_STATE;
const evidenceFile = process.env.RULE_CONFIGURED_ACTIVATION_EVIDENCE;

test('隔离分支依次激活官方三集，再分别切换可区分候选并核验稳定 HTTPS 与兄弟历史', {
  skip: !binary || !branch || !directory || !evidenceFile, timeout: 1_200_000,
}, async () => {
  assert.match(branch!, /^acceptance-[a-zA-Z0-9._-]+$/);
  const configuration = (await readFile(new URL('../../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8')).replace('branch: main', `branch: ${branch}`);
  const config = parseBuildConfiguration(configuration);
  const transport = githubActivation(branch!);
  const publication = githubPublication(undefined, branch!);
  const token = process.env.GITHUB_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const published = await updateRules({ stateDirectory: directory!, configuration, binary: binary!, sampleTag: '20261104112839', token });
  assert.equal(published.status, 'processed');
  const baseline = await transport.head();
  console.log('官方三集候选已发布');
  const subscription = (id: string) => {
    const formats = { binary: { url: `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/stable/${id}/domains.srs`, requiredCapabilities: [] },
      source: { url: `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/stable/${id}/domains.json`, requiredCapabilities: [] } };
    return { schemaVersion: 2, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      projections: { route: { formats }, 'dns-query': { formats }, 'dns-response': { unavailable: 'empty' } } };
  };
  const readStable = async (files: Record<string, { sha256: string; byteLength: number }>) => {
    const results = [];
    for (const [path, expected] of Object.entries(files)) {
      const url = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/${path}`;
      let found = false;
      let attempts = 0;
      for (; attempts < 240; attempts++) {
        const bytes = await transport.download(url).catch(() => undefined);
        if (bytes && sha256(bytes) === expected.sha256 && bytes.length === expected.byteLength) { found = true; break; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      assert.ok(found, `Stable URL failed to converge: ${url}`);
      results.push({ url, ...expected, observedAt: new Date().toISOString(), attempts: attempts + 1 });
    }
    return results;
  };
  const activations = [];
  for (const entry of published.results) {
    assert.ok(entry.status === 'processed');
    const result = await activateRules({ configuration, logicalId: entry.id, stateDirectory: directory!, binary: binary!,
      subscription: subscription(entry.id), candidateEvidenceUrl: entry.candidate.evidenceUrl!, expectedHead: await transport.head(), transport });
    activations.push({ result, stable: await readStable(result.activation.files) });
    console.log(`${entry.id} 官方候选已激活并核验稳定 URL`);
  }
  const switches = [];
  for (const definition of config.ruleSets) {
    const before = await readUpdateState(directory!);
    const beforeHead = await transport.head();
    const candidate = await syntheticCandidate(binary!, 'issue-39-switch', `${definition.id}-switched.invalid`,
      // Controlled synthetic fixtures are not official-source update operations.
      async files => publication.repository!.commit((await publication.repository!.snapshot()).head, files,
        'Issue #39 隔离合成候选'), { definition, target: config.target });
    const result = await activateRules({ configuration, logicalId: definition.id, stateDirectory: directory!, binary: binary!,
      subscription: subscription(definition.id), candidateEvidenceUrl: candidate.candidateEvidenceUrl, expectedHead: await transport.head(), transport });
    const after = await readUpdateState(directory!);
    assert.equal(after.activeRuleVersions[definition.id].activation.history.length, 1);

    const siblings = [];
    for (const sibling of config.ruleSets.filter(rule => rule.id !== definition.id)) {
      assert.deepEqual(after.activeRuleVersions[sibling.id], before.activeRuleVersions[sibling.id]);
      const record = before.activeRuleVersions[sibling.id];
      for (const path of [...Object.keys(record.activation.files), `${sibling.stablePath}/activation.json`]) {
        assert.deepEqual(await transport.download(immutableUrl(result.commit, path)), await transport.download(immutableUrl(beforeHead, path)));
      }
      siblings.push({ id: sibling.id, commit: record.commit, candidateId: record.activation.candidateId,
        files: record.activation.files, history: record.activation.history });
    }
    assert.notEqual(result.activation.files[`stable/${definition.id}/domains.srs`].sha256,
      before.activeRuleVersions[definition.id].activation.files[`stable/${definition.id}/domains.srs`].sha256);
    switches.push({ result, siblings, stable: [] as Awaited<ReturnType<typeof readStable>> });
    console.log(`${definition.id} 已单独切换；兄弟文件和记录逐字节核验通过`);
  }
  // Resolve CDN propagation together after preserving each intermediate Git snapshot.
  // Canonical stable URLs remain unchanged; no cache-busting query is used.
  for (const entry of switches) entry.stable = await readStable(entry.result.activation.files);
  await writeFile(evidenceFile!, JSON.stringify({ date: new Date().toISOString(), branch, baseline, published, activations, switches,
    status: await readUpdateState(directory!) }, null, 2) + '\n', { flag: 'wx' });
});
