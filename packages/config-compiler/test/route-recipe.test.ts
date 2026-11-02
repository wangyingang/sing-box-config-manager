import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, resolveRecipe } from '../src/index.js';
import { input } from './recipe-fixtures.js';
import { success } from './helpers.js';

test('Recipe keeps Direct, fixed nodes, Selector and URLTest in declared resource order', () => {
  const request: any = input();
  request.recipe.resources.outbounds.push(
    { type: 'urltest', tag: 'auto', outbounds: ['alice-proxy'], url: 'https://example.com', interval: '3m', tolerance: 50, idle_timeout: '30m', interrupt_exist_connections: true },
    { type: 'selector', tag: 'proxy', outbounds: ['direct', 'auto'], default: 'auto', interrupt_exist_connections: true },
    { type: 'direct', tag: 'local' },
  );
  request.recipe.settings = { routeFinal: 'proxy', logLevel: 'debug', dnsFinal: 'local' };
  const config = success(compileRecipe(request)).config;
  assert.deepEqual((config.outbounds as any[]).map(o => o.tag), ['direct', 'alice-proxy', 'auto', 'proxy', 'local']);
  assert.equal((config.route as any).final, 'proxy');
  assert.equal((config.log as any).level, 'debug');
  assert.equal((config.dns as any).final, 'local');
  assert.equal(success(resolveRecipe(request)).recipe.resources.outbounds?.[2]?.type, 'selector');
});

test('Route presets expand at array positions, with independent repeats and headless sets', () => {
  const request: any = input();
  request.recipe.resources.ruleSets = [{ kind: 'inline', definition: { type: 'inline', tag: 'local-names', rules: [{ domain_suffix: 'lan' }] } }];
  request.dependencies.templates[0].routePresets = { bootstrap: [
    { action: 'sniff' },
    { type: 'logical', mode: 'or', rules: [{ protocol: 'dns' }, { port: 53 }], action: 'hijack-dns' },
    { rule_set: 'local-names', action: 'resolve', server: 'local' },
  ] };
  request.recipe.routeSteps = [{ id: 'first', preset: 'bootstrap' },
    { id: 'local', rule: { ip_is_private: true, outbound: 'direct' } }, { id: 'again', preset: 'bootstrap' }];
  const before = structuredClone(request);
  const rules = (success(compileRecipe(request)).config.route as any).rules;
  assert.deepEqual(rules, [...request.dependencies.templates[0].routePresets.bootstrap, { ip_is_private: true, outbound: 'direct' }, ...request.dependencies.templates[0].routePresets.bootstrap]);
  rules[0].action = 'reject'; assert.equal(rules[4].action, 'sniff');
  assert.deepEqual(request, before);
  request.recipe.routeSteps = [request.recipe.routeSteps[1], request.recipe.routeSteps[0]];
  assert.deepEqual((success(compileRecipe(request)).config.route as any).rules, [{ ip_is_private: true, outbound: 'direct' }, ...request.dependencies.templates[0].routePresets.bootstrap]);
  request.recipe.routeSteps = [{ id: 'local', rule: { ip_is_private: true, outbound: 'direct' } }];
  assert.deepEqual((success(compileRecipe(request)).config.route as any).rules, [{ ip_is_private: true, outbound: 'direct' }]);
});

test('Route diagnostics identify stable steps, preset offsets and output positions', () => {
  const request: any = input();
  request.dependencies.templates[0].routePresets = { broken: [{ action: 'sniff' }, { outbound: 'missing' }] };
  request.recipe.routeSteps = [{ id: 'prefix', rule: { action: 'sniff' } }, { id: 'selected-policy', preset: 'broken' }];
  const diagnostic: any = compileRecipe(request).diagnostics.find(d => d.code === 'REFERENCE_MISSING');
  assert.ok(diagnostic);
  assert.equal(diagnostic.path, '/recipe/routeSteps/1/preset');
  assert.deepEqual(diagnostic.source, { stepId: 'selected-policy', stepIndex: 1, preset: 'broken', presetRuleIndex: 1, outputRuleIndex: 2, outputPath: '/route/rules/2/outbound' });
  request.recipe.routeSteps = [{ id: 'gone', preset: 'absent' }];
  const missing: any = compileRecipe(request).diagnostics[0];
  assert.equal(missing.code, 'PRESET_MISSING'); assert.equal(missing.source.stepId, 'gone');
  request.recipe.routeSteps = [{ id: 'same', rule: { action: 'sniff' } }, { id: 'same', rule: { action: 'sniff' } }];
  assert.equal(compileRecipe(request).diagnostics[0]?.code, 'STEP_ID_DUPLICATE');
});

