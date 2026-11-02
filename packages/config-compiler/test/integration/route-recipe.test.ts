import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe, preparePublication, resolveRecipe } from '../../src/index.js';
import { createSingBoxChecker } from '../../src/publisher.js';
import { input } from '../recipe-fixtures.js';
import { sampleRouteInput } from '../route-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);

test('synthetic Route actions, outbound groups and sample policy pass both native publication checks', async () => {
  const synthetic = input();
  synthetic.recipe.resources.outbounds!.push(
    { type: 'urltest', tag: 'auto', outbounds: ['alice-proxy'], url: 'https://example.com', interval: '3m', tolerance: 50, idle_timeout: '30m', interrupt_exist_connections: true },
    { type: 'selector', tag: 'proxy', outbounds: ['auto', 'direct'], default: 'auto', interrupt_exist_connections: true },
  );
  synthetic.dependencies.templates[0]!.resources.inbounds = [{ type: 'tun', tag: 'tun', address: ['172.19.0.1/30'], auto_route: true, stack: 'mixed' }];
  synthetic.recipe.settings = { routeFinal: 'proxy', logLevel: 'warn', tunMtu: 1400, dnsFinal: 'local' };
  synthetic.recipe.routeSteps = [
    { id: 'sniff', rule: { action: 'sniff', sniffer: ['tls', 'http'], timeout: '300ms' } },
    { id: 'dns', rule: { type: 'logical', mode: 'or', rules: [{ protocol: 'dns' }, { port: 53 }], action: 'hijack-dns' } },
    { id: 'resolve', rule: { domain_suffix: 'example.com', action: 'resolve', server: 'local', strategy: 'ipv4_only' } },
    { id: 'reject', rule: { ip_version: 6, action: 'reject', method: 'drop' } },
    { id: 'route', rule: { ip_is_private: true, action: 'route', outbound: 'direct' } },
  ];
  for (const request of [synthetic, sampleRouteInput().request]) {
    const before = structuredClone(request);
    success(compileRecipe(request));
    let checks = 0;
    success(await preparePublication(success(resolveRecipe(request)), async config => { checks++; await checker(config); }));
    assert.equal(checks, 2);
    assert.deepEqual(request, before);
  }
});
