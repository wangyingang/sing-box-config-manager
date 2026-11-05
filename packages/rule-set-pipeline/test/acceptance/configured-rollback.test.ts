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
const branch = process.env.RULE_CONFIGURED_ROLLBACK_BRANCH;
const directory = process.env.RULE_CONFIGURED_ROLLBACK_STATE;
const evidenceFile = process.env.RULE_CONFIGURED_ROLLBACK_EVIDENCE;

test('隔离分支通过 CLI 逐集回滚真实三集，恢复历史字节且兄弟版本不变', {
  skip: !binary || !branch || !directory || !evidenceFile, timeout: 1_200_000,
}, async () => {
  assert.match(branch!, /^acceptance-[a-zA-Z0-9._-]+$/);
  const configuration = (await readFile(new URL('../../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8')).replace('branch: main', `branch: ${branch}`);
  const config = parseBuildConfiguration(configuration);
  const transport = githubActivation(branch!), publication = githubPublication(undefined, branch!);
  const productionBefore = await githubActivation().head();
  const token = process.env.GITHUB_TOKEN ?? (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim();
  const published = await updateRules({ stateDirectory: directory!, configuration, binary: binary!, sampleTag: '20261104112839', token });
  assert.equal(published.status, 'processed');
  const subscription = (id: string) => {
    const formats = { binary: { url: `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/stable/${id}/domains.srs`, requiredCapabilities: [] },
      source: { url: `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/stable/${id}/domains.json`, requiredCapabilities: [] } };
    return { schemaVersion: 2, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      projections: { route: { formats }, 'dns-query': { formats }, 'dns-response': { unavailable: 'empty' } } };
  };
  const activations: Awaited<ReturnType<typeof activateRules>>[] = [];
  for (const entry of published.results) {
    assert.ok(entry.status === 'processed');
    activations.push(await activateRules({ configuration, logicalId: entry.id, stateDirectory: directory!, binary: binary!,
      subscription: subscription(entry.id), candidateEvidenceUrl: entry.candidate.evidenceUrl!, expectedHead: await transport.head(), transport }));
    console.log(`${entry.id} 官方候选已激活`);
  }
  const switches = [];
  for (const definition of config.ruleSets) {
    const candidate = await syntheticCandidate(binary!, 'issue-40-switch', `${definition.id}-switched.invalid`,
      files => publication.commit(files, 'Issue #40 隔离候选'), { definition, target: config.target });
    const result = await activateRules({ configuration, logicalId: definition.id, stateDirectory: directory!, binary: binary!,
      subscription: subscription(definition.id), candidateEvidenceUrl: candidate.candidateEvidenceUrl, expectedHead: await transport.head(), transport });
    switches.push({ candidate, result });
  }
  const configPath = `${directory}/rollback-config.yml`;
  await writeFile(configPath, configuration);
  const rollbacks = [];
  for (const historical of activations) {
    const id = historical.activation.logicalId!;
    const before = await readUpdateState(directory!), beforeHead = await transport.head();
    const subscriptionPath = `${directory}/${id}-subscription.json`;
    await writeFile(subscriptionPath, JSON.stringify(subscription(id)));
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'rollback',
      '--config', configPath, '--id', id, '--state', directory!, '--activation', historical.commit,
      '--subscription', subscriptionPath, '--branch', branch!, '--expected-head', beforeHead, '--binary', binary!], { timeout: 180_000 });
    const result = JSON.parse(stdout) as Awaited<ReturnType<typeof activateRules>>;
    assert.equal(result.activation.candidateId, historical.activation.candidateId);
    assert.equal(result.activation.operation, 'rollback');
    const after = await readUpdateState(directory!);
    assert.equal(after.activeRuleVersions[id].activation.history.length, 2);
    assert.deepEqual(result.activation.files, historical.activation.files);
    for (const path of Object.keys(result.activation.files)) {
      const restored = await transport.download(immutableUrl(result.commit, path));
      assert.deepEqual(restored, await transport.download(immutableUrl(historical.commit, path)));
      assert.notDeepEqual(restored, await transport.download(immutableUrl(beforeHead, path)));
    }
    const siblings = [];
    for (const sibling of config.ruleSets.filter(rule => rule.id !== id)) {
      assert.deepEqual(after.activeRuleVersions[sibling.id], before.activeRuleVersions[sibling.id]);
      const record = before.activeRuleVersions[sibling.id];
      for (const path of [...Object.keys(record.activation.files), `${sibling.stablePath}/activation.json`]) {
        assert.deepEqual(await transport.download(immutableUrl(result.commit, path)), await transport.download(immutableUrl(beforeHead, path)));
      }
      siblings.push({ id: sibling.id, ...record });
    }
    rollbacks.push({ result, siblings, stable: [] as { url: string; sha256: string; byteLength: number; observedAt: string }[] });
    console.log(`${id} 已通过 CLI 回滚；历史字节和兄弟文件及记录核验通过`);
  }
  for (const entry of rollbacks) {
    for (const [path, expected] of Object.entries(entry.result.activation.files)) {
      const url = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/${path}`;
      const deadline = Date.now() + 480_000;
      let found = false;
      while (Date.now() < deadline) {
        const bytes = await transport.download(url).catch(() => undefined);
        if (bytes && sha256(bytes) === expected.sha256 && bytes.length === expected.byteLength) { found = true; break; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      assert.ok(found, `Stable URL failed to converge: ${url}`);
      entry.stable.push({ url, ...expected, observedAt: new Date().toISOString() });
    }
  }
  const productionAfter = await githubActivation().head();
  assert.equal(productionAfter, productionBefore);
  await writeFile(evidenceFile!, JSON.stringify({ date: new Date().toISOString(), branch, productionBefore, productionAfter,
    published, activations, switches, rollbacks, status: await readUpdateState(directory!) }, null, 2) + '\n', { flag: 'wx' });
});
