import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile, preparePublication, renderSubscription } from '../src/index.js';
import { commitPublication, readPublication } from '../src/publisher.js';
import { digest } from '../src/json.js';
import type { GenerationParams, Obj } from '../src/types.js';
import { fixture } from './fixtures.js';
import { success } from './helpers.js';

function withoutEcs(config: Obj): Obj {
  const copy = structuredClone(config);
  for (const rule of (copy.dns as Obj).rules as Obj[]) {
    if (rule.action === 'evaluate' && rule.tag === 'ecs') { delete rule.client_subnet; delete rule.remove_client_subnet; }
  }
  return copy;
}
function ecsRule(config: Obj): Obj { return ((config.dns as Obj).rules as Obj[]).find(r => r.tag === 'ecs')!; }

test('ECS is computed from explicit public IPv4 and prefix; no default mask', () => {
  const { input } = fixture();
  for (const [address, prefix, expected] of [['8.8.8.9', 24, '8.8.8.0/24'], ['9.9.9.9', 20, '9.9.0.0/20'], ['1.1.1.1', 32, '1.1.1.1/32']] as const) {
    input.params = { ecs: { address, prefix } };
    assert.equal(ecsRule(success(compile(input)).config).client_subnet, expected);
  }
});

test('unreliable addresses are rejected and null explicitly removes stored ECS', () => {
  for (const address of ['127.0.0.1', '192.168.1.1', '100.64.0.1', '192.0.2.1', '224.0.0.1', '::1', '8.8.8', '008.8.8.8', '999.1.1.1']) {
    const { input } = fixture(); input.params.ecs = { address, prefix: 24 };
    assert.equal(compile(input).ok, false, address);
  }
  const { input } = fixture();
  const enabled = success(compile(input)).config;
  input.params.ecs = null;
  const disabled = success(compile(input)).config;
  assert.equal(ecsRule(disabled).client_subnet, undefined);
  assert.equal(ecsRule(disabled).remove_client_subnet, true);
  assert.deepEqual(withoutEcs(enabled), withoutEcs(disabled));
  input.params = { ecs: { address: '8.8.8.8' } } as GenerationParams;
  assert.equal(compile(input).ok, false);
});

test('undeclared ECS positions and duplicate declarations cannot leak an old subnet', () => {
  const { input } = fixture();
  input.recipe.dnsSteps.unshift({ rule: { domain: 'example.com', action: 'route', server: 'dns_proxy', client_subnet: '1.1.1.0/24' } });
  input.params.ecs = null;
  assert.equal(compile(input).ok, false);
  const another = fixture().input;
  another.template.ecsResponseTags.push('ecs');
  assert.equal(compile(another).ok, false);
});

test('publication checks both variants; subscriptions only change declared fields', async () => {
  const { input } = fixture();
  const checked: Obj[] = [];
  const publication = success(await preparePublication(input, async c => { checked.push(c); }));
  assert.equal(checked.length, 2);
  assert.equal(ecsRule(checked[0]).client_subnet, '8.8.8.0/24');
  assert.equal(ecsRule(checked[1]).remove_client_subnet, true);
  const before = structuredClone(publication);
  const [a, b, disabled] = await Promise.all([
    renderSubscription(publication, { ecs: { address: '8.8.4.4', prefix: 24 } }),
    renderSubscription(publication, { ecs: { address: '1.1.1.1', prefix: 32 } }),
    renderSubscription(publication, { ecs: null }),
  ]);
  assert.deepEqual(withoutEcs(success(a)), withoutEcs(success(b)));
  assert.deepEqual(withoutEcs(success(a)), withoutEcs(success(disabled)));
  assert.deepEqual(publication, before);
  assert.equal((await renderSubscription(publication, { ecs: null, patch: {} } as GenerationParams)).ok, false);
});

test('a changed snapshot or compiler identity cannot reuse native validation', async () => {
  const publication = success(await preparePublication(fixture().input, async () => {}));
  const corrupt = structuredClone(publication);
  (corrupt.body.compiled.config.route as Obj).final = 'different';
  assert.equal((await renderSubscription(corrupt, { ecs: null })).ok, false);
  const old = structuredClone(publication);
  old.body.compiled.versions.compiler = 'old';
  old.id = await digest(old.body);
  assert.equal((await renderSubscription(old, { ecs: null })).ok, false);
});

test('changing recipe, template, artifacts, or profile requires a new publication', async () => {
  const baseline = success(await preparePublication(fixture().input, async () => {}));
  for (const field of ['recipe', 'template', 'artifacts', 'profile'] as const) {
    const { input } = fixture();
    if (field === 'recipe' || field === 'template') input[field].revision = 'next';
    else if (field === 'artifacts') input.artifacts[0].revision = 'next';
    else {
      input.profile = 'windows-standalone';
      input.template.platformDnsServers['windows-standalone'] = input.template.platformDnsServers['macos-standalone'];
    }
    let checks = 0;
    const publication = success(await preparePublication(input, async () => { checks++; }));
    assert.equal(checks, 2);
    assert.notEqual(publication.id, baseline.id, field);
    assert.notEqual(publication.body.inputHash, baseline.body.inputHash, field);
  }
});

test('native failure in either variant preserves the last published snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd06-publish-test-'));
  try {
    const original = success(await preparePublication(fixture().input, async () => {}));
    await commitPublication(directory, original);
    const pointer = await readFile(join(directory, 'current.json'), 'utf8');
    for (const failAt of [1, 2]) {
      let count = 0;
      const result = await preparePublication(fixture().input, async () => { if (++count === failAt) throw new Error('private diagnostic'); });
      assert.equal(result.ok, false);
      assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
      assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), pointer);
      assert.equal((await readPublication(directory)).id, original.id);
    }
    const { input } = fixture(); input.recipe.revision = 'next';
    const next = success(await preparePublication(input, async () => {}));
    await commitPublication(directory, next);
    assert.equal((await readPublication(directory)).id, next.id);
    assert.ok(await readFile(join(directory, 'releases', `${original.id}.json`)));
    await commitPublication(directory, original);
    assert.equal((await readPublication(directory)).id, original.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('caller/checker mutations during asynchronous checks cannot change the published snapshot', async () => {
  const { input } = fixture();
  const before = structuredClone(input);
  const publication = success(await preparePublication(input, async config => {
    input.recipe.revision = 'changed-during-check';
    (config.route as Obj).final = 'checker-mutated-copy';
  }));
  assert.equal(publication.body.inputHash, await digest(before));
  assert.equal((publication.body.compiled.config.route as Obj).final, '漏网之鱼');
});
