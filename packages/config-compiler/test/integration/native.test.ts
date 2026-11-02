import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compile, inspectComposition, preparePublication } from '../../src/index.js';
import { createSingBoxChecker, publish, readPublication } from '../../src/publisher.js';
import { fixture, manifest } from '../fixtures.js';
import { success } from '../helpers.js';
import { normalize } from '../normalize.js';

// Explicit integration target: fail rather than silently skip when the binary is absent.
const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const executable = resolve(binary);
const checker = createSingBoxChecker(executable);

for (const entry of manifest.cases) {
  test(`${entry.id}: live official merge oracle and native check of both ECS variants`, async () => {
    const { input, golden, fragments } = fixture(entry.id);
    const directory = await mkdtemp(join(tmpdir(), 'd06-native-'));
    try {
      const args = ['merge', join(directory, 'legacy.json')];
      for (const [name, document] of Object.entries(fragments)) {
        const path = join(directory, name);
        await writeFile(path, JSON.stringify(document), { mode: 0o600 }); args.push('-c', path);
      }
      execFileSync(executable, args, { cwd: directory, stdio: 'pipe', timeout: 30_000 });
      const actualGolden = JSON.parse(await readFile(join(directory, 'legacy.json'), 'utf8'));
      assert.deepEqual(actualGolden, golden);
      const inspected = inspectComposition(input);
      assert.ok(inspected.candidate);
      const compiled = inspected.candidate;
      assert.deepEqual(normalize(compiled.config), normalize(actualGolden));
      await checker(compiled.config);
      const disabled = inspectComposition({ ...input, params: { ecs: null } });
      assert.ok(disabled.candidate);
      await checker(disabled.candidate.config);
      if (entry.profile === 'android-google-play') {
        assert.equal(compile(input).ok, false);
        const prepared = await preparePublication(input, checker);
        assert.equal(prepared.ok, false);
        assert.ok(prepared.diagnostics.every(d => d.code === 'CAPABILITY_UNSUPPORTED'));
      } else {
        const prepared = await preparePublication(input, checker);
        assert.ok(prepared.ok, JSON.stringify(prepared.diagnostics));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('native check alone misses outbound references; Composer rejects them', async () => {
  await checker({ outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'selector', tag: 'group', outbounds: ['missing'] }], route: { final: 'missing' } });
  const { input } = fixture(); input.recipe.settings = { routeFinal: 'missing' };
  assert.equal(compile(input).ok, false);
});

test('local publish and a failing binary leave the active version intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd06-native-publish-'));
  try {
    const original = success(await publish(fixture().input, { binary: executable, directory }));
    const result = await publish(fixture().input, { binary: join(directory, 'does-not-exist'), directory });
    assert.equal(result.ok, false);
    assert.equal((await readPublication(directory)).id, original.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
