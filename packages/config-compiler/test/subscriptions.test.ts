import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import schema from '../../rule-set-pipeline/contracts/rule-subscription.schema.json' with { type: 'json' };
import { compile, compileRecipe, resolveRecipe, prepareRecipePublication, renderSubscription, ruleSubscriptionSchema, validateRecipeDraft, decideRecipeEdit } from '../src/index.js';
import { artifactInput } from './artifact-fixtures.js';
import { subscriptionInput, subscriptionResponseInput } from './subscription-fixtures.js';
import { success } from './helpers.js';

function rejects(request: unknown, code: string) {
  const result = compileRecipe(request);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === code), JSON.stringify(result.diagnostics));
}

test('v2 public Recipe resolves stable SRS, shared physical URLs and local HTTP clients without fixed artifacts or client defaults', () => {
  const request = subscriptionInput();
  const before = structuredClone(request);
  const resolved = success(resolveRecipe(request));
  const compiled = success(compileRecipe(request));
  assert.deepEqual(compiled, success(compile(resolved)));
  const sets = (compiled.config.route as any).rule_set;
  const projection = before.dependencies.subscriptions![0]!.projections.route;
  assert.ok('formats' in projection);
  assert.deepEqual(sets, [
    { type: 'remote', tag: 'routing', format: 'binary', url: projection.formats.binary.url, http_client: 'download' },
    { type: 'remote', tag: 'queries', format: 'binary', url: sets[0].url },
  ]);
  assert.deepEqual(compiled.artifacts, []);
  assert.deepEqual(compiled.subscriptions, before.dependencies.subscriptions);
  assert.equal(compiled.config.experimental, undefined);
  assert.ok(sets.every((s: any) => !('update_interval' in s) && !('sha256' in s)));
  resolved.subscriptions![0]!.systemRuleSetId = 'mutated';
  compiled.subscriptions![0]!.projections.route = { unavailable: 'empty' };
  assert.deepEqual(request, before);
  assert.deepEqual(success(compileRecipe(request)), success(compileRecipe(before)));
});

test('v2 Template subscription bindings expand presets in place and keep duplicates and diagnostic origins', () => {
  const request: any = subscriptionInput();
  request.dependencies.templates[0].resources.ruleSets = request.recipe.resources.ruleSets;
  request.recipe.resources.ruleSets = [];
  request.dependencies.templates[0].routePresets = { use: [{ rule_set: 'routing', outbound: 'direct' }] };
  request.recipe.routeSteps = [{ id: 'a', preset: 'use' }, { id: 'inline', rule: { domain: 'local.test', outbound: 'direct' } }, { id: 'b', preset: 'use' }];
  const rules = (success(compileRecipe(request)).config.route as any).rules;
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], rules[2]);
  request.dependencies.templates[0].routePresets.use[0] = { type: 'logical', mode: 'or', rules: [{ rule_set: 'queries' }], outbound: 'direct' };
  rejects(request, 'ARTIFACT_USAGE_MISMATCH');
  const d = compileRecipe(request).diagnostics.find(d => d.code === 'ARTIFACT_USAGE_MISMATCH')!;
  assert.equal(d.path, '/recipe/routeSteps/0/preset');
  assert.deepEqual(d.source, { stepId: 'a', stepIndex: 0, preset: 'use', presetRuleIndex: 0, outputRuleIndex: 0, outputPath: '/route/rules/0/rules/0/rule_set' });
});

test('v1 remains fixed; schema versions and binding types cannot be reinterpreted or mixed', () => {
  const old: any = artifactInput();
  assert.equal(success(compileRecipe(old)).subscriptions, undefined);
  assert.equal(success(compileRecipe(old)).artifacts.length, 1);
  for (const mutate of [
    (r: any) => { r.recipe.schemaVersion = 1; },
    (r: any) => { r.recipe.schemaVersion = 3; },
    (r: any) => { r.recipe.resources.ruleSets = old.recipe.resources.ruleSets; },
    (r: any) => { r.dependencies.templates[0].resources.ruleSets = old.recipe.resources.ruleSets; },
  ]) { const r = subscriptionInput(); mutate(r); rejects(r, 'STRUCTURE_INVALID'); }
  const mixed: any = subscriptionInput();
  mixed.dependencies.templates[0].schemaVersion = 1;
  rejects(mixed, 'CONTRACT_VERSION_MISMATCH');
});

