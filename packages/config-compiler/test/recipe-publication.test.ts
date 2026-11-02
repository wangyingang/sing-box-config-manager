import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, decideRecipeEdit, prepareRecipePublication, renderSubscription, validateRecipeDraft } from '../src/index.js';
import { migrationInput } from './migration-fixtures.js';
import { success } from './helpers.js';

test('fixed Recipe source and dependency records participate in publication identity without following latest revisions', async () => {
  const request = migrationInput();
  const publish = (input: unknown) => prepareRecipePublication(input, async () => {});
  const original = success(await publish(request));
  const source = original.body.recipeSource!;
  assert.deepEqual(source.recipe, { id: request.recipe.id, revision: request.recipe.revision });
  assert.deepEqual(source.template, request.recipe.templateRef);
  assert.deepEqual(source.nodes, request.dependencies.nodes.map(({ id, revision }) => ({ id, revision })));
  assert.equal(source.artifacts.length, original.body.compiled.artifacts.length);
  // Step IDs are lost by D06 resolution but must still bind the new-contract publication.
  const renamed = structuredClone(request);
  renamed.recipe.dnsSteps[0]!.id += '-renamed';
  const changed = success(await publish(renamed));
  assert.equal(changed.body.inputHash, original.body.inputHash);
  assert.notEqual(changed.body.recipeSource!.inputHash, source.inputHash);
  assert.notEqual(changed.id, original.id);
  request.dependencies.nodes.push({ ...structuredClone(request.dependencies.nodes[0]!), revision: 'latest' });
  request.dependencies.templates.push({ ...structuredClone(request.dependencies.templates[0]!), revision: 'candidate', defaults: {} });
  assert.equal(success(await publish(request)).id, original.id);
  const upgraded = structuredClone(request);
  upgraded.dependencies.nodes[0]!.connection.server_port = 444;
  assert.notEqual(success(await publish(upgraded)).body.inputHash, original.body.inputHash);
  assert.deepEqual(success(await renderSubscription(original, request.params)), success(compileRecipe(request)).config);
});

test('full-policy semantic draft can be saved and retained archived bindings can publish through the Recipe entry', async () => {
  const request = migrationInput();
  const states = request.dependencies.nodes.map(node => ({ id: node.id, archived: true }));
  const candidate = structuredClone(request.recipe);
  candidate.revision += '-edited';
  candidate.settings = { routeFinal: 'unresolved' };
  assert.ok(validateRecipeDraft(candidate).ok);
  const edit = decideRecipeEdit({ previous: request.recipe, candidate, dependencies: request.dependencies, params: request.params, nodes: states });
  assert.ok(edit.allowed);
  assert.ok(edit.diagnostics.some(d => d.code === 'REFERENCE_MISSING'));
  let checks = 0;
  assert.equal((await prepareRecipePublication({ ...request, recipe: candidate }, async () => { checks++; })).ok, false);
  assert.equal(checks, 0);
  candidate.settings = { logLevel: 'info' };
  const retained = decideRecipeEdit({ previous: request.recipe, candidate, dependencies: request.dependencies, params: request.params, nodes: states });
  assert.ok(retained.allowed);
  const publication = success(await prepareRecipePublication({ ...request, recipe: retained.value }, async () => { checks++; }));
  assert.equal(checks, 2);
  assert.deepEqual(publication.body.recipeSource!.recipe, { id: candidate.id, revision: candidate.revision });
});

test('new-contract publication snapshots before asynchronous checks and refuses invalid or old Android input', async () => {
  const request = migrationInput();
  const original = success(await prepareRecipePublication(request, async () => {}));
  const raced = success(await prepareRecipePublication(request, async config => {
    request.recipe.revision = 'changed';
    request.dependencies.nodes[0]!.connection.server_port = 444;
    request.dependencies.templates[0]!.defaults.log = { level: 'trace' };
    config.services = [];
  }));
  assert.deepEqual(raced, original);
  for (const input of [undefined, { recipe: {} }, migrationInput('user-b-android-tun')]) {
    let called = false;
    assert.equal((await prepareRecipePublication(input, async () => { called = true; })).ok, false);
    assert.equal(called, false);
  }
});
