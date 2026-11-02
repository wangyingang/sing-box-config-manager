import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRecipe, resolveRecipe, validateRecipeDraft } from '../src/index.js';
import type { Obj } from '../src/index.js';
import { success } from './helpers.js';
import { migrationInput } from './migration-fixtures.js';

test('migrated Template cache, API dashboard and fixed HTTP client settings reach the generated configuration', () => {
  const request = migrationInput();
  const template = request.dependencies.templates[0]!;
  template.resources.httpClients![0]!.version = 2;
  const config = success(compileRecipe(request)).config;
  assert.deepEqual(config.experimental, { cache_file: { enabled: true, store_dns: true } });
  assert.equal((config.route as Obj).default_http_client, 'rule-set-download');
  const api = (config.services as Obj[])[0]!;
  assert.equal(api.type, 'api');
  assert.equal(api.secret, '');
  assert.deepEqual(api.dashboard, { enabled: true, path: 'dashboard', http_client: 'rule-set-download' });
  assert.equal((config.http_clients as Obj[])[0]!.version, 2);
  template.resources.services![0]!.secret = 'synthetic-test-secret';
  assert.equal((success(compileRecipe(request)).config.services as Obj[])[0]!.secret, 'synthetic-test-secret');
});

test('new Template fields retain closed nested objects and reject wrongly typed configuration data', () => {
  const mutations: ((template: any) => void)[] = [
    t => { t.defaults.experimental.cache_file.path = '/tmp/hidden-cache'; },
    t => { t.resources.services[0].dashboard.download_url = 'https://example.invalid/unchecked'; },
    t => { t.resources.services[0].listen_port = '9090'; },
    t => { t.defaults.experimental.cache_file.store_dns = 'true'; },
    t => { t.defaults.route.default_http_client = { tag: 'rule-set-download' }; },
    t => { t.resources.services[0].secret = null; },
    t => { t.resources.httpClients[0].version = '2'; },
    t => { t.resources.httpClients[0].version = 4; },
  ];
  for (const mutate of mutations) {
    const request = migrationInput();
    mutate(request.dependencies.templates[0]!);
    const result = resolveRecipe(request);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(d => d.code === 'STRUCTURE_INVALID'), JSON.stringify(result.diagnostics));
  }
});

test('Template-only API and cache settings cannot be introduced through Recipe resources or settings', () => {
  for (const mutate of [
    (recipe: any) => { recipe.resources.services = [{ type: 'api', tag: 'injected', listen: '127.0.0.1', listen_port: 9091 }]; },
    (recipe: any) => { recipe.settings = { experimental: { cache_file: { enabled: false } } }; },
    (recipe: any) => { recipe.resources.experimental = { cache_file: { enabled: false } }; },
  ]) {
    const request = migrationInput();
    mutate(request.recipe);
    assert.equal(validateRecipeDraft(request.recipe).ok, false);
    const result = compileRecipe(request);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(d => d.code === 'STRUCTURE_INVALID'));
  }
});