test('user bindings cannot supply URLs, digests, format, fixed revisions or capability overrides', () => {
  for (const extra of [{ url: 'https://evil.invalid/a' }, { sha256: 'a'.repeat(64) }, { revision: '1' }, { format: 'source' }, { requiredCapabilities: [] }, { artifactRef: { id: 'x', revision: '1', usage: 'route' } }]) {
    for (const nested of [false, true]) {
      const r: any = subscriptionInput();
      Object.assign(nested ? r.recipe.resources.ruleSets[0].subscriptionRef : r.recipe.resources.ruleSets[0], extra);
      rejects(r, 'STRUCTURE_INVALID');
    }
  }
});

test('missing subscriptions, duplicate identities, empty projections, resource errors and unknown usages fail closed', () => {
  const mutations: [string, (r: any) => void][] = [
    ['DEPENDENCY_MISSING', r => { delete r.dependencies.subscriptions; }],
    ['DEPENDENCY_MISSING', r => { r.recipe.resources.ruleSets[0].subscriptionRef.systemRuleSetId = 'other:category-ai'; }],
    ['DEPENDENCY_DUPLICATE', r => { r.dependencies.subscriptions.push(structuredClone(r.dependencies.subscriptions[0])); }],
    ['ARTIFACT_PROJECTION_EMPTY', r => { r.recipe.resources.ruleSets[0].subscriptionRef.usage = 'dns-response'; }],
    ['REFERENCE_MISSING', r => { r.recipe.resources.ruleSets[0].httpClient = 'absent'; }],
    ['TAG_DUPLICATE', r => { r.recipe.resources.ruleSets.push(structuredClone(r.recipe.resources.ruleSets[0])); }],
    ['REFERENCE_MISSING', r => { r.recipe.routeSteps[0].rule.rule_set = 'absent'; }],
    ['STRUCTURE_INVALID', r => { r.recipe.resources.ruleSets[0].subscriptionRef.usage = ''; }],
    ['STRUCTURE_INVALID', r => { r.recipe.resources.ruleSets[0].subscriptionRef.usage = 'unknown'; }],
  ];
  for (const [code, mutate] of mutations) { const r = subscriptionInput(); mutate(r); rejects(r, code); }
});

test('DNS response subscriptions still require an earlier matching response context and destination IP position', () => {
  assert.ok(compileRecipe(subscriptionResponseInput()).ok);
  for (const mutate of [
    (r: any) => { r.recipe.dnsSteps.splice(1, 1); },
    (r: any) => { r.recipe.dnsSteps.reverse(); },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].match_response = 'absent'; },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].match_response = true; },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].rule_set_ip_cidr_match_source = true; },
    (r: any) => { r.recipe.dnsSteps[2].rule.rules[0].rule_set = 'queries'; },
    (r: any) => { r.recipe.dnsSteps[0].rule.rule_set = 'answers'; },
    (r: any) => { r.recipe.routeSteps[0].rule.rule_set = 'answers'; },
  ]) { const r = subscriptionResponseInput(); mutate(r); rejects(r, 'ARTIFACT_USAGE_MISMATCH'); }
  const untagged: any = subscriptionResponseInput();
  delete untagged.recipe.dnsSteps[1].rule.tag;
  untagged.recipe.dnsSteps[2].rule.rules[0].match_response = true;
  untagged.recipe.dnsSteps[3].rule.match_response = true;
  assert.ok(compileRecipe(untagged).ok);
});

