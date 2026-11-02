import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, resolveRecipe, validateRecipeDraft } from '../src/index.js';
import { input } from './recipe-fixtures.js';
import { sampleDnsInput } from './dns-fixtures.js';
import { success } from './helpers.js';

function dns(request: unknown): any { return success(compileRecipe(request)).config.dns; }

test('sample DNS first/ecs flow preserves every rule and only declared ECS positions vary', () => {
  const { request, expectedRules } = sampleDnsInput();
  const before = structuredClone(request);
  const expected = structuredClone(expectedRules);
  expected.find(r => r.tag === 'ecs')!.client_subnet = '8.8.8.0/24';
  assert.deepEqual(dns(request).rules, expected);
  request.params.ecs = { address: '1.1.1.1', prefix: 32 };
  expected.find(r => r.tag === 'ecs')!.client_subnet = '1.1.1.1/32';
  assert.deepEqual(dns(request).rules, expected);
  request.params.ecs = null;
  const ecs = expected.find(r => r.tag === 'ecs')!;
  delete ecs.client_subnet; ecs.remove_client_subnet = true;
  assert.deepEqual(dns(request).rules, expected);
  request.params = before.params;
  assert.deepEqual(request, before);
  const resolved = success(resolveRecipe(request));
  resolved.template.dnsPresets['5.dns.json']![0]!.action = 'reject';
  assert.deepEqual(request, before);
  const other = sampleDnsInput().request;
  assert.deepEqual(dns(other).rules, dns(request).rules);
});

test('DNS and Route steps are independent; DNS presets expand in place with independent repeats', () => {
  const request: any = input();
  request.dependencies.templates[0].dnsPresets = { local: [{ domain_suffix: 'lan', server: 'local' }] };
  request.recipe.dnsSteps = [{ id: 'shared-id', preset: 'local' }, { id: 'inline', rule: { query_type: 'AAAA', action: 'predefined', rcode: 'NOERROR' } }, { id: 'repeat', preset: 'local' }];
  request.recipe.routeSteps = [{ id: 'shared-id', rule: { action: 'sniff' } }];
  const expected = [{ domain_suffix: 'lan', server: 'local' }, { query_type: 'AAAA', action: 'predefined', rcode: 'NOERROR' }, { domain_suffix: 'lan', server: 'local' }];
  const rules = dns(request).rules;
  assert.deepEqual(rules, expected);
  rules[0].domain_suffix = 'changed'; assert.equal(rules[2].domain_suffix, 'lan');
  request.recipe.dnsSteps = [request.recipe.dnsSteps[1], request.recipe.dnsSteps[0]];
  assert.deepEqual(dns(request).rules, [expected[1], expected[0]]);
  assert.deepEqual((success(compileRecipe(request)).config.route as any).rules, [{ action: 'sniff' }]);
  request.recipe.dnsSteps = [request.recipe.dnsSteps[0]];
  assert.deepEqual(dns(request).rules, [expected[1]]);
});

test('DNS response references require prior definitions, including nested logical conditions', () => {
  const request: any = input();
  request.dependencies.templates[0].dnsPresets = { evaluate: [{ action: 'evaluate', tag: 'first', server: 'local' }] };
  const evaluate = { id: 'define', preset: 'evaluate' };
  const respond = { id: 'use', rule: { type: 'logical', mode: 'and', rules: [{ type: 'logical', mode: 'or', rules: [{ match_response: 'first', response_rcode: 'NOERROR' }] }], action: 'respond' } };
  request.recipe.dnsSteps = [evaluate, respond];
  assert.equal(compileRecipe(request).ok, true);
  for (const steps of [[respond, evaluate], [respond]]) {
    request.recipe.dnsSteps = steps;
    const before = structuredClone(request);
    const result = compileRecipe(request);
    assert.equal(result.ok, false);
    const diagnostic = result.diagnostics.find(d => d.code === 'DNS_RESPONSE_MISSING')!;
    assert.equal(diagnostic.path, '/recipe/dnsSteps/0/rule/rules/0/rules/0/match_response');
    assert.equal(diagnostic.source?.stepId, 'use');
    assert.equal(success(validateRecipeDraft(request.recipe)).dnsSteps.length, steps.length);
    assert.deepEqual(request, before);
  }
  request.recipe.dnsSteps = [evaluate, { ...evaluate, id: 'again' }];
  const duplicate = compileRecipe(request).diagnostics.find(d => d.code === 'DNS_RESPONSE_DUPLICATE')!;
  assert.deepEqual(duplicate.source, { stepId: 'again', stepIndex: 1, preset: 'evaluate', presetRuleIndex: 0, outputRuleIndex: 1, outputPath: '/dns/rules/1/tag' });
  request.recipe.dnsSteps = [{ id: 'unnamed', rule: { match_response: true, action: 'respond' } }];
  assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'DNS_RESPONSE_MISSING'));
});

