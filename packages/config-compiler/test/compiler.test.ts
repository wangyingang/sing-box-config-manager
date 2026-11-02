import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, inspectComposition, validateConfig } from '../src/index.js';
import type { CompileInput, Obj } from '../src/types.js';
import { fixture, manifest } from './fixtures.js';
import { normalize } from './normalize.js';
import { success } from './helpers.js';
function fails(input: CompileInput, code: string) {
  const result = compile(input);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === code), JSON.stringify(result.diagnostics));
}

for (const entry of manifest.cases) {
  test(`${entry.id}: preserved legacy semantics and ordering`, () => {
    const { input, golden } = fixture(entry.id);
    const before = structuredClone(input);
    const inspection = inspectComposition(input);
    assert.ok(inspection.candidate);
    const first = inspection.candidate;
    if (entry.profile === 'android-google-play') {
      fails(input, 'CAPABILITY_UNSUPPORTED');
      assert.ok(inspection.diagnostics.every(d => d.code === 'CAPABILITY_UNSUPPORTED'));
    } else assert.ok(compile(input).ok);
    assert.deepEqual(normalize(first.config), normalize(golden));
    assert.deepEqual(compile(input), compile(input));
    assert.deepEqual(input, before);
    assert.equal((first.config.dns as Obj).strategy, 'ipv4_only');
  });
}

test('explicit settings replace defaults without merging arbitrary fields', () => {
  const { input } = fixture();
  input.recipe.settings = { logLevel: 'debug', tunMtu: 1400, routeFinal: '代理', dnsFinal: 'dns_direct' };
  const output = success(compile(input)).config;
  assert.equal((output.log as Obj).level, 'debug');
  assert.equal((output.inbounds as Obj[])[0].mtu, 1400);
  assert.equal((output.route as Obj).final, '代理');
  assert.equal((output.dns as Obj).final, 'dns_direct');
  (input.recipe.settings as unknown as Obj).patch = { log: null };
  fails(input, 'INPUT_UNKNOWN');
});

test('null is not a deletion operation and schema rejects invalid fields', () => {
  const { input } = fixture();
  input.template.defaults.log = null as unknown as Obj;
  fails(input, 'INPUT_INVALID');
  const another = fixture().input;
  another.recipe.dnsSteps.unshift({ rule: { unknown_match: 'value', action: 'reject' } });
  fails(another, 'SCHEMA_INVALID');
});

test('duplicate tags fail in every managed namespace', () => {
  for (const key of ['outbounds', 'inbounds', 'dnsServers', 'httpClients', 'services'] as const) {
    const { input } = fixture();
    const sample = input.template.resources[key]![0];
    (input.recipe.resources[key] ??= []).push(structuredClone(sample));
    const result = compile(input);
    assert.equal(result.ok, false, key);
    assert.ok(result.diagnostics.some(d => ['TAG_DUPLICATE', 'SCHEMA_INVALID'].includes(d.code)));
  }
  const { input } = fixture();
  input.recipe.resources.ruleSets!.push(structuredClone(input.template.resources.ruleSets![0]));
  fails(input, 'TAG_DUPLICATE');
});

test('missing references are checked independently of native check', () => {
  const mutations: ((i: CompileInput) => void)[] = [
    i => { i.recipe.settings = { routeFinal: 'missing' }; },
    i => { i.recipe.settings = { dnsFinal: 'missing' }; },
    i => { i.recipe.resources.outbounds!.push({ type: 'selector', tag: 'broken', outbounds: ['missing'] }); },
    i => { i.recipe.resources.outbounds!.push({ type: 'direct', tag: 'broken', detour: 'missing' }); },
    i => { i.recipe.dnsSteps.unshift({ rule: { domain: 'example.com', action: 'route', server: 'missing' } }); },
    i => { i.recipe.routeSteps.unshift({ rule: { rule_set: 'missing', action: 'reject' } }); },
    i => { i.template.defaults.route!.default_http_client = 'missing'; },
    i => { i.template.defaults.route!.default_domain_resolver = { server: 'missing' }; },
    i => { i.recipe.routeSteps.unshift({ rule: { inbound: 'missing', action: 'reject' } }); },
  ];
  for (const mutate of mutations) { const { input } = fixture(); mutate(input); fails(input, 'REFERENCE_MISSING'); }
});

test('outbound dependency cycles and group defaults are rejected', () => {
  const { input } = fixture();
  input.recipe.resources.outbounds!.push({ type: 'selector', tag: 'cycle-a', outbounds: ['cycle-b'] }, { type: 'selector', tag: 'cycle-b', outbounds: ['cycle-a'] });
  fails(input, 'OUTBOUND_CYCLE');
  const other = fixture().input;
  other.recipe.resources.outbounds!.push({ type: 'selector', tag: 'broken', outbounds: ['直连'], default: '代理' });
  fails(other, 'GROUP_DEFAULT_INVALID');
});

test('named DNS responses must precede references, including nested references', () => {
  const { input } = fixture();
  input.recipe.dnsSteps.unshift({ rule: { type: 'logical', mode: 'or', rules: [{ match_response: 'first', response_rcode: 'NOERROR' }], action: 'respond' } });
  fails(input, 'DNS_RESPONSE_MISSING');
  const other = fixture().input;
  other.recipe.dnsSteps.unshift({ rule: { action: 'evaluate', server: 'dns_proxy', tag: 'first' } });
  fails(other, 'DNS_RESPONSE_DUPLICATE');
});