test('implicit route terminals warn about unreachable steps and capabilities stay blocking', () => {
  const request: any = input();
  request.recipe.routeSteps = [{ id: 'catch-all', rule: { outbound: 'direct' } }, { id: 'later', rule: { domain: 'example.com', outbound: 'direct' } }];
  const warning = compileRecipe(request).diagnostics.find(d => d.code === 'RULE_UNREACHABLE');
  assert.equal(warning?.source?.stepId, 'later');
  request.recipe.profile = 'android-google-play';
  request.dependencies.templates[0].platformDnsServers['android-google-play'] = [{ type: 'local', tag: 'local' }];
  request.recipe.routeSteps = [{ id: 'process', rule: { type: 'logical', mode: 'and', rules: [{ process_name: 'example' }, { domain_suffix: 'example.com' }], outbound: 'direct' } }];
  const result = compileRecipe(request);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.find(d => d.code === 'CAPABILITY_UNSUPPORTED')?.source?.stepId, 'process');
});

test('settings generate TUN MTU and reject missing or ambiguous TUN targets', () => {
  const request: any = input();
  request.recipe.settings = { tunMtu: 1400 };
  assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'SETTING_AMBIGUOUS'));
  request.dependencies.templates[0].resources.inbounds = [{ type: 'tun', tag: 'tun', address: ['172.19.0.1/30'], mtu: 9000, auto_route: true, stack: 'mixed' }];
  assert.equal((success(compileRecipe(request)).config.inbounds as any[])[0].mtu, 1400);
  request.dependencies.templates[0].resources.inbounds.push({ type: 'tun', tag: 'other', address: ['172.20.0.1/30'] });
  assert.ok(compileRecipe(request).diagnostics.some(d => d.code === 'SETTING_AMBIGUOUS'));
});

test('outbound references, duplicate tags, group defaults and cycles use existing validation', () => {
  for (const [outbounds, code] of [
    [[{ type: 'direct', tag: 'direct' }], 'TAG_DUPLICATE'],
    [[{ type: 'selector', tag: 'group', outbounds: ['missing'] }], 'REFERENCE_MISSING'],
    [[{ type: 'selector', tag: 'group', outbounds: ['direct'], default: 'missing' }], 'GROUP_DEFAULT_INVALID'],
    [[{ type: 'selector', tag: 'group', outbounds: ['group'] }], 'OUTBOUND_CYCLE'],
    [[{ type: 'urltest', tag: 'group', outbounds: [] }], 'GROUP_EMPTY'],
  ] as const) {
    const request: any = input(); request.recipe.resources.outbounds.push(...outbounds);
    assert.equal(compileRecipe(request).ok, false);
    assert.ok(compileRecipe(request).diagnostics.some(d => d.code === code), code);
  }
});

test('new nested contracts reject arbitrary options, action-bearing headless rules and malformed steps', () => {
  const mutations = [
    (v: any) => { v.recipe.settings = { dnsFinal: {} }; },
    (v: any) => { v.recipe.settings = { tunMtu: 1 }; },
    (v: any) => { v.recipe.routeSteps = [{ id: 'both', preset: 'x', rule: { action: 'sniff' } }]; },
    (v: any) => { v.recipe.routeSteps = [{ rule: { action: 'sniff' } }]; },
    (v: any) => { v.recipe.routeSteps = [{ id: 'bad', rule: { type: 'logical', mode: 'or', rules: [{ options: {} }], action: 'reject' } }]; },
    (v: any) => { v.recipe.routeSteps = [{ id: 'bad', rule: { action: 'resolve', outbound: 'direct' } }]; },
    (v: any) => { v.recipe.resources.ruleSets = [{ kind: 'inline', definition: { type: 'inline', tag: 'bad', rules: [{ action: 'reject' }] } }]; },
    (v: any) => { v.recipe.resources.outbounds.push({ type: 'urltest', tag: 'auto', outbounds: ['direct'], options: {} }); },
    (v: any) => { v.dependencies.templates[0].routePresets = { x: [{ action: 'sniff', timeout: {} }] }; },
  ];
  for (const mutate of mutations) {
    const request = input(); mutate(request);
    assert.equal(compileRecipe(request).diagnostics[0]?.code, 'STRUCTURE_INVALID');
  }
});

test('representative existing sample Route policy survives the public Recipe path unchanged', async () => {
  const { sampleRouteInput } = await import('./route-fixtures.js');
  const { request, expectedRules } = sampleRouteInput();
  const before = structuredClone(request);
  assert.deepEqual((success(compileRecipe(request)).config.route as any).rules, expectedRules);
  assert.deepEqual(request, before);
});
