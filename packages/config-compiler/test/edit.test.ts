import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, decideNodeRevisionDeletion, decideRecipeEdit, preparePublication, renderSubscription, resolveRecipe, validateRecipeDraft, type RecipeEditInput } from '../src/index.js';
import { input, node } from './recipe-fixtures.js';
import { success } from './helpers.js';

function edit(): RecipeEditInput {
  const request = input();
  return { previous: structuredClone(request.recipe), candidate: { ...request.recipe, revision: '2' },
    dependencies: request.dependencies, params: request.params, nodes: [{ id: node.id, archived: false }] };
}
function codes(request: RecipeEditInput): string[] { return decideRecipeEdit(request).reasons.map(d => d.code); }

test('draft structure rejects incomplete, mistyped and unopened fields before save', () => {
  for (const mutate of [
    (v: any) => { delete v.profile; },
    (v: any) => { v.resources.outbounds[0].nodeRef.revision = 1; },
    (v: any) => { v.resources.outbounds[0].options = { password: 'private-value' }; },
    (v: any) => { v.settings = { routeFinal: null }; },
    (v: any) => { v.dnsSteps = [{}]; },
  ]) {
    const request = edit(); mutate(request.candidate);
    assert.equal(validateRecipeDraft(request.candidate).ok, false);
    const result = decideRecipeEdit(request);
    assert.equal(result.allowed, false);
    assert.equal(result.reasons[0]!.code, 'STRUCTURE_INVALID');
    assert.equal(JSON.stringify(result).includes('private-value'), false);
  }
  const request = { ...edit(), profile: 'ios-appstore' };
  assert.equal(decideRecipeEdit(request).reasons[0]!.code, 'STRUCTURE_INVALID');
});

test('missing fixed dependencies and dangling final references are saveable drafts but fail compilation', () => {
  for (const missing of ['nodes', 'templates', 'final'] as const) {
    const request = edit();
    if (missing === 'final') request.candidate.settings = { routeFinal: 'missing-outbound' };
    else request.dependencies[missing] = [];
    success(validateRecipeDraft(request.candidate));
    const decision = decideRecipeEdit(request);
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.reasons, []);
    assert.ok(decision.diagnostics.some(d => d.severity === 'error'));
    assert.equal(compileRecipe({ recipe: request.candidate, dependencies: request.dependencies, params: request.params }).ok, false);
  }
});

test('Profile remains fixed for the same Recipe even with semantic errors; a new identity is revalidated', () => {
  const request = edit(); request.candidate.profile = 'ios-appstore'; request.dependencies.nodes = [];
  assert.ok(codes(request).includes('RECIPE_PROFILE_FIXED'));
  assert.ok(decideRecipeEdit(request).diagnostics.some(d => d.code === 'DEPENDENCY_MISSING'));
  request.candidate.id = 'phone';
  const copy = decideRecipeEdit(request);
  assert.equal(copy.allowed, true);
  assert.ok(copy.diagnostics.some(d => d.code === 'DEPENDENCY_MISSING'));
  request.previous = null;
  request.dependencies = input().dependencies;
  const created = decideRecipeEdit(request);
  assert.equal(created.allowed, true);
  assert.ok(created.diagnostics.some(d => d.code === 'REFERENCE_MISSING'));
  request.dependencies.templates[0]!.platformDnsServers['ios-appstore'] = [{ type: 'local', tag: 'local' }];
  assert.deepEqual(decideRecipeEdit(request).diagnostics, []);
  const compiled = success(compileRecipe({ recipe: request.candidate, dependencies: request.dependencies, params: request.params }));
  assert.equal(compiled.profile, 'ios-appstore');
});

