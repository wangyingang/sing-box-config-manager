import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import schema from '../../rule-set-pipeline/contracts/rule-subscription-v2.schema.json' with { type: 'json' };
import { compile, compileRecipe, preparePublication, prepareRecipePublication, renderSubscription, resolveRecipe } from '../src/index.js';
import { digest } from '../src/json.js';
import example from '../examples/three-rule-subscriptions-v2.json' with { type: 'json' };
import { success } from './helpers.js';

const ids = ['openai', 'anthropic', 'google-deepmind'] as const;
const profiles = ['windows-standalone', 'macos-standalone', 'macos-appstore', 'ios-appstore', 'android-google-play'] as const;
const url = (id: string) => `https://rules.example.invalid/stable/${id}/domains.srs`;

function threeSubscriptions(): any {
  return structuredClone(example);
}

test('five Client Profiles compile three logical subscriptions with matching Route and DNS SRS URLs', () => {
  const validates = new Ajv.default({ strict: true }).compile(schema);
  for (const subscription of threeSubscriptions().dependencies.subscriptions) assert.equal(validates(subscription), true, JSON.stringify(validates.errors));
  for (const profile of profiles) {
    const request = threeSubscriptions();
    request.recipe.profile = profile;
    request.dependencies.templates[0].platformDnsServers[profile] = [{ type: 'local', tag: 'local' }];
    const compiled = success(compileRecipe(request));
    const sets = (compiled.config.route as any).rule_set;
    assert.deepEqual(sets.map((set: any) => [set.tag, set.url]), ids.map(id => [id, url(id)]));
    assert.deepEqual(compiled.subscriptions?.map(s => s.systemRuleSetId), ids);
    for (const id of ids) {
      const subscription = request.dependencies.subscriptions.find((s: any) => s.systemRuleSetId === id);
      assert.deepEqual(subscription.projections['dns-query'].formats, subscription.projections.route.formats);
      assert.equal(subscription.projections.route.formats.binary.url, url(id));
      assert.equal(subscription.projections.route.formats.source.url, url(id).replace('.srs', '.json'));
      assert.deepEqual(subscription.projections['dns-response'], { unavailable: 'empty' });
      assert.ok((compiled.config.route as any).rules.some((rule: any) => rule.rule_set === id));
      assert.ok((compiled.config.dns as any).rules.some((rule: any) => rule.rule_set === id));
    }
  }
});

test('one Recipe publication and delivery retain three v2 contracts and stable URLs', async () => {
  const request = threeSubscriptions();
  let checks = 0;
  const publication = success(await prepareRecipePublication(request, async () => { checks++; }));
  assert.equal(checks, 2);
  assert.deepEqual(publication.body.recipeSource?.subscriptions?.map(s => s.systemRuleSetId), ids);
  assert.deepEqual(publication.body.compiled.subscriptions?.map(s => s.systemRuleSetId), ids);
  assert.deepEqual((success(await renderSubscription(publication, request.params)).route as any).rule_set.map((set: any) => set.url), ids.map(url));
});

test('compile, publication and delivery reject v1 subscriptions; unavailable DNS response and conflicting URLs fail before publish', async () => {
  const request = threeSubscriptions();
  const old = structuredClone(request);
  old.dependencies.subscriptions[0].schemaVersion = 1;
  assert.equal(compileRecipe(old).ok, false);
  const resolvedWithV1 = { ...success(resolveRecipe(request)), subscriptions: old.dependencies.subscriptions } as any;
  assert.ok(compile(resolvedWithV1).diagnostics.some(d => d.code === 'SUBSCRIPTION_INVALID' && d.path === '/subscriptions/0/schemaVersion'));
  let checks = 0;
  assert.equal((await prepareRecipePublication(old, async () => { checks++; })).ok, false);
  assert.equal((await preparePublication(resolvedWithV1, async () => { checks++; })).ok, false);
  assert.equal(checks, 0);
  const published = success(await prepareRecipePublication(request, async () => {}));
  const oldSnapshot: any = structuredClone(published);
  oldSnapshot.body.compiled.subscriptions![0]!.schemaVersion = 1;
  oldSnapshot.id = await digest(oldSnapshot.body);
  assert.ok((await renderSubscription(oldSnapshot, request.params)).diagnostics.some(d => d.code === 'SUBSCRIPTION_INVALID' && d.path === '/subscriptions/0/schemaVersion'));
  const oldSourceSnapshot: any = structuredClone(published);
  oldSourceSnapshot.body.recipeSource.subscriptions[0].schemaVersion = 1;
  oldSourceSnapshot.id = await digest(oldSourceSnapshot.body);
  assert.ok((await renderSubscription(oldSourceSnapshot, request.params)).diagnostics.some(d => d.code === 'SUBSCRIPTION_INVALID'));

  const response = threeSubscriptions();
  response.recipe.resources.ruleSets[0].subscriptionRef.usages = ['dns-response'];
  assert.ok(compileRecipe(response).diagnostics.some(d => d.code === 'ARTIFACT_PROJECTION_EMPTY'));
  assert.equal((await prepareRecipePublication(response, async () => { checks++; })).ok, false);

  const conflict = threeSubscriptions();
  conflict.dependencies.subscriptions[1].projections.route.formats.binary.url = url(ids[0]);
  conflict.dependencies.subscriptions[1].projections.route.formats.binary.requiredCapabilities = ['processMatching'];
  assert.ok(compileRecipe(conflict).diagnostics.some(d => d.code === 'SUBSCRIPTION_ENDPOINT_CONFLICT'));
  assert.equal((await prepareRecipePublication(conflict, async () => { checks++; })).ok, false);
  assert.equal(checks, 0);

  const conflictingSnapshot: any = structuredClone(published);
  conflictingSnapshot.body.compiled.subscriptions[1].projections.route.formats.binary.url = url(ids[0]);
  conflictingSnapshot.body.compiled.subscriptions[1].projections.route.formats.binary.requiredCapabilities = ['processMatching'];
  conflictingSnapshot.id = await digest(conflictingSnapshot.body);
  assert.ok((await renderSubscription(conflictingSnapshot, request.params)).diagnostics.some(d => d.code === 'PUBLICATION_INVALID'));
  conflictingSnapshot.body.recipeSource.subscriptions = structuredClone(conflictingSnapshot.body.compiled.subscriptions);
  conflictingSnapshot.id = await digest(conflictingSnapshot.body);
  assert.ok((await renderSubscription(conflictingSnapshot, request.params)).diagnostics.some(d => d.code === 'SUBSCRIPTION_ENDPOINT_CONFLICT'));
});
