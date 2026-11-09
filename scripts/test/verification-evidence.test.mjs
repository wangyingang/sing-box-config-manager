import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectEvidence } from '../lib/verification-evidence.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../inspect-evidence.mjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const log = '# tests 3\n# pass 3\n# fail 0\n# skipped 0\n';
const file = (path, bytes) => ({ path, byteLength: Buffer.byteLength(bytes), sha256: sha256(bytes) });
const step = (name, bytes, tests = 3) => ({ name, exitCode: 0, signal: null, log: `${name}.log`, byteLength: Buffer.byteLength(bytes), sha256: sha256(bytes),
  suites: [{ name: 'node:test', tests, pass: tests, fail: 0, skipped: 0 }] });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'inspect-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'evidence');
  await mkdir(directory);
  const summary = { schemaVersion: 1, status: 'passed', scope: 'check-only',
    source: { commit: 'a'.repeat(40), clean: true, status: '', trackedDiffSha256: sha256('') },
    tools: { node: { version: 'v24.22.1', executable: '/usr/bin/node' } }, preflight: [], steps: [step('check', log)] };
  const payloads = { 'check.log': log };
  const save = async () => {
    for (const [name, bytes] of Object.entries(payloads)) await writeFile(join(directory, name), bytes);
    const bytes = JSON.stringify(summary, null, 2) + '\n';
    await writeFile(join(directory, 'summary.json'), bytes);
    await writeFile(join(directory, 'files.json'), JSON.stringify({ schemaVersion: 1, files: [file('summary.json', bytes),
      ...Object.entries(payloads).map(([name, content]) => file(name, content))] }));
  };
  await save();
  const inventory = async mutate => {
    const path = join(directory, 'files.json'), value = JSON.parse(await readFile(path)); mutate(value);
    await writeFile(path, JSON.stringify(value));
  };
  return { root, directory, summary, payloads, save, inventory };
}

test('reads a complete bundle without changing its files and preserves source, scope and per-step counts', async t => {
  const f = await fixture(t);
  f.summary.scope = 'check-native-release';
  f.summary.steps.push(step('integration', log, 7), step('release', log, 2));
  f.payloads['integration.log'] = log; f.payloads['release.log'] = log;
  f.summary.preflight.push({ ...step('pnpm-version', ''), suites: [], stdout: { log: 'version.stdout.log', ...file('unused', '10.33.2\n') } });
  f.payloads['pnpm-version.log'] = ''; f.payloads['version.stdout.log'] = '10.33.2\n';
  await f.save();
  const before = await Promise.all((await readdir(f.directory)).sort().map(async name => [name, await readFile(join(f.directory, name))]));
  const report = await inspectEvidence(f.directory);
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.equal(report.integrityStatus, 'passed');
  assert.equal(report.verificationStatus, 'passed');
  assert.deepEqual(report.source, f.summary.source);
  assert.equal(report.scope, 'check-native-release');
  assert.deepEqual(report.steps.map(step => [step.name, step.tests, step.pass, step.skipped]), [['check', 3, 3, 0], ['integration', 7, 7, 0], ['release', 2, 2, 0]]);
  assert.deepEqual(report.files, { total: 6, checked: 6, failures: [] });
  const after = await Promise.all((await readdir(f.directory)).sort().map(async name => [name, await readFile(join(f.directory, name))]));
  assert.deepEqual(after, before);
});

for (const [name, mutate] of [
  ['invalid JSON', async f => writeFile(join(f.directory, 'files.json'), '{broken')],
  ['scalar inventory', f => f.inventory(value => { value.files = 4; })],
  ['duplicate inventory entry', f => f.inventory(value => { value.files.push(value.files[0]); })],
  ['inventory without summary', f => f.inventory(value => { value.files.shift(); })],
  ['extra unlisted file', f => writeFile(join(f.directory, 'extra.log'), 'unlisted')],
  ['missing file', f => rm(join(f.directory, 'check.log'))],
  ['changed file', f => writeFile(join(f.directory, 'check.log'), 'tampered')],
  ['wrong manifest byte length', f => f.inventory(value => { value.files[1].byteLength++; })],
  ['wrong step hash with valid inventory', async f => { f.summary.steps[0].sha256 = '0'.repeat(64); await f.save(); }],
  ['scalar steps', async f => { f.summary.steps = 2; await f.save(); }],
  ['scalar suites', async f => { f.summary.steps[0].suites = 2; await f.save(); }],
  ['invalid source', async f => { f.summary.source.clean = 'true'; await f.save(); }],
  ['passing result with missing scope step', async f => { f.summary.scope = 'check-native'; await f.save(); }],
  ['passing result with skips', async f => { f.summary.steps[0].suites[0].skipped = 1; await f.save(); }],
  ['non-integer counts', async f => { f.summary.steps[0].suites[0].tests = '3'; await f.save(); }],
]) {
  test(`rejects ${name}`, async t => {
    const f = await fixture(t); await mutate(f);
    const report = await inspectEvidence(f.directory);
    assert.equal(report.status, 'failed');
    assert.equal(report.integrityStatus, 'failed');
    assert.ok(report.errors.length > 0, JSON.stringify(report));
  });
}

