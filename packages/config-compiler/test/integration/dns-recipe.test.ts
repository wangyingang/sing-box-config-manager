import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, preparePublication, renderSubscription, resolveRecipe } from '../../src/index.js';
import { createSingBoxChecker } from '../../src/publisher.js';
import { sampleDnsInput } from '../dns-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);

for (const profile of ['macos-standalone', 'android-google-play'] as const) {
  test(`${profile}: structured sample first/ecs DNS policy passes both real 1.14.4 checks`, async () => {
    const { request } = sampleDnsInput();
    request.recipe.profile = profile;
    // Also exercise recursive DNS matching and predefined answer data through the real schema/check.
    request.recipe.dnsSteps.unshift({ id: 'predefined', rule: { type: 'logical', mode: 'and', rules: [{ domain: 'example.test' }, { query_type: 'A' }], action: 'predefined', rcode: 'NOERROR', answer: ['example.test. 60 IN A 192.0.2.1'] } });
    const before = structuredClone(request);
    const enabled = success(compileRecipe(request)).config;
    let checks = 0;
    const publication = success(await preparePublication(success(resolveRecipe(request)), async config => {
      await checker(config); checks++;
    }));
    assert.equal(checks, 2);
    assert.deepEqual(success(await renderSubscription(publication, request.params)), enabled);
    request.params.ecs = null;
    assert.deepEqual(success(await renderSubscription(publication, request.params)), success(compileRecipe(request)).config);
    request.params = before.params;
    assert.deepEqual(request, before);
  });
}
