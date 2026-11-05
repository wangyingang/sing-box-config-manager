import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileRecipe, prepareRecipePublication, renderSubscription } from '../../src/index.js';
import { createSingBoxChecker, publishRecipe, readPublication } from '../../src/publisher.js';
import threeRuleExample from '../../examples/three-rule-subscriptions-v2.json' with { type: 'json' };
import { subscriptionResponseInput } from '../subscription-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);

test('one Recipe publishes and delivers three v2 logical subscriptions with real sing-box checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'three-rule-subscriptions-'));
  const request = structuredClone(threeRuleExample);
  try {
    const published = success(await publishRecipe(request, { binary, directory }));
    assert.deepEqual(await readPublication(directory), published);
    const delivered = success(await renderSubscription(published, request.params));
    const ids = ['ai-openai', 'ai-anthropic', 'ai-google-deepmind'];
    assert.deepEqual(published.body.recipeSource?.subscriptions?.map(s => s.systemRuleSetId), ids);
    assert.deepEqual(published.body.compiled.subscriptions?.map(s => s.systemRuleSetId), ids);
    assert.deepEqual((delivered.route as any).rule_set.map((set: any) => [set.tag, set.url]),
      ids.map(id => [id, `https://rules.example.invalid/stable/${id}/domains.srs`]));
    await checker(delivered);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stable SRS Recipe passes real 1.14.4 checks for both ECS variants through existing publication storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-publication-'));
  const request = subscriptionResponseInput();
  request.dependencies.templates[0]!.ecsResponseTags = ['first'];
  request.params.ecs = { address: '8.8.8.8', prefix: 24 };
  try {
    let checks = 0;
    const prepared = success(await prepareRecipePublication(request, async config => {
      // These checks prove config compatibility, not the remote URL's current bytes.
      await checker(config); checks++;
    }));
    assert.equal(checks, 2);
    const published = success(await publishRecipe(request, { binary, directory }));
    assert.deepEqual(published, prepared);
    assert.deepEqual(await readPublication(directory), published);
    for (const params of [request.params, { ecs: null }]) {
      const config = success(await renderSubscription(published, params));
      assert.deepEqual(config, success(compileRecipe({ ...request, params })).config);
      assert.ok((config.route as any).rule_set.every((s: any) => s.type === 'remote' && s.format === 'binary' && !('update_interval' in s)));
      assert.equal(config.experimental, undefined);
      await checker(config);
    }
    const failed = await publishRecipe(request, { binary: join(directory, 'missing-binary'), directory });
    assert.equal(failed.ok, false);
    assert.ok(failed.diagnostics.some(d => d.code === 'NATIVE_CHECK_FAILED'));
    assert.deepEqual(await readPublication(directory), published);
    const invalid: any = structuredClone(request);
    invalid.dependencies.subscriptions[0].projections.route = { unavailable: 'empty' };
    assert.equal((await publishRecipe(invalid, { binary, directory })).ok, false);
    assert.deepEqual(await readPublication(directory), published);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
