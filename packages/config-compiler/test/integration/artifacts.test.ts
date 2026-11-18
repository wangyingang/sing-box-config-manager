import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, resolveRecipe, preparePublication, renderSubscription } from '../../src/index.js';
import { createSingBoxChecker } from '../../src/publisher.js';
import { responseInput } from '../artifact-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);

test('fixed source/binary artifacts pass real 1.14.4 publication checks for both ECS variants', async () => {
  const request = responseInput();
  request.dependencies.templates[0]!.ecsResponseTags = ['first'];
  request.params.ecs = { address: '8.8.8.8', prefix: 24 };
  let checks = 0;
  const publication = success(await preparePublication(success(resolveRecipe(request)), async config => {
    // Native check validates configuration; it does not verify or fetch these remote files.
    await checker(config); checks++;
  }));
  assert.equal(checks, 2);
  assert.deepEqual(success(await renderSubscription(publication, request.params)), success(compileRecipe(request)).config);
  request.params.ecs = null;
  assert.deepEqual(success(await renderSubscription(publication, request.params)), success(compileRecipe(request)).config);
});