test('removing a declared ECS evaluate never repairs policy or disables ECS implicitly', () => {
  const { request } = sampleDnsInput();
  const template = request.dependencies.templates[0]!;
  template.dnsPresets!['5.dns.json'] = template.dnsPresets!['5.dns.json']!.filter(rule => !('tag' in rule && rule.tag === 'ecs'));
  for (const ecs of [{ address: '8.8.8.8', prefix: 24 }, null]) {
    request.params.ecs = ecs;
    const before = structuredClone(request);
    assert.equal(compileRecipe(request).ok, false);
    assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'ECS_INVALID'));
    assert.deepEqual(request, before);
  }
});

test('DNS diagnostics map preset offsets, missing presets and duplicate step IDs', () => {
  const request: any = input();
  request.dependencies.templates[0].dnsPresets = { broken: [{ action: 'evaluate', server: 'local', tag: 'first' }, { match_response: 'missing', action: 'respond' }] };
  request.recipe.dnsSteps = [{ id: 'prefix', rule: { query_type: 'AAAA', action: 'predefined', rcode: 'NOERROR' } }, { id: 'policy', preset: 'broken' }];
  const result = compileRecipe(request);
  const diagnostic = result.diagnostics.find(d => d.code === 'DNS_RESPONSE_MISSING')!;
  assert.equal(diagnostic.path, '/recipe/dnsSteps/1/preset');
  assert.deepEqual(diagnostic.source, { stepId: 'policy', stepIndex: 1, preset: 'broken', presetRuleIndex: 1, outputRuleIndex: 2, outputPath: '/dns/rules/2/match_response' });
  for (const preset of ['absent', 'constructor', '__proto__']) {
    request.recipe.dnsSteps = [{ id: 'gone', preset }];
    assert.equal(compileRecipe(request).diagnostics[0]?.source?.stepId, 'gone');
    assert.equal(compileRecipe(request).diagnostics[0]?.code, 'PRESET_MISSING');
  }
  request.recipe.dnsSteps = [{ id: 'same', preset: 'broken' }, { id: 'same', preset: 'broken' }];
  assert.equal(compileRecipe(request).diagnostics[0]?.code, 'STEP_ID_DUPLICATE');
});

test('DNS servers, HTTP clients and dnsFinal preserve resource order and validate references', () => {
  const request: any = input();
  const template = request.dependencies.templates[0];
  template.resources.dnsServers = [{ type: 'https', tag: 'doh', server: 'dns.example.test', server_port: 443, path: '/dns-query', headers: { Host: ['dns.example.test'] }, tls: { enabled: true, server_name: 'dns.example.test' }, domain_resolver: { server: 'local', strategy: 'ipv4_only' }, detour: 'direct' }];
  template.resources.httpClients = [{ tag: 'shared', detour: 'direct', domain_resolver: { server: 'local', strategy: 'ipv4_only' } }];
  request.recipe.resources.httpClients = [{ tag: 'custom', domain_resolver: 'local' }];
  request.recipe.resources.dnsServers = [{ type: 'local', tag: 'custom-local', neighbor_domain: [], prefer_go: false }];
  request.recipe.settings = { dnsFinal: 'custom-local' };
  const config = success(compileRecipe(request)).config;
  assert.deepEqual((config.dns as any).servers.map((s: any) => s.tag), ['doh', 'local', 'custom-local']);
  assert.equal((config.dns as any).final, 'custom-local');
  assert.deepEqual((config.http_clients as any[]).map(c => c.tag), ['shared', 'custom']);
  for (const mutate of [
    (r: any) => { r.recipe.settings.dnsFinal = 'missing'; },
    (r: any) => { r.dependencies.templates[0].resources.dnsServers[0].domain_resolver.server = 'missing'; },
    (r: any) => { r.dependencies.templates[0].resources.dnsServers[0].detour = 'missing'; },
    (r: any) => { r.recipe.resources.httpClients[0].domain_resolver = 'missing'; },
    (r: any) => { r.dependencies.templates[0].resources.httpClients[0].detour = 'missing'; },
  ]) {
    const broken = structuredClone(request); mutate(broken);
    assert.ok(compileRecipe(broken).diagnostics.some(d => d.code === 'REFERENCE_MISSING'));
  }
  request.recipe.resources.dnsServers.push({ type: 'local', tag: 'local' });
  assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'TAG_DUPLICATE'));
});

