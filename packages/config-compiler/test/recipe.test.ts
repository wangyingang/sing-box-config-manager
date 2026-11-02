import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, type RecipeDocument, type TemplateDocument, type NodeRevision } from '../src/index.js';
import { success } from './helpers.js';

import { template, node, recipe, input } from './recipe-fixtures.js';

test('two Recipes share a fixed NodeRevision with independent local tags and upgrades', () => {
  const a = input(); const b = input(recipe('bob', 'bob-proxy')); const before = structuredClone(a);
  const first = success(compileRecipe(a));
  assert.deepEqual(first.config.outbounds, [{ type: 'direct', tag: 'direct' }, { ...node.connection, tag: 'alice-proxy' }]);
  assert.deepEqual(success(compileRecipe(b)).config.outbounds, [{ type: 'direct', tag: 'direct' }, { ...node.connection, tag: 'bob-proxy' }]);
  a.dependencies.nodes.push({ ...node, revision: '2', connection: { ...node.connection, server: '192.0.2.2' } });
  assert.deepEqual(success(compileRecipe(a)), first);
  a.recipe.revision = '2'; a.recipe.resources.outbounds![0]!.nodeRef.revision = '2';
  assert.equal((success(compileRecipe(a)).config.outbounds as { server?: string }[])[1]!.server, '192.0.2.2');
  assert.equal((success(compileRecipe(b)).config.outbounds as { server?: string }[])[1]!.server, '192.0.2.1');
  assert.deepEqual(b.dependencies.nodes, before.dependencies.nodes);
});

test('missing exact revisions fail without latest fallback, duplicates are ambiguous', () => {
  for (const dependency of ['nodes', 'templates'] as const) {
    const request = input(); request.dependencies[dependency][0]!.revision = '2';
    const result = compileRecipe(request);
    assert.equal(result.ok, false); assert.equal(result.diagnostics[0]!.code, 'DEPENDENCY_MISSING');
    assert.match(result.diagnostics[0]!.path, dependency === 'nodes' ? /nodeRef$/ : /templateRef$/);
  }
  const request = input(); request.dependencies.nodes.push(node);
  assert.equal(compileRecipe(request).diagnostics[0]!.code, 'DEPENDENCY_DUPLICATE');
});

test('closed schemas reject unknown nested fields, paths, policy shapes and Profile overrides', () => {
  const mutations = [
    (v: any) => { v.profile = 'ios-appstore'; },
    (v: any) => { v.recipe.profile = 'linux'; },
    (v: any) => { delete v.recipe.schemaVersion; },
    (v: any) => { v.recipe.resources.outbounds[0].options = {}; },
    (v: any) => { v.dependencies.nodes[0].connection.tls.certificate_path = '/tmp/private'; },
    (v: any) => { v.dependencies.nodes[0].connection.tls.utls = { enabled: 'yes' }; },
    (v: any) => { v.dependencies.nodes[0].connection.transport = { type: 'ws', headers: { Unknown: 'secret' } }; },
    (v: any) => { v.dependencies.templates[0].defaults.route.rules = []; },
    (v: any) => { v.dependencies.templates[0].resources.ruleSets = [{ path: '/tmp/rules' }]; },
    (v: any) => { v.recipe.dnsSteps = [{ preset: 'future' }]; },
    (v: any) => { v.recipe.settings = null; },
    (v: any) => { v.dependencies.nodes[0].connection.server_port = 65536; },
  ];
  for (const mutate of mutations) {
    const request = input(); mutate(request);
    const result = compileRecipe(request);
    assert.equal(result.ok, false); assert.equal(result.diagnostics[0]!.code, 'STRUCTURE_INVALID');
    assert.ok(!JSON.stringify(result.diagnostics).includes('secret'));
  }
});

test('all sample node connection forms pass the public contract without sharing credentials in diagnostics', () => {
  const connections = [
    { ...node.connection, transport: { type: 'ws', path: '/synthetic', headers: { Host: 'example.invalid' } } },
    { ...node.connection, flow: 'xtls-rprx-vision', tls: { enabled: true, reality: { enabled: true, public_key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', short_id: '0123456789abcdef' }, utls: { enabled: true, fingerprint: 'chrome' } } },
    { type: 'hysteria2', server: '192.0.2.1', server_port: 443, password: 'synthetic', tls: { enabled: true, server_name: 'example.invalid' } },
    { type: 'shadowsocks', server: '192.0.2.1', server_port: 443, method: 'aes-256-gcm', password: 'synthetic' },
  ];
  for (const connection of connections) {
    const request = { ...input(), dependencies: { templates: [template], nodes: [{ ...node, connection }] } };
    success(compileRecipe(request));
  }
});

test('resolution and compilation are deterministic and own their output', () => {
  const request = input(); const before = structuredClone(request);
  const a = success(compileRecipe(request)); const b = success(compileRecipe(request));
  assert.deepEqual(a, b); (a.config.outbounds as any[])[1].server = 'modified';
  assert.deepEqual(success(compileRecipe(request)), b); assert.deepEqual(request, before);
});
