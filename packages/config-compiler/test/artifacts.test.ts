import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import schema from '../../rule-set-pipeline/contracts/artifact-manifest.schema.json' with { type: 'json' };
import { artifactManifestSchema, compileRecipe, resolveRecipe, validateRecipeDraft, decideRecipeEdit } from '../src/index.js';
import { artifactInput, responseInput } from './artifact-fixtures.js';
import { success } from './helpers.js';

function rejects(request: unknown, code: string) {
  const result = compileRecipe(request);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === code), JSON.stringify(result.diagnostics));
}

test('fixed Manifest bindings share physical files while keeping local tags, order and explicit D06 fields', () => {
  const request = responseInput();
  const before = structuredClone(request);
  const resolved = success(resolveRecipe(request));
  assert.equal(resolved.artifacts.length, 2);
  assert.deepEqual(Object.keys(resolved.artifacts[0]!).sort(), ['format', 'id', 'requiredCapabilities', 'revision', 'sha256', 'url']);
  const compiled = success(compileRecipe(request));
  const sets = (compiled.config.route as any).rule_set;
  assert.deepEqual(sets.map((s: any) => [s.tag, s.type, s.format]), [['routing', 'remote', 'source'], ['queries', 'remote', 'source'], ['answers', 'remote', 'binary']]);
  assert.equal(sets[0].url, sets[1].url);
  assert.equal(sets[0].http_client, 'download');
  assert.equal(compiled.artifacts.length, 2);
  assert.deepEqual(success(compileRecipe(request)), compiled);
  resolved.artifacts[0]!.requiredCapabilities.push('dhcpDns');
  assert.deepEqual(request, before);
});

test('exact artifact revision never falls back; duplicate and conflicting physical identities fail', () => {
  const request: any = artifactInput();
  request.recipe.resources.ruleSets[0].artifactRef.revision = 'missing';
  rejects(request, 'DEPENDENCY_MISSING');
  request.recipe.resources.ruleSets[0].artifactRef.revision = '1';
  const newer = structuredClone(request.dependencies.manifests[0]);
  newer.revision = '2';
  newer.artifacts[0].id = 'synthetic:domains@2:source';
  newer.artifacts[0].url = 'https://rules.example.invalid/2/domains.json';
  newer.projections.route.artifactIds = [newer.artifacts[0].id];
  newer.projections['dns-query'].artifactIds = [newer.artifacts[0].id];
  request.dependencies.manifests.push(newer);
  assert.equal(success(compileRecipe(request)).artifacts[0]!.revision, '1');
  const conflicting = structuredClone(request);
  conflicting.dependencies.manifests[1].artifacts[0].id = conflicting.dependencies.manifests[0].artifacts[0].id;
  conflicting.dependencies.manifests[1].artifacts[0].sha256 = 'c'.repeat(64);
  conflicting.dependencies.manifests[1].projections.route.artifactIds = [conflicting.dependencies.manifests[1].artifacts[0].id];
  conflicting.dependencies.manifests[1].projections['dns-query'].artifactIds = [conflicting.dependencies.manifests[1].artifacts[0].id];
  rejects(conflicting, 'ARTIFACT_DUPLICATE');
  request.dependencies.manifests.push(structuredClone(request.dependencies.manifests[0]));
  rejects(request, 'DEPENDENCY_DUPLICATE');
});

test('unavailable projections and mismatched artifact selection cannot become empty match objects', () => {
  const request: any = artifactInput();
  request.recipe.resources.ruleSets[0].artifactRef.usage = 'dns-response';
  rejects(request, 'ARTIFACT_PROJECTION_EMPTY');
  const response: any = responseInput();
  response.recipe.resources.ruleSets[0].artifactRef.usage = 'dns-response';
  rejects(response, 'ARTIFACT_USAGE_MISMATCH');
  const empty: any = artifactInput();
  empty.dependencies.manifests[0].artifacts[0].termCount = 0;
  rejects(empty, 'STRUCTURE_INVALID');
  const missing: any = artifactInput();
  missing.dependencies.manifests[0].projections.route.artifactIds = ['absent'];
  rejects(missing, 'ARTIFACT_MANIFEST_INVALID');
});

test('purpose is checked at every Route/DNS consumer, including preset and logical children', () => {
  const request: any = responseInput();
  request.dependencies.templates[0].routePresets = { wrong: [{ type: 'logical', mode: 'or', rules: [{ rule_set: 'queries' }], outbound: 'direct' }] };
  request.recipe.routeSteps = [{ id: 'policy', preset: 'wrong' }];
  rejects(request, 'ARTIFACT_USAGE_MISMATCH');
  const diagnostic = compileRecipe(request).diagnostics.find(d => d.code === 'ARTIFACT_USAGE_MISMATCH')!;
  assert.equal(diagnostic.path, '/recipe/routeSteps/0/preset');
  assert.deepEqual(diagnostic.source, { stepId: 'policy', stepIndex: 0, preset: 'wrong', presetRuleIndex: 0, outputRuleIndex: 0, outputPath: '/route/rules/0/rules/0/rule_set' });
  for (const tag of ['routing', 'answers']) {
    const query: any = responseInput();
    query.recipe.dnsSteps[0].rule.rule_set = tag;
    rejects(query, 'ARTIFACT_USAGE_MISMATCH');
  }
  const response: any = responseInput();
  response.recipe.dnsSteps[2].rule.rules[0].rule_set = 'queries';
  rejects(response, 'ARTIFACT_USAGE_MISMATCH');
});