test('archived bindings survive ordinary edits and reordering but cannot be added, copied or upgraded', () => {
  const retained = edit(); retained.nodes[0]!.archived = true;
  retained.candidate.settings = { logLevel: 'debug' };
  assert.equal(decideRecipeEdit(retained).allowed, true);
  const reordered = structuredClone(retained);
  const second = { kind: 'node' as const, tag: 'second', nodeRef: { id: node.id, revision: node.revision } };
  reordered.previous!.resources.outbounds!.push(second);
  reordered.candidate.resources.outbounds!.unshift(structuredClone(second));
  assert.equal(decideRecipeEdit(reordered).allowed, true);
  const removed = structuredClone(retained); removed.candidate.resources.outbounds = [];
  assert.equal(decideRecipeEdit(removed).allowed, true);
  for (const mutate of [
    (v: RecipeEditInput) => { v.previous = null; },
    (v: RecipeEditInput) => { v.candidate.id = 'copy'; },
    (v: RecipeEditInput) => { v.candidate.resources.outbounds![0]!.nodeRef.revision = 'missing'; },
    (v: RecipeEditInput) => { v.candidate.resources.outbounds![0]!.tag = 'new-binding'; },
    (v: RecipeEditInput) => { v.candidate.resources.outbounds!.push(structuredClone(v.candidate.resources.outbounds![0]!)); },
    (v: RecipeEditInput) => { v.previous!.resources.outbounds = []; },
  ]) {
    const request = structuredClone(retained); mutate(request);
    assert.ok(codes(request).includes('NODE_ARCHIVED'));
  }
  // Missing dependency semantics cannot bypass the separate archive restriction.
  const invalid = structuredClone(retained); invalid.candidate.id = 'copy'; invalid.dependencies.nodes = [];
  const result = decideRecipeEdit(invalid);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some(d => d.code === 'NODE_ARCHIVED'));
  assert.ok(result.diagnostics.some(d => d.code === 'DEPENDENCY_MISSING'));
});

test('active nodes allow new bindings; absent or ambiguous lifecycle state fails closed', () => {
  const request = edit(); request.previous = null;
  assert.equal(decideRecipeEdit(request).allowed, true);
  request.nodes = [];
  assert.deepEqual(codes(request), ['NODE_STATE_INVALID']);
  request.nodes = [{ id: node.id, archived: false }, { id: node.id, archived: true }];
  assert.deepEqual(codes(request), ['NODE_STATE_INVALID']);
  assert.equal(decideRecipeEdit({ ...request, nodes: [{ id: node.id }] }).allowed, false);
});

test('edits require a new Recipe revision and return isolated snapshots', () => {
  const request = edit(); request.candidate.revision = request.previous!.revision;
  assert.equal(decideRecipeEdit(request).allowed, true); // Idempotent no-op.
  request.candidate.settings = { logLevel: 'debug' };
  assert.ok(codes(request).includes('RECIPE_REVISION_IMMUTABLE'));
  request.candidate.revision = '2';
  const before = structuredClone(request);
  const saved = decideRecipeEdit(request);
  assert.ok(saved.allowed);
  assert.deepEqual(decideRecipeEdit(request), saved);
  saved.value.resources.outbounds![0]!.nodeRef.revision = 'mutated';
  const structural = success(validateRecipeDraft(request.candidate));
  structural.resources.outbounds![0]!.tag = 'mutated';
  assert.deepEqual(request, before);
});

test('node revision deletion rejects either kind of reference and accepts only explicit unreferenced state', () => {
  for (const recipeRevisions of [false, true]) for (const publications of [false, true]) {
    const request = { nodeRef: { id: node.id, revision: node.revision }, references: { recipeRevisions, publications } };
    const before = structuredClone(request);
    const result = decideNodeRevisionDeletion(request);
    assert.equal(result.allowed, !recipeRevisions && !publications);
    assert.equal(result.reasons.length, Number(recipeRevisions) + Number(publications));
    if (result.allowed) result.value.revision = 'mutated';
    assert.deepEqual(request, before);
  }
  for (const references of [{}, { recipeRevisions: false }, { recipeRevisions: 'false', publications: false }]) {
    assert.equal(decideNodeRevisionDeletion({ nodeRef: { id: node.id, revision: node.revision }, references }).allowed, false);
  }
});

test('retained archived bindings compile and publish; draft edits and new node revisions leave old publications intact', async () => {
  const request = edit(); request.nodes[0]!.archived = true;
  const original = input(); const before = structuredClone(original);
  const publication = success(await preparePublication(success(resolveRecipe(original)), async () => {}));
  const snapshot = structuredClone(publication);
  const config = success(await renderSubscription(publication, { ecs: null }));
  const saved = decideRecipeEdit(request); assert.ok(saved.allowed);
  const next = { recipe: saved.value, dependencies: request.dependencies, params: request.params };
  const nextPublication = success(await preparePublication(success(resolveRecipe(next)), async () => {}));
  assert.notEqual(nextPublication.id, publication.id);
  assert.deepEqual(success(compileRecipe(next)).config, config);
  request.dependencies.nodes.push({ ...node, revision: '2', connection: { ...node.connection, server: '192.0.2.2' } });
  request.candidate.settings = { routeFinal: 'missing' };
  assert.equal(decideRecipeEdit(request).allowed, true);
  assert.deepEqual(original, before);
  assert.deepEqual(publication, snapshot);
  assert.deepEqual(success(await renderSubscription(publication, { ecs: null })), config);
});