test('Template selects Android local resolver; incompatible process and application matches fail', () => {
  const { request } = sampleDnsInput();
  request.recipe.profile = 'android-google-play';
  assert.equal(dns(request).servers.find((s: any) => s.tag === 'dns_lan').type, 'local');
  const platform = request.dependencies.templates[0]!.platformDnsServers;
  platform['android-google-play'] = [{ type: 'dhcp', tag: 'dns_lan' }];
  assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
  platform['android-google-play'] = [{ type: 'local', tag: 'dns_lan' }];
  request.recipe.dnsSteps.unshift({ id: 'process', rule: { type: 'logical', mode: 'and', rules: [{ process_name: 'desktop' }], server: 'dns_local' } });
  assert.equal(compileRecipe(request).ok, false);
  assert.equal(compileRecipe(request).diagnostics.find(d => d.code === 'CAPABILITY_UNSUPPORTED')?.source?.stepId, 'process');
  request.recipe.dnsSteps[0] = { id: 'package', rule: { package_name: 'org.example.app', server: 'dns_local' } };
  assert.equal(compileRecipe(request).ok, true);
  request.recipe.profile = 'macos-standalone';
  assert.equal(compileRecipe(request).ok, false);
  assert.equal(compileRecipe(request).diagnostics.find(d => d.code === 'CAPABILITY_UNSUPPORTED')?.source?.stepId, 'package');
});

test('DNS structured inputs reject arbitrary fields, dynamic ECS and malformed nested objects', () => {
  for (const mutate of [
    (r: any) => { r.recipe.dnsSteps = [{ id: 'bad', rule: { action: 'evaluate', server: 'local', client_subnet: '8.8.8.0/24' } }]; },
    (r: any) => { r.dependencies.templates[0].dnsPresets = { bad: [{ action: 'evaluate', server: 'local', client_subnet: '8.8.8.0/24' }] }; },
    (r: any) => { r.recipe.dnsSteps = [{ id: 'bad', rule: { type: 'logical', mode: 'or', rules: [{ action: 'reject' }], action: 'respond' } }]; },
    (r: any) => { r.recipe.dnsSteps = [{ id: 'bad', rule: { action: 'respond', server: 'local' } }]; },
    (r: any) => { r.recipe.dnsSteps = [{ id: 'bad', preset: 'x', rule: { action: 'reject' } }]; },
    (r: any) => { r.recipe.resources.dnsServers = [{ type: 'dhcp', tag: 'lan' }]; },
    (r: any) => { r.recipe.resources.dnsServers = [{ type: 'https', tag: 'doh', server: '8.8.8.8', server_port: 443, headers: { Host: {} } }]; },
    (r: any) => { r.recipe.resources.httpClients = [{ tag: 'http', options: {} }]; },
    (r: any) => { r.recipe.resources.httpClients = [{ tag: 'http', domain_resolver: { strategy: 'ipv4_only' } }]; },
    (r: any) => { r.params.ecs = { address: '8.8.8.8' }; },
    (r: any) => { r.recipe.settings = { ecs: { address: '8.8.8.8', prefix: 24 } }; },
  ]) {
    const request = input(); mutate(request);
    assert.equal(compileRecipe(request).diagnostics[0]?.code, 'STRUCTURE_INVALID');
  }
  for (const address of ['192.168.1.1', '::1', '::ffff:8.8.8.8', '8.8.8.999']) {
    const request: any = input(); request.params.ecs = { address, prefix: 24 };
    assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'ECS_INVALID'));
  }
});
