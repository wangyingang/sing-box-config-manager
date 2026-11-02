import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileRecipe, resolveRecipe, preparePublication, renderSubscription } from '../../src/index.js';
import { createSingBoxChecker } from '../../src/publisher.js';
import { responseInput } from '../artifact-fixtures.js';
import { success } from '../helpers.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const checker = createSingBoxChecker(binary);

test('fixed source/binary artifacts pass real 1.14.4 publication checks for both ECS variants', async () => {
  const request = responseInput();
  request.dependencies.templates[0]!.ecsResponseTags = ['first'];
  request.params.ecs = { address: '8.8.8.8', prefix: 24 };
  let checks = 0;
  const publication = success(await preparePublication(success(resolveRecipe(request)), async config => {
    // Native check validates configuration; it does not verify or fetch these remote files.
    await checker(config); checks++;
  }));
  assert.equal(checks, 2);
  assert.deepEqual(success(await renderSubscription(publication, request.params)), success(compileRecipe(request)).config);
  request.params.ecs = null;
  assert.deepEqual(success(await renderSubscription(publication, request.params)), success(compileRecipe(request)).config);
});

test('Manifest sourceFormatVersion 4 is supported by real 1.14.4 source/binary round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-contract-'));
  const source = { version: 4, rules: [{ domain_suffix: ['example.test'] }, { ip_cidr: ['192.0.2.0/24'] }] };
  try {
    const json = join(directory, 'source.json'), srs = join(directory, 'rules.srs'), decoded = join(directory, 'decoded.json');
    await writeFile(json, JSON.stringify(source));
    execFileSync(binary, ['rule-set', 'compile', json, '-o', srs], { stdio: 'pipe', timeout: 30_000 });
    execFileSync(binary, ['rule-set', 'decompile', srs, '-o', decoded], { stdio: 'pipe', timeout: 30_000 });
    // Decompile emits the minimum required source version and collapses singleton arrays.
    assert.deepEqual(JSON.parse(await readFile(decoded, 'utf8')), {
      version: 2, rules: [{ domain_suffix: 'example.test' }, { ip_cidr: '192.0.2.0/24' }],
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
