import { test } from 'node:test';
import { compileRecipe } from '../../src/index.js';
import { createSingBoxChecker } from '../../src/publisher.js';
import { input, recipe, node } from '../recipe-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);
test('Recipe configurations with shared synthetic nodes pass real 1.14.4 check', async () => {
  for (const document of [recipe(), recipe('bob', 'bob-proxy')]) {
    for (const connection of [node.connection,
      { type: 'hysteria2', server: '192.0.2.1', server_port: 443, password: 'synthetic', tls: { enabled: true, server_name: 'example.invalid' } },
      { type: 'shadowsocks', server: '192.0.2.1', server_port: 443, method: 'aes-256-gcm', password: 'synthetic' },
      { ...node.connection, transport: { type: 'ws', path: '/synthetic', headers: { Host: 'example.invalid' } } },
    ]) {
      for (const ecs of [null, { address: '8.8.8.8', prefix: 24 }]) {
        const request = input(document);
        await checker(success(compileRecipe({ ...request, dependencies: { ...request.dependencies, nodes: [{ ...node, connection }] }, params: { ecs } })).config);
      }
    }
  }
});