test('DNS IP projections require an earlier matching named or untagged evaluate and destination IP context', () => {
  for (const mutate of [
    (r: any) => { r.recipe.dnsSteps.splice(1, 1); },
    (r: any) => { r.recipe.dnsSteps.reverse(); },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].match_response = 'absent'; },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].match_response = true; },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].rule_set_ip_cidr_match_source = true; },
  ]) { const request = responseInput(); mutate(request); rejects(request, 'ARTIFACT_USAGE_MISMATCH'); }
  const untagged: any = responseInput();
  delete untagged.recipe.dnsSteps[1].rule.tag;
  untagged.recipe.dnsSteps[2].rule.rules[0].match_response = true;
  untagged.recipe.dnsSteps[3].rule.match_response = true;
  assert.ok(compileRecipe(untagged).ok);
});

test('Profile capability failures block compilation but preserve structurally valid editable drafts', () => {
  const request = artifactInput();
  request.recipe.profile = 'ios-appstore';
  request.dependencies.templates[0]!.platformDnsServers['ios-appstore'] = [{ type: 'local', tag: 'local' }];
  request.dependencies.manifests![0]!.artifacts[0]!.requiredCapabilities = ['processMatching'];
  rejects(request, 'CAPABILITY_UNSUPPORTED');
  assert.ok(validateRecipeDraft(request.recipe).ok);
  const decision = decideRecipeEdit({ previous: null, candidate: request.recipe, dependencies: request.dependencies, params: request.params, nodes: [{ id: 'shared', archived: false }] });
  assert.ok(decision.allowed);
  assert.ok(decision.diagnostics.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
});

test('bindings accept only fixed references, local tag and the open HTTP client reference', () => {
  for (const extra of [{ url: 'https://evil.invalid/a' }, { path: '/tmp/x' }, { sha256: 'a'.repeat(64) }, { requiredCapabilities: [] }, { artifactId: 'legacy' }]) {
    const request: any = artifactInput();
    Object.assign(request.recipe.resources.ruleSets[0], extra);
    rejects(request, 'STRUCTURE_INVALID');
  }
  const client: any = artifactInput();
  client.recipe.resources.ruleSets[0].httpClient = 'missing';
  rejects(client, 'REFERENCE_MISSING');
  const template: any = artifactInput();
  template.dependencies.templates[0].resources.ruleSets = template.recipe.resources.ruleSets;
  template.recipe.resources.ruleSets = [];
  assert.ok(compileRecipe(template).ok);
});

test('Pipeline fixed contract sample and Compiler boundary agree on versions, formats and closed capability vocabulary', () => {
  const validate = new Ajv.default({ strict: true }).compile(schema);
  const original = artifactInput().dependencies.manifests![0]!;
  const mutations = [
    (_: any) => {},
    (m: any) => { m.schemaVersion = 2; },
    (m: any) => { m.targetVersion = '1.14.5'; },
    (m: any) => { m.sourceFormatVersion = 5; },
    (m: any) => { m.artifacts[0].format = 'unknown'; },
    (m: any) => { m.artifacts[0].requiredCapabilities = ['unknown']; },
    (m: any) => { m.artifacts[0].requiredCapabilities = ['processMatching', 'processMatching']; },
    (m: any) => { m.artifacts[0].sha256 = 'not-a-digest'; },
    (m: any) => { m.artifacts[0].url = 'http://rules.example.invalid/1/a'; },
    (m: any) => { m.artifacts[0].byteLength = 0; },
    (m: any) => { m.artifacts[0].termCount = 0; },
    (m: any) => { m.projections.route.artifactIds = []; },
    (m: any) => { m.projections.route.artifactIds.push(m.projections.route.artifactIds[0]); },
    (m: any) => { m.artifacts[0].options = {}; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const manifest = structuredClone(original); mutate(manifest);
    assert.equal(validate(manifest), i === 0, JSON.stringify(validate.errors));
    if (i === 0) artifactManifestSchema.parse(manifest, '');
    else {
      assert.throws(() => artifactManifestSchema.parse(manifest, ''));
      const request = artifactInput(); request.dependencies.manifests = [manifest];
      rejects(request, 'STRUCTURE_INVALID');
    }
  }
  const mutable = artifactInput();
  mutable.dependencies.manifests![0]!.artifacts[0]!.url = 'https://rules.example.invalid/latest/domains.json';
  rejects(mutable, 'ARTIFACT_URL_MUTABLE');
});
