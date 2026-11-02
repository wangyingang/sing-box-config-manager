import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, inspectRecipeComposition, resolveRecipe, recipeSchema } from '../src/index.js';
import { fixture } from './fixtures.js';
import { success } from './helpers.js';
import { normalize } from './normalize.js';
import { migrationCases, migrationInput, migrationMapping } from './migration-fixtures.js';

for (const id of migrationCases) {
  test(`${id}: static fixed Recipe migration preserves the full golden and array order`, () => {
    const request = migrationInput(id);
    const before = structuredClone(request);
    recipeSchema.parse(request.recipe, '');
    const audit = inspectRecipeComposition(request);
    assert.ok(audit.candidate, JSON.stringify(audit.diagnostics));
    assert.deepEqual(normalize(audit.candidate.config), normalize(fixture(id).golden));
    if (id === 'user-b-android-tun') {
      assert.equal(compileRecipe(request).ok, false);
      assert.ok(audit.diagnostics.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
      assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
    } else {
      assert.ok(resolveRecipe(request).ok);
      assert.deepEqual(success(compileRecipe(request)).config, audit.candidate.config);
    }
    assert.deepEqual(inspectRecipeComposition(request), audit);
    assert.deepEqual(request, before);
    const mapping = migrationMapping(id);
    assert.equal(mapping.legacyCase, id);
    assert.deepEqual(mapping.templateRef, request.recipe.templateRef);
    assert.deepEqual(mapping.nodes.map((n: any) => n.nodeRef), request.dependencies.nodes.map(n => ({ id: n.id, revision: n.revision })));
  });
}

test('migration node identities are assigned explicitly per case rather than inferred from redacted connection equality', () => {
  const ids = migrationCases.flatMap(id => migrationInput(id).dependencies.nodes.map(node => node.id));
  assert.equal(new Set(ids).size, ids.length);
  const a = migrationInput('user-a-tun');
  const b = migrationInput('user-b-tun');
  assert.deepEqual(a.dependencies.nodes[0]!.connection, b.dependencies.nodes[0]!.connection);
  assert.notEqual(a.dependencies.nodes[0]!.id, b.dependencies.nodes[0]!.id);
});

test('user-d retains its independent policy and Android retains its local resolver and Inline Rule Sets', () => {
  const d = migrationInput('user-d-tun');
  const a = migrationInput();
  assert.notDeepEqual(d.recipe.routeSteps, a.recipe.routeSteps);
  assert.notEqual(d.recipe.templateRef.id, a.recipe.templateRef.id);
  const android = migrationInput('user-b-android-tun');
  const template = android.dependencies.templates[0]!;
  assert.equal(template.platformDnsServers['android-google-play']![0]!.type, 'local');
  assert.ok(android.recipe.resources.ruleSets!.some(s => s.kind === 'inline' && s.definition.tag === 'Android-Proxy-required'));
  assert.ok(template.resources.ruleSets!.some(s => s.kind === 'inline' && s.definition.tag === 'Process-Direct-required'));
  const ecs = template.dnsPresets!['5.dns.json']!.filter(rule => 'tag' in rule && rule.tag === 'ecs');
  assert.equal(ecs.length, 1);
  assert.equal('client_subnet' in ecs[0]!, false);
});
