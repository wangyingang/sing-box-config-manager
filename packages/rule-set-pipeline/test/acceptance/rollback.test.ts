import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import contract from '../../contracts/rule-subscription.example.json' with { type: 'json' };
import { activateRules, rollbackRules } from '../../src/activation.js';
import { githubActivation } from '../../src/activation-transport.js';
import { compileRecipe } from '../../../config-compiler/src/index.js';
import { createSingBoxChecker } from '../../../config-compiler/src/publisher.js';
import { subscriptionInput } from '../../../config-compiler/test/subscription-fixtures.js';
import { sha256 } from '../../src/release.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const branch = process.env.RULE_ACTIVATION_BRANCH;
const evidenceFile = process.env.RULE_ACTIVATION_EVIDENCE;
const candidateEvidenceUrl = process.env.RULE_ACTIVATION_CANDIDATE;
const expectedHead = process.env.RULE_ACTIVATION_EXPECTED_HEAD;
// Explicit opt-in writes only a pre-created isolated acceptance branch, never main.
test('固定官方历史激活回滚并核对稳定 HTTPS、历史字节和生产入口', {
  skip: !binary || !branch || !evidenceFile || !candidateEvidenceUrl || !expectedHead,
}, async () => {
  assert.match(branch!, /^acceptance-/);
  const transport = githubActivation(branch!);
  const subscription = JSON.parse(JSON.stringify(contract).replaceAll('/main/', `/${branch}/`));
  const productionBefore = await githubActivation().head();
  const historical = await activateRules({ binary: binary!, candidateEvidenceUrl: candidateEvidenceUrl!, subscription, expectedHead: expectedHead!, transport });
  const current = await activateRules({ binary: binary!, candidateEvidenceUrl: candidateEvidenceUrl!, subscription, expectedHead: historical.commit, transport });
  const result = await rollbackRules({ binary: binary!, historicalActivationCommit: historical.commit, subscription, expectedHead: current.commit, transport });
  const historicalReadback = [];
  for (const path of ['stable/activation.json', ...Object.keys(historical.activation.files)]) {
    const bytes = await transport.download(`https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${historical.commit}/${path}`);
    const expected = path === 'stable/activation.json' ? Buffer.from(JSON.stringify(historical.activation, null, 2) + '\n') : undefined;
    if (expected) assert.deepEqual(bytes, expected);
    else assert.equal(sha256(bytes), historical.activation.files[path].sha256);
    historicalReadback.push({ path, sha256: sha256(bytes), byteLength: bytes.length });
  }
  await assert.rejects(rollbackRules({ binary: binary!, historicalActivationCommit: 'f'.repeat(40), subscription, expectedHead: result.commit, transport }));
  assert.equal(await transport.head(), result.commit);
  const productionAfter = await githubActivation().head();
  assert.equal(productionAfter, productionBefore);
  assert.equal(result.activation.source.tag, '20261102130044');
  assert.equal(result.activation.source.inputSha256, 'bfa4ab62d0f47216029ce6b777a2364978c3f28086060b592453684a0dd830ee');
  const stableReadback: unknown[] = [];
  for (const [path, expected] of Object.entries(result.activation.files)) {
    const url = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/${path}`;
    let bytes: Buffer | undefined;
    // CDN propagation is observable, not a promise about all clients' update time.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const actual = await transport.download(url);
        if (sha256(actual) === expected.sha256 && actual.length === expected.byteLength) { bytes = actual; break; }
      } catch { /* A fresh branch may briefly return cached 404. */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(bytes, `Stable HTTPS readback did not converge: ${url}`);
    stableReadback.push({ url, sha256: sha256(bytes), byteLength: bytes.length });
  }
  const input = subscriptionInput();
  input.dependencies.subscriptions = [subscription];
  const compiled = compileRecipe(input);
  assert.equal(compiled.ok, true);
  const config = compiled.value.config;
  const ruleSets = (config.route as any).rule_set;
  assert.ok(ruleSets.every((rule: any) => rule.type === 'remote' && rule.format === 'binary' && rule.url.includes(`/${branch}/stable/`) && !rule.update_interval));
  await createSingBoxChecker(binary!)(config);
  await writeFile(evidenceFile!, JSON.stringify({ date: new Date().toISOString(), result, historical, current, historicalReadback, rejectedMissingHistory: true, productionBefore, productionAfter, stableReadback,
    compiler: { configSha256: sha256(JSON.stringify(config)), ruleSets, nativeCheck: 'passed', config } }, null, 2) + '\n', { flag: 'wx' });
});