test('rule steps retain duplicates and order; unreachable post rules get a warning', () => {
  const { input } = fixture();
  input.recipe.routeSteps.push({ rule: { action: 'reject' } }, { rule: { domain: 'example.com', action: 'reject' } }, { rule: { domain: 'example.com', action: 'reject' } });
  const result = compile(input);
  const config = success(result).config;
  const tail = ((config.route as Obj).rules as Obj[]).slice(-3);
  assert.deepEqual(tail, [{ action: 'reject' }, { domain: 'example.com', action: 'reject' }, { domain: 'example.com', action: 'reject' }]);
  assert.equal(result.diagnostics.filter(d => d.code === 'RULE_UNREACHABLE').length, 2);
});

test('platform resolver selection happens before duplicate detection', () => {
  const { input } = fixture('user-b-android-tun');
  const servers = (inspectComposition(input).candidate!.config.dns as Obj).servers as Obj[];
  assert.equal(servers.find(s => s.tag === 'dns_lan')!.type, 'local');
  assert.equal(servers.some(s => s.type === 'dhcp'), false);
  input.template.platformDnsServers['android-google-play'] = [{ type: 'dhcp', tag: 'dns_lan' }];
  fails(input, 'CAPABILITY_UNSUPPORTED');
});

test('a platform-appropriate Android recipe compiles without dropping rules', () => {
  const input: CompileInput = {
    template: { id: 'android', revision: '1', targetVersion: '1.14.4', defaults: { dns: { final: 'lan' }, route: { final: 'direct' } },
      resources: { outbounds: [{ type: 'direct', tag: 'direct' }] }, platformDnsServers: { 'android-google-play': [{ type: 'local', tag: 'lan' }] }, dnsPresets: {}, routePresets: {}, ecsResponseTags: [] },
    recipe: { id: 'phone', revision: '1', resources: {}, dnsSteps: [], routeSteps: [{ rule: { package_name: 'org.example.app', action: 'route', outbound: 'direct' } }] },
    artifacts: [], profile: 'android-google-play', params: { ecs: null },
  };
  const config = success(compile(input)).config;
  assert.equal(((config.route as Obj).rules as Obj[])[0].package_name, 'org.example.app');
});

test('five Profiles are distinct from five fixture combinations', () => {
  for (const profile of ['macos-appstore', 'ios-appstore'] as const) {
    const { input } = fixture(); input.profile = profile;
    input.template.platformDnsServers[profile] = [{ type: 'dhcp', tag: 'dns_lan' }];
    fails(input, 'CAPABILITY_UNSUPPORTED');
  }
  const { input } = fixture();
  input.profile = 'windows-standalone';
  input.template.platformDnsServers['windows-standalone'] = [{ type: 'dhcp', tag: 'dns_lan' }];
  assert.ok(compile(input).ok);
  input.profile = 'unknown' as CompileInput['profile']; fails(input, 'PROFILE_UNKNOWN');
});

test('curated rule metadata participates in profile validation', () => {
  const { input } = fixture();
  input.artifacts.find(a => a.id === 'OpenAI')!.requiredCapabilities = ['packageMatching'];
  fails(input, 'CAPABILITY_UNSUPPORTED');
  const other = fixture().input;
  other.recipe.resources.ruleSets!.push({ kind: 'inline', definition: { type: 'remote', tag: 'custom', url: 'https://example.com/custom.srs' } });
  fails(other, 'RULE_SET_INLINE_REQUIRED');
});

test('user-d remains independent; output mutation cannot alter future generations', () => {
  const a = success(compile(fixture().input)).config;
  const { input } = fixture('user-d-tun');
  const d = success(compile(input)).config;
  assert.notDeepEqual(a.outbounds, d.outbounds);
  (d.outbounds as Obj[]).length = 0;
  assert.ok((success(compile(input)).config.outbounds as Obj[]).length > 0);
});

test('schema and semantic validation also reject invalid final configs', () => {
  const config = success(compile(fixture().input)).config;
  (config.route as Obj).final = 'missing';
  assert.ok(validateConfig(config, 'macos-standalone').some(d => d.code === 'REFERENCE_MISSING'));
});

test('missing presets and artifacts fail instead of generating a partial config', () => {
  const { input } = fixture();
  input.recipe.dnsSteps.unshift({ preset: 'missing' });
  fails(input, 'PRESET_MISSING');
  const other = fixture().input;
  other.artifacts = [];
  fails(other, 'ARTIFACT_MISSING');
});

test('local key resources cannot become a hidden dependency of an otherwise portable config', () => {
  const { input } = fixture();
  input.recipe.resources.outbounds!.push({ type: 'ssh', tag: 'ssh-test', server: '192.0.2.1', user: 'fixture', private_key_path: '/private/test-key' });
  fails(input, 'RESOURCE_PATH_UNSUPPORTED');
});

test('non-JSON values cannot produce a non-serializable publication', () => {
  const { input } = fixture();
  input.recipe.settings = { tunMtu: Number.NaN };
  fails(input, 'INPUT_INVALID');
  input.recipe.settings = { logLevel: undefined };
  fails(input, 'INPUT_INVALID');
});