test('Pipeline JSON contract and Compiler closed parser agree on subscription versions and constraints', () => {
  const validate = new Ajv.default({ strict: true }).compile(schema);
  const original = subscriptionInput().dependencies.subscriptions![0]!;
  const mutations = [
    (_: any) => {},
    (s: any) => { s.schemaVersion = 2; },
    (s: any) => { s.systemRuleSetId = ''; },
    (s: any) => { s.targetVersion = '1.14.5'; },
    (s: any) => { s.sourceFormatVersion = 5; },
    (s: any) => { s.revision = 'candidate'; },
    (s: any) => { s.sha256 = 'a'.repeat(64); },
    (s: any) => { s.projections.route.formats.binary.sha256 = 'a'.repeat(64); },
    (s: any) => { s.projections.route.formats.binary.requiredCapabilities = ['unknown']; },
    (s: any) => { s.projections.route.formats.binary.requiredCapabilities = ['processMatching', 'processMatching']; },
    (s: any) => { s.projections.route.formats.binary.url = 'http://rules.example.invalid/stable/a.srs'; },
    (s: any) => { s.projections.route.formats.binary.url = 'https://rules.example.invalid/stable/a.srs?version=1'; },
    (s: any) => { s.projections.route.formats.binary.url = 'https://user@rules.example.invalid/stable/a.srs'; },
    (s: any) => { s.projections.route.formats.unknown = s.projections.route.formats.binary; },
    (s: any) => { delete s.projections.route.formats.binary; },
    (s: any) => { delete s.projections['dns-response']; },
    (s: any) => { s.projections['dns-response'].unavailable = 'unknown'; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const contract = structuredClone(original); mutate(contract);
    assert.equal(validate(contract), i === 0, JSON.stringify(validate.errors));
    if (i === 0) ruleSubscriptionSchema.parse(contract, '');
    else {
      assert.throws(() => ruleSubscriptionSchema.parse(contract, ''));
      const r = subscriptionInput(); r.dependencies.subscriptions = [contract]; rejects(r, 'STRUCTURE_INVALID');
    }
  }
});

test('Profile mismatches remain diagnostics on save and block both public and resolved compilation', () => {
  const r: any = subscriptionInput();
  r.recipe.profile = 'ios-appstore';
  r.dependencies.templates[0].platformDnsServers['ios-appstore'] = [{ type: 'local', tag: 'local' }];
  r.dependencies.subscriptions[0].projections.route.formats.binary.requiredCapabilities = ['processMatching'];
  rejects(r, 'CAPABILITY_UNSUPPORTED');
  assert.ok(validateRecipeDraft(r.recipe).ok);
  const edit = decideRecipeEdit({ previous: null, candidate: r.recipe, dependencies: r.dependencies, params: r.params, nodes: [{ id: 'shared', archived: false }] });
  assert.ok(edit.allowed);
  assert.ok(edit.diagnostics.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
  r.recipe.profile = 'macos-standalone';
  const resolved = success(resolveRecipe(r));
  resolved.profile = 'ios-appstore';
  assert.equal(compile(resolved).ok, false);
});

test('subscription publication snapshots contract and native-check evidence without claiming future content hashes', async () => {
  const request = subscriptionResponseInput();
  const original = structuredClone(request);
  let checks = 0;
  const publication = success(await prepareRecipePublication(request, async config => {
    checks++;
    request.dependencies.subscriptions![0]!.systemRuleSetId = 'changed-during-check';
    config.route = {};
  }));
  assert.equal(checks, 2);
  assert.deepEqual(publication.body.compiled.config, success(compileRecipe(original)).config);
  assert.deepEqual(publication.body.recipeSource!.subscriptions, original.dependencies.subscriptions);
  assert.deepEqual(publication.body.recipeSource!.artifacts, []);
  assert.match(publication.body.checks.enabledHash, /^[a-f0-9]{64}$/);
  assert.match(publication.body.checks.disabledHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(publication.body.recipeSource!.subscriptions).includes('sha256'), false);
  assert.deepEqual(success(await renderSubscription(publication, original.params)), success(compileRecipe(original)).config);
  const changed = structuredClone(original);
  (changed.dependencies.subscriptions![0]!.projections.route as any).formats.binary.url += '.changed';
  assert.notEqual(success(await prepareRecipePublication(changed, async () => {})).id, publication.id);
  const unused = structuredClone(original);
  unused.dependencies.subscriptions!.push({ ...structuredClone(original.dependencies.subscriptions![0]!), systemRuleSetId: 'unused' });
  assert.equal(success(await prepareRecipePublication(unused, async () => {})).id, publication.id);
  const tampered = structuredClone(publication);
  tampered.body.compiled.subscriptions![0]!.systemRuleSetId = 'tampered';
  assert.equal((await renderSubscription(tampered, original.params)).ok, false);
  assert.equal((await prepareRecipePublication(original, async () => { throw new Error('failed'); })).ok, false);
});

test('unused projection capabilities do not restrict a DNS-only publication', async () => {
  const r: any = subscriptionInput();
  r.recipe.profile = 'ios-appstore';
  r.dependencies.templates[0].platformDnsServers['ios-appstore'] = [{ type: 'local', tag: 'local' }];
  r.recipe.resources.ruleSets.shift(); r.recipe.routeSteps = [];
  r.dependencies.subscriptions[0].projections.route.formats.binary = { url: 'https://rules.example.invalid/stable/process.srs', requiredCapabilities: ['processMatching'] };
  const publication = success(await prepareRecipePublication(r, async () => {}));
  assert.ok((await renderSubscription(publication, r.params)).ok);
});

test('one v2 local tag may declare multiple uses of a shared SRS while distinct endpoints cannot be conflated', () => {
  const r: any = subscriptionInput();
  r.recipe.resources.ruleSets[0].subscriptionRef = { systemRuleSetId: r.dependencies.subscriptions[0].systemRuleSetId, usages: ['route', 'dns-query'] };
  r.recipe.resources.ruleSets.splice(1, 1);
  r.recipe.dnsSteps[0].rule.rule_set = 'routing';
  assert.ok(compileRecipe(r).ok);
  r.recipe.dnsSteps.push({ id: 'eval', rule: { action: 'evaluate', server: 'local', tag: 'first' } },
    { id: 'response', rule: { match_response: 'first', rule_set: 'routing', action: 'respond' } });
  rejects(r, 'ARTIFACT_USAGE_MISMATCH');
  r.recipe.dnsSteps.splice(1);
  for (const usages of [[], ['route', 'route'], ['route', 'unknown']]) {
    const invalid = structuredClone(r); invalid.recipe.resources.ruleSets[0].subscriptionRef.usages = usages;
    rejects(invalid, 'STRUCTURE_INVALID');
  }
  const both = structuredClone(r); both.recipe.resources.ruleSets[0].subscriptionRef.usage = 'route';
  rejects(both, 'STRUCTURE_INVALID');
  r.dependencies.subscriptions[0].projections['dns-query'].formats.binary.url += '.other';
  rejects(r, 'SUBSCRIPTION_ENDPOINT_MISMATCH');
});

test('v2 still resolves exact Template and Node revisions and enforces fixed Profile edits', () => {
  for (const mutate of [
    (r: any) => { r.recipe.templateRef.revision = 'missing'; },
    (r: any) => { r.recipe.resources.outbounds[0].nodeRef.revision = 'missing'; },
  ]) { const r = subscriptionInput(); mutate(r); rejects(r, 'DEPENDENCY_MISSING'); }
  const r = subscriptionInput();
  const candidate = structuredClone(r.recipe);
  candidate.profile = 'ios-appstore'; candidate.revision = '2';
  const decision = decideRecipeEdit({ previous: r.recipe, candidate, dependencies: r.dependencies, params: r.params, nodes: [{ id: 'shared', archived: false }] });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some(d => d.code === 'RECIPE_PROFILE_FIXED'));
});

test('resolved Compiler entry cannot bypass subscription consumer-position checks', () => {
  const resolved = success(resolveRecipe(subscriptionResponseInput()));
  resolved.recipe.routeSteps = [{ rule: { rule_set: 'queries', outbound: 'direct' } }];
  assert.ok(compile(resolved).diagnostics.some(d => d.code === 'ARTIFACT_USAGE_MISMATCH'));
  const response = success(resolveRecipe(subscriptionResponseInput()));
  response.recipe.dnsSteps.splice(1, 1);
  assert.ok(compile(response).diagnostics.some(d => d.code === 'ARTIFACT_USAGE_MISMATCH'));
});
