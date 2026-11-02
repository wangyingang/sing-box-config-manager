import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RecipeCompileInput, compileRecipe, decideRecipeEdit, inspectRecipeComposition, prepareRecipePublication, renderSubscription } from '../../src/index.js';
import { createSingBoxChecker, publishRecipe, readPublication } from '../../src/publisher.js';
import { migrationCases, migrationInput } from '../migration-fixtures.js';
import { input as legalInput } from '../recipe-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);

for (const id of migrationCases) {
  test(`${id}: migrated candidate passes real 1.14.4 checks and strict publication preserves Profile gates`, async () => {
    const request = migrationInput(id);
    if (id === 'user-b-android-tun') {
      for (const ecs of [request.params.ecs, null]) {
        const candidate = inspectRecipeComposition({ ...request, params: { ecs } });
        assert.ok(candidate.candidate);
        await checker(candidate.candidate.config);
      }
      const blocked = await prepareRecipePublication(request, checker);
      assert.equal(blocked.ok, false);
      assert.ok(blocked.diagnostics.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
      return;
    }
    let checks = 0;
    const publication = success(await prepareRecipePublication(request, async config => { await checker(config); checks++; }));
    assert.equal(checks, 2);
    for (const ecs of [request.params.ecs, null]) {
      const config = success(await renderSubscription(publication, { ecs }));
      assert.deepEqual(config, success(compileRecipe({ ...request, params: { ecs } })).config);
    }
    assert.ok(publication.body.recipeSource!.nodes.length);
  });
}

test('legal Android Recipe with local resolver and package policy publishes without changing legacy process rules', async () => {
  // A separate synthetic Recipe, not a repaired version of the legacy Android golden.
  const request: RecipeCompileInput = legalInput();
  request.recipe.id = 'legal-android';
  request.recipe.profile = 'android-google-play';
  request.dependencies.templates[0]!.platformDnsServers = { 'android-google-play': [{ type: 'local', tag: 'local' }] };
  request.recipe.routeSteps = [{ id: 'android-package', rule: { package_name: 'com.example.app', outbound: 'alice-proxy' } }];
  request.dependencies.templates[0]!.ecsResponseTags = ['ecs'];
  request.recipe.dnsSteps = [
    { id: 'evaluate', rule: { action: 'evaluate', server: 'local', tag: 'ecs' } },
    { id: 'respond', rule: { match_response: 'ecs', action: 'respond' } },
  ];
  request.params.ecs = { address: '8.8.8.8', prefix: 24 };
  const publication = success(await prepareRecipePublication(request, checker));
  assert.equal(publication.body.compiled.profile, 'android-google-play');
  assert.equal((await renderSubscription(publication, { ecs: null })).ok, true);
});

test('full migrated policy publishes archived bindings; failed native publication preserves local release and pinned snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recipe-migration-publish-'));
  try {
    const request = migrationInput('user-d-tun');
    const candidate = { ...request.recipe, revision: 'retained-archived', settings: { logLevel: 'info' as const } };
    const decision = decideRecipeEdit({ previous: request.recipe, candidate, dependencies: request.dependencies, params: request.params,
      nodes: request.dependencies.nodes.map(n => ({ id: n.id, archived: true })) });
    assert.ok(decision.allowed);
    request.recipe = decision.value;
    const publication = success(await publishRecipe(request, { binary, directory }));
    const pointer = await readFile(join(directory, 'current.json'), 'utf8');
    const snapshot = structuredClone(publication);
    request.recipe.revision = 'draft';
    request.dependencies.nodes[0]!.connection.server_port = 444;
    request.dependencies.templates[0]!.defaults.log = { level: 'debug' };
    const failed = await publishRecipe(request, { binary: join(directory, 'absent'), directory });
    assert.equal(failed.ok, false);
    assert.ok(failed.diagnostics.some(d => d.code === 'NATIVE_CHECK_FAILED'));
    assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), pointer);
    assert.deepEqual(await readPublication(directory), snapshot);
    assert.ok((await renderSubscription(snapshot, { ecs: null })).ok);
    assert.equal((await publishRecipe(migrationInput('user-b-android-tun'), { binary, directory })).ok, false);
    assert.equal((await readPublication(directory)).id, publication.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
