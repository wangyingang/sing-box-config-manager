import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const source = new URL('../verify.mjs', import.meta.url);

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'verify-command-'));
  try {
    await mkdir(join(root, 'scripts'));
    await cp(source, join(root, 'scripts/verify.mjs'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.33.2', engines: { node: '>=24' } }));
    await exec('git', ['init', '-q', root]);
    await exec('git', ['-C', root, 'add', '.']);
    await exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const launch = async (args, env = {}) => {
      const childEnv = { ...process.env, ...env };
      delete childEnv.NODE_TEST_CONTEXT; // This is a fresh CLI invocation, not a nested node:test worker.
      try {
        const result = await exec(process.execPath, ['scripts/verify.mjs', ...args], { cwd: root, env: childEnv });
        return { ...result, code: 0 };
      } catch (error) { return error; }
    };
    await run({ root, launch });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function pnpm(root, name, body) {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test('wrong pnpm fails before checks, saves the failure, and preserves an existing evidence directory', () => fixture(async ({ root, launch }) => {
  const launcher = await pnpm(root, 'wrong.cjs', `console.log('11.25.0');`);
  const output = join(root, 'evidence');
  const result = await launch(['--check-only', '--pnpm', launcher, '--out', output]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /10\.33\.2/);
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.steps.length, 0);
  assert.match(summary.error, /11\.25\.0/);
  const original = await readFile(join(output, 'summary.json'));
  const again = await launch(['--check-only', '--pnpm', launcher, '--out', output]);
  assert.equal(again.code, 1);
  assert.deepEqual(await readFile(join(output, 'summary.json')), original);
}));

test('an explicit pinned launcher is used by nested pnpm despite a wrong PATH version; evidence hashes match actual logs', () => fixture(async ({ root, launch }) => {
  const wrongBin = join(root, 'wrong-bin');
  await mkdir(wrongBin);
  await pnpm(wrongBin, 'pnpm', `throw new Error('Wrong PATH pnpm must never run');`);
  const launcher = await pnpm(root, 'pinned launcher.cjs', `
    const { execFileSync } = require('node:child_process');
    if (process.argv[2] === '--version') console.log('10.33.2');
    else {
      console.log('nested pnpm=' + execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim());
      console.log('nested node=' + execFileSync('node', ['--version'], { encoding: 'utf8' }).trim());
      console.log('ℹ tests 2\\nℹ pass 2\\nℹ fail 0\\nℹ skipped 0');
    }
  `);
  const output = join(root, 'evidence');
  const result = await launch(['--check-only', '--pnpm', launcher, '--out', output], { PATH: `${wrongBin}:${process.env.PATH}` });
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'passed');
  assert.equal(summary.scope, 'check-only');
  assert.deepEqual(summary.steps[0].command, [process.execPath, launcher, 'check']);
  assert.equal(summary.steps[0].suites[0].pass, 2);
  const log = await readFile(join(output, 'check.log'));
  assert.match(log.toString(), /nested pnpm=10\.33\.2/);
  assert.ok(log.toString().includes(`nested node=${process.version}`));
  const inventory = JSON.parse(await readFile(join(output, 'files.json'), 'utf8'));
  for (const file of inventory.files) {
    const bytes = await readFile(join(output, file.path));
    assert.equal(bytes.length, file.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
}));

test('PATH shims keep their pnpm invocation name instead of executing the tool manager itself', () => fixture(async ({ root, launch }) => {
  const target = await pnpm(root, 'tool-manager', `
    const name = require('node:path').basename(process.argv[1]);
    if (name !== 'pnpm') { console.log('tool-manager 2026.10'); }
    else if (process.argv[2] === '--version') console.log('10.33.2');
    else console.log('ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ skipped 0');
  `);
  const bin = join(root, 'bin'); await mkdir(bin);
  await symlink(target, join(bin, 'pnpm'));
  const output = join(root, 'evidence');
  const result = await launch(['--check-only', '--out', output], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.tools.pnpm.actual, '10.33.2');
  assert.equal(summary.status, 'passed');
}));

async function binaryFixture(root, version = '1.14.4') {
  await mkdir(join(root, 'packages/config-compiler/schemas'), { recursive: true });
  await writeFile(join(root, 'packages/config-compiler/schemas/build.json'), JSON.stringify({ version: '1.14.4' }));
  return pnpm(root, 'sing-box', `console.log('sing-box version ${version}');`);
}

test('a failing check retains stdout, stderr and exit code and never starts integration', () => fixture(async ({ root, launch }) => {
  const launcher = await pnpm(root, 'failure.cjs', `
    if (process.argv[2] === '--version') console.log('10.33.2');
    else { require('node:fs').appendFileSync('calls.txt', process.argv[2] + '\\n'); console.log('failed check output'); console.error('diagnostic detail'); process.exitCode = 7; }
  `);
  const output = join(root, 'evidence');
  const result = await launch(['--binary', await binaryFixture(root), '--pnpm', launcher, '--out', output]);
  assert.equal(result.code, 1);
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.steps.length, 1);
  assert.equal(summary.steps[0].exitCode, 7);
  const log = await readFile(join(output, 'check.log'), 'utf8');
  assert.match(log, /failed check output/); assert.match(log, /diagnostic detail/);
  assert.equal(await readFile(join(root, 'calls.txt'), 'utf8'), 'check\n');
}));

test('wrong binary version fails before running check', () => fixture(async ({ root, launch }) => {
  const launcher = await pnpm(root, 'pinned.cjs', `console.log('10.33.2');`);
  const output = join(root, 'evidence');
  const result = await launch(['--pnpm', launcher, '--out', output, '--binary', await binaryFixture(root, '1.13.0')]);
  assert.equal(result.code, 1);
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.steps.length, 0);
  assert.match(summary.error, /Expected sing-box 1\.14\.4/);
}));

test('preflight process failures preserve launcher identity, original exit code and stderr without running checks', () => fixture(async ({ root, launch }) => {
  const goodPnpm = await pnpm(root, 'pinned.cjs', `console.log('10.33.2');`);
  const failedPnpm = await pnpm(root, 'broken.cjs', `console.error('pnpm failed before version'); process.exitCode = 7;`);
  const failedBinary = await binaryFixture(root);
  await writeFile(failedBinary, `#!/usr/bin/env node\nconsole.error('binary failed before version'); process.exitCode = 9;\n`);
  for (const [name, args, code, tool] of [
    ['pnpm-version', ['--check-only', '--pnpm', failedPnpm], 7, 'pnpm'],
    ['sing-box-version', ['--pnpm', goodPnpm, '--binary', failedBinary], 9, 'singBox'],
  ]) {
    const output = join(root, name);
    const result = await launch([...args, '--out', output]);
    assert.equal(result.code, 1);
    const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
    assert.equal(summary.status, 'failed');
    assert.equal(summary.steps.length, 0);
    assert.ok(summary.tools[tool]);
    const record = summary.preflight.at(-1);
    assert.equal(record.exitCode, code);
    assert.equal(record.command.at(-1), name === 'pnpm-version' ? '--version' : 'version');
    const bytes = await readFile(join(output, record.log));
    assert.match(bytes.toString(), /failed before version/);
    assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
}));

test('full verification runs ordered checks, captures separate suites and client evidence, and selects only the read-only Release test', () => fixture(async ({ root, launch }) => {
  const launcher = await pnpm(root, 'pinned.cjs', `
    const fs = require('node:fs');
    if (process.argv[2] === '--version') console.log('10.33.2');
    else {
      fs.appendFileSync('calls.txt', process.argv[2] + '\\n');
      if (!['check', 'test:integration'].includes(process.argv[2])) throw new Error('Unexpected pnpm command');
      if (process.argv[2] === 'test:integration') {
        fs.writeFileSync(process.env.RULE_ACTIVATION_CLIENT_EVIDENCE, '{"update":"fixture"}');
        fs.writeFileSync(process.env.RULE_CLIENT_FAILURE_EVIDENCE, '{"cache":"fixture"}');
      }
      console.log('compiler: # tests 2\\ncompiler: # pass 2\\ncompiler: # fail 0\\ncompiler: # skipped 0');
      console.log('pipeline: ℹ tests 3\\npipeline: ℹ pass 3\\npipeline: ℹ fail 0\\npipeline: ℹ skipped 0');
    }
  `);
  const binary = await binaryFixture(root);
  await mkdir(join(root, 'node_modules/tsx'), { recursive: true });
  await writeFile(join(root, 'node_modules/tsx/package.json'), '{"name":"tsx","type":"module","exports":"./index.mjs"}');
  await writeFile(join(root, 'node_modules/tsx/index.mjs'), '');
  const acceptance = join(root, 'packages/rule-set-pipeline/test/acceptance');
  await mkdir(acceptance, { recursive: true });
  await writeFile(join(acceptance, 'release.test.ts'), `import test from 'node:test'; test('fixed Release fixture', () => {});`);
  // A wildcard acceptance command would execute this opt-in remote-write sentinel and fail.
  await writeFile(join(acceptance, 'publication.test.ts'), `throw new Error('Publication must not execute');`);
  const output = join(root, 'evidence');
  const outside = join(root, 'other-task.json');
  const result = await launch(['--pnpm', launcher, '--binary', binary, '--out', output, '--release'], {
    RULE_ACTIVATION_CLIENT_EVIDENCE: outside, RULE_CLIENT_FAILURE_EVIDENCE: outside,
    RULE_PUBLICATION_STATE: root, RULE_PUBLICATION_EVIDENCE: outside,
  });
  assert.equal(result.code, 0, result.stderr + await readFile(join(output, 'release.log'), 'utf8').catch(() => ''));
  assert.equal(await readFile(join(root, 'calls.txt'), 'utf8'), 'check\ntest:integration\n');
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'passed');
  assert.equal(summary.scope, 'check-native-release');
  assert.deepEqual(summary.steps.map(step => step.name), ['check', 'integration', 'release']);
  assert.deepEqual(summary.steps[0].suites.map(suite => suite.pass), [2, 3]);
  assert.equal(summary.steps[2].suites[0].pass, 1);
  await assert.rejects(readFile(outside), { code: 'ENOENT' });
  const files = JSON.parse(await readFile(join(output, 'files.json'), 'utf8')).files;
  assert.ok(files.some(file => file.path === 'client-update-rollback.json'));
  assert.ok(files.some(file => file.path === 'client-failure-cache.json'));
}));

test('a zero exit with skipped or missing tests is never reported as complete', () => fixture(async ({ root, launch }) => {
  for (const [name, report] of [['skips', '# tests 2\\n# pass 1\\n# fail 0\\n# skipped 1'], ['missing', 'no tests executed']]) {
    const launcher = await pnpm(root, `${name}.cjs`, `console.log(process.argv[2] === '--version' ? '10.33.2' : '${report}');`);
    const output = join(root, name);
    const result = await launch(['--check-only', '--pnpm', launcher, '--out', output]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(await readFile(join(output, 'summary.json'), 'utf8')).status, 'failed');
  }
}));

test('interrupted verification stops its command and preserves a failed evidence bundle', { timeout: 15_000 }, () => fixture(async ({ root }) => {
  const launcher = await pnpm(root, 'waiting.cjs', `
    if (process.argv[2] === '--version') console.log('10.33.2');
    else { console.log('check started'); require('node:fs').writeFileSync('ready', 'yes'); setInterval(() => {}, 1000); }
  `);
  const output = join(root, 'evidence');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['scripts/verify.mjs', '--check-only', '--pnpm', launcher, '--out', output], { cwd: root, env, stdio: 'ignore' });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  try {
    let ready = false;
    const deadline = Date.now() + 5000;
    while (!ready && Date.now() < deadline) {
      ready = await readFile(join(root, 'ready')).then(() => true, () => false);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true);
    child.kill('SIGTERM');
    assert.equal(await finished, 1);
    const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
    assert.equal(summary.status, 'failed');
    assert.equal(summary.steps[0].interrupted, 'SIGTERM');
    assert.match(await readFile(join(output, 'check.log'), 'utf8'), /check started/);
    assert.ok(JSON.parse(await readFile(join(output, 'files.json'), 'utf8')).files.some(file => file.path === 'check.log'));
  } finally { child.kill('SIGKILL'); await finished; }
}));
