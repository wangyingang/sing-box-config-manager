import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../../packages/rule-set-pipeline/src/configuration.ts';
import { syncRules } from '../../../packages/rule-set-pipeline/src/rules-operations.ts';
import { rulesEnvironment } from '../../../packages/rule-set-pipeline/test/fixtures/rules-environment.ts';

assert.ok(isAbsolute(process.env.SING_BOX_TEST_BINARY ?? ''), 'Supply the absolute path to sing-box 1.14.4');

function executable(revision) {
  return `#!/bin/sh
# revision ${revision}
if [ "$1" = version ]; then
  if [ -f "$0.wrong-version" ]; then echo 'sing-box version 1.14.3'; exit 0; fi
  if [ -f "$0.failure" ]; then echo 'version probe failed' >&2; exit 7; fi
fi
exec "$SING_BOX_TEST_BINARY" "$@"
`;
}
const initial = executable('A');
const replacement = executable('B');
const sha256 = contents => createHash('sha256').update(contents).digest('hex');
const timestamp = new Date('2026-01-01T00:00:00Z');

async function setup(t, withSymlink = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rules-tool-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original');
  const binary = withSymlink ? join(directory, 'current') : original;
  await writeFile(original, initial, { mode: 0o700 });
  await utimes(original, timestamp, timestamp);
  if (withSymlink) await symlink(original, binary);
  const { context, configure } = rulesEnvironment(binary, 'main');
  const config = parseBuildConfiguration(readOfficialConfiguration());
  config.ruleSets = config.ruleSets.filter(rule => ['openai', 'china-ip'].includes(rule.id));
  configure(config);
  const first = await syncRules({ context });
  assert.equal(first.status, 'success', JSON.stringify(first));
  assert.deepEqual(first.results.map(row => [row.id, row.status]), [['openai', 'delivered'], ['china-ip', 'delivered']]);
  return { context, original, binary, first };
}

// The fixture resolves the Git source after the Release rule has finished checking its own tool.
async function switchBeforeGitRule(context, change) {
  const fetch = context.fetch;
  let switched = false;
  context.fetch = async (url, init) => {
    if (!switched && String(url) === 'https://api.github.com/repos/gaoyifan/china-operator-ip/branches/ip-lists') {
      switched = true;
      await change();
    }
    return fetch(url, init);
  };
  try {
    const result = await syncRules({ context });
    assert.ok(switched, 'The second source was reached');
    assert.equal(result.results[0].id, 'openai');
    assert.equal(result.results[0].status, 'unchanged', JSON.stringify(result));
    assert.ok(result.results[0].verified.includes('source-identity'));
    assert.equal(result.results[1].id, 'china-ip');
    return result;
  } finally { context.fetch = fetch; }
}

for (const change of ['equal-length overwrite', 'symlink retarget']) {
  test(change + ' between two rules records the actual tool in each delivery', async t => {
    const { context, original, binary, first } = await setup(t, change === 'symlink retarget');
    const changed = await switchBeforeGitRule(context, async () => {
      if (change === 'symlink retarget') {
        const other = original + '-B';
        await writeFile(other, replacement, { mode: 0o700 });
        await symlink(other, binary + '-next');
        await rename(binary + '-next', binary);
      } else {
        const before = await stat(original, { bigint: true });
        await writeFile(original, replacement);
        await utimes(original, timestamp, timestamp);
        const after = await stat(original, { bigint: true });
        assert.deepEqual([after.ino, after.size, after.mtimeNs], [before.ino, before.size, before.mtimeNs]);
      }
    });
    assert.equal(changed.status, 'success', JSON.stringify(changed));
    const [openai, china] = changed.results;
    assert.equal(openai.current.candidateId, first.results[0].current.candidateId);
    assert.equal(openai.successfulInput.toolSha256, sha256(initial));
    assert.equal(china.status, 'delivered');
    assert.equal(china.successfulInput.toolSha256, sha256(replacement));
    assert.notEqual(china.current.candidateId, first.results[1].current.candidateId);
    assert.deepEqual(china.current.files, first.results[1].current.files);
    const next = await syncRules({ context });
    assert.equal(next.status, 'success', JSON.stringify(next));
    assert.deepEqual(next.results.map(row => row.status), ['delivered', 'unchanged']);
    assert.ok(next.results.every(row => row.successfulInput.toolSha256 === sha256(replacement)));
  });
}

for (const [fault, message] of [['wrong-version', /Expected sing-box 1\.14\.4/], ['failure', /version probe failed/]]) {
  test(fault + ' with identical executable bytes preserves the delivery and permits retry', async t => {
    const { context, original, first } = await setup(t);
    const flag = original + '.' + fault;
    const failed = await switchBeforeGitRule(context, () => writeFile(flag, ''));
    assert.equal(failed.status, 'partial', JSON.stringify(failed));
    const result = failed.results[1];
    assert.equal(result.status, 'failed');
    assert.match(result.error, message);
    assert.deepEqual(result.current, first.results[1].current);
    await rm(flag);
    const retry = await syncRules({ context });
    assert.equal(retry.status, 'success', JSON.stringify(retry));
    assert.deepEqual(retry.results.map(row => row.status), ['unchanged', 'unchanged']);
    assert.deepEqual(retry.results.map(row => row.current), first.results.map(row => row.current));
  });
}