test('preserves an authentic failed verification separately from integrity errors', async t => {
  const f = await fixture(t);
  f.summary.status = 'failed'; f.summary.error = 'check failed (7); see check.log';
  f.summary.steps[0].exitCode = 7; f.summary.steps[0].suites = [];
  await f.save();
  const report = await inspectEvidence(f.directory);
  assert.equal(report.status, 'failed');
  assert.equal(report.integrityStatus, 'passed');
  assert.equal(report.verificationStatus, 'failed');
  assert.equal(report.verificationError, f.summary.error);
  assert.equal(report.steps[0].exitCode, 7);
  assert.deepEqual(report.errors, []);
});

test('preserves a preflight failure before tests started and never describes it as passed', async t => {
  const f = await fixture(t);
  f.summary.status = 'failed'; f.summary.error = 'unsupported tool'; f.summary.steps = [];
  await f.save();
  const report = await inspectEvidence(f.directory);
  assert.equal(report.status, 'failed');
  assert.equal(report.integrityStatus, 'passed');
  assert.deepEqual(report.steps, []);
});

test('rejects traversal, absolute and nested inventory paths without reading them', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'secret'); await writeFile(outside, 'must not be read');
  for (const path of ['../secret', outside, 'sub/check.log', 'sub\\check.log']) {
    await f.save(); await f.inventory(value => { value.files[1].path = path; });
    const report = await inspectEvidence(f.directory);
    assert.equal(report.status, 'failed');
    assert.equal(report.files.checked, 0);
    assert.match(report.errors.join('\n'), /文件名/);
  }
});

test('rejects symlinked roots, control files and payloads', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias'); await symlink(f.directory, alias);
  assert.equal((await inspectEvidence(alias)).status, 'failed');
  for (const name of ['summary.json', 'files.json', 'check.log']) {
    const path = join(f.directory, name), backup = join(f.root, `${name}.backup`);
    await writeFile(backup, await readFile(path)); await rm(path); await symlink(backup, path);
    const report = await inspectEvidence(f.directory);
    assert.equal(report.status, 'failed', name);
    assert.equal(report.integrityStatus, 'failed');
    await rm(path); await writeFile(path, await readFile(backup));
  }
});

async function cli(args) {
  try { return { ...await exec(process.execPath, [script, ...args]), code: 0 }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

test('CLI saves each run separately, emits bounded output and refuses to overwrite', async t => {
  const a = await fixture(t), b = await fixture(t);
  b.summary.source.commit = 'b'.repeat(40); b.summary.status = 'failed'; b.summary.error = 'failure'; b.summary.steps[0].exitCode = 1;
  await b.save();
  const output = join(a.root, 'report');
  const args = ['--evidence', a.directory, '--evidence', b.directory, '--out', output];
  const result = await cli(args);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.ok(result.stdout.length < 500);
  const bytes = await readFile(join(output, 'report.json')), report = JSON.parse(bytes);
  assert.equal(report.status, 'failed');
  assert.equal(report.evidence.length, 2);
  assert.deepEqual(report.evidence.map(value => value.source.commit), ['a'.repeat(40), 'b'.repeat(40)]);
  assert.equal(Object.hasOwn(report, 'tests'), false);
  const repeated = await cli(args);
  assert.equal(repeated.code, 1); assert.match(repeated.stderr, /已存在/);
  assert.deepEqual(await readFile(join(output, 'report.json')), bytes);
});

test('CLI help, invalid arguments and evidence-contained output do not modify evidence', async t => {
  const f = await fixture(t);
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /--evidence/);
  assert.equal((await cli([])).code, 1);
  const contained = await cli(['--evidence', f.directory, '--out', join(f.directory, 'report')]);
  assert.equal(contained.code, 1); assert.match(contained.stderr, /不能位于/);
  const duplicate = await cli(['--evidence', f.directory, '--evidence', f.directory, '--out', join(f.root, 'report')]);
  assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /不能重复/);
  assert.equal((await inspectEvidence(f.directory)).status, 'passed');
});
