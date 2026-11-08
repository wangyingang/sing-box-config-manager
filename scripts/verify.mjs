import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function launcherPath(value) {
  // Keep invocation names: mise/asdf-style shims dispatch by argv[0].
  if (isAbsolute(value)) { await access(value, constants.R_OK); return value; }
  if (value.includes('/') || value.includes('\\')) throw new Error('--pnpm requires an absolute path');
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory, value);
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Cannot find ${value}; install the packageManager version and pass --pnpm <absolute launcher path>`);
}

function testCounts(log) {
  const suites = [];
  const current = new Map();
  for (const line of log.replaceAll(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = /^(.*?)(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (!match) continue;
    const [, prefix, metric, count] = match;
    if (metric === 'tests') {
      const suite = { name: prefix.trim() || 'node:test', tests: Number(count) };
      suites.push(suite); current.set(prefix, suite);
    } else if (current.has(prefix)) current.get(prefix)[metric] = Number(count);
  }
  return suites;
}

async function runStep(step, env, output) {
  const record = { name: step.name, command: step.command, cwd: step.cwd, startedAt: new Date().toISOString(), log: `${step.name}${step.captureStdout ? '.stderr' : ''}.log` };
  const log = await open(join(output, record.log), 'wx', 0o600);
  let result, stdout;
  try {
    if (step.captureStdout) stdout = await open(join(output, `${step.name}.stdout.log`), 'wx', 0o600);
    result = await new Promise(resolve => {
      const child = spawn(step.command[0], step.command.slice(1), { cwd: step.cwd, env, detached: true, stdio: ['ignore', stdout?.fd ?? log.fd, log.fd] });
      let error, interrupted, forceStop;
      const send = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (cause) { if (cause.code !== 'ESRCH') error = cause.message; } } };
      const stop = signal => {
        if (interrupted) return;
        interrupted = signal; send(signal);
        forceStop = setTimeout(() => send('SIGKILL'), 5000);
      };
      const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      const timeout = step.timeout ? setTimeout(() => stop('SIGTERM'), step.timeout) : undefined;
      child.on('error', cause => { error = cause.message; });
      child.on('close', (exitCode, signal) => {
        clearTimeout(forceStop);
        clearTimeout(timeout);
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
        resolve({ exitCode, signal, ...(error ? { error } : {}), ...(interrupted ? { interrupted } : {}) });
      });
    });
  } finally { await stdout?.close(); await log.close(); }
  const bytes = await readFile(join(output, record.log));
  if (step.captureStdout) {
    const path = `${step.name}.stdout.log`, bytes = await readFile(join(output, path));
    record.stdout = { log: path, sha256: sha256(bytes), byteLength: bytes.length };
  }
  return { ...record, ...result, finishedAt: new Date().toISOString(), sha256: sha256(bytes), byteLength: bytes.length, suites: testCounts(bytes.toString()) };
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, pnpm: { type: 'string' }, binary: { type: 'string' },
    'check-only': { type: 'boolean' }, release: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/verify.mjs --out <new evidence directory> [--pnpm <absolute launcher>] [--binary <absolute sing-box path>] [--check-only] [--release]');
    console.log('Runs check and native integration by default. --release adds only the fixed Release download/build tests. Never installs dependencies or invokes publication/activation/rollback acceptance tests.');
    return;
  }
  if (!values.out) throw new Error('--out <new evidence directory> is required');
  if (values['check-only'] && values.release) throw new Error('--check-only and --release cannot be combined');
  const output = resolve(values.out);
  // Capture source identity before creating a potentially in-repository evidence directory.
  const git = async args => (await exec('git', args, { cwd: root })).stdout;
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const status = await git(['status', '--porcelain=v1']);
  const diff = await git(['diff', 'HEAD', '--binary']);
  await mkdir(output, { mode: 0o700 }); // Do not overwrite any previous run, including a failed one.
  const summary = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
    scope: values['check-only'] ? 'check-only' : values.release ? 'check-native-release' : 'check-native',
    source: { commit, clean: status.length === 0, status, trackedDiffSha256: sha256(diff) },
    tools: { node: { version: process.version, executable: process.execPath } }, preflight: [], steps: [] };
  let binDirectory;
  try {
    if (process.platform === 'win32') throw new Error('This verification entry currently requires a macOS or Linux host');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const minimum = /^>=(\d+)$/.exec(pkg.engines?.node ?? '');
    if (!minimum || Number(process.versions.node.split('.')[0]) < Number(minimum[1])) throw new Error(`Node ${pkg.engines?.node} is required; got ${process.version}`);
    const expected = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/.exec(pkg.packageManager)?.[1];
    if (!expected) throw new Error('package.json must pin an exact pnpm packageManager version');
    const path = await launcherPath(values.pnpm ?? 'pnpm');
    const command = /\.[cm]?js$/.test(path) ? [process.execPath, path] : [path];
    const preflight = async (name, command) => {
      const record = await runStep({ name, command, cwd: root, timeout: 30_000, captureStdout: true }, process.env, output);
      summary.preflight.push(record);
      if (record.exitCode !== 0 || record.interrupted) throw new Error(`${name} failed (${record.interrupted ?? record.signal ?? record.exitCode ?? record.error}); see ${record.log}`);
      return (await readFile(join(output, record.stdout.log), 'utf8')).trim();
    };
    summary.tools.pnpm = { expected, launcher: path, launcherSha256: sha256(await readFile(path)) };
    const actual = await preflight('pnpm-version', [...command, '--version']);
    summary.tools.pnpm.actual = actual;
    if (actual !== expected) throw new Error(`Expected pnpm ${expected}, got ${actual}. Select the installed matching launcher with --pnpm <absolute path>; no checks or installs were run.`);
    binDirectory = await mkdtemp(join(tmpdir(), 'verification-bin-'));
    await writeFile(join(binDirectory, 'pnpm'), `#!/bin/sh\nexec ${command.map(shellQuote).join(' ')} "$@"\n`, { mode: 0o700 });
    await writeFile(join(binDirectory, 'node'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`, NO_COLOR: '1' };
    // Evidence paths are always owned by this run, never inherited from another task.
    delete env.RULE_ACTIVATION_CLIENT_EVIDENCE;
    delete env.RULE_CLIENT_FAILURE_EVIDENCE;
    if (!values['check-only']) {
      const binary = values.binary ?? process.env.SING_BOX_TEST_BINARY;
      if (!binary || !isAbsolute(binary)) throw new Error('Provide --binary <absolute sing-box path> or SING_BOX_TEST_BINARY, or use --check-only');
      const resolved = await realpath(binary);
      const expectedVersion = JSON.parse(await readFile(join(root, 'packages/config-compiler/schemas/build.json'), 'utf8')).version;
      summary.tools.singBox = { path: resolved, expectedVersion, sha256: sha256(await readFile(resolved)) };
      const identity = await preflight('sing-box-version', [resolved, 'version']);
      summary.tools.singBox.identity = identity;
      if (identity.split(/\r?\n/)[0] !== `sing-box version ${expectedVersion}`) throw new Error(`Expected sing-box ${expectedVersion}; got ${identity.split(/\r?\n/)[0]}`);
      summary.tools.singBox.version = expectedVersion;
      env.SING_BOX_TEST_BINARY = resolved;
      env.RULE_ACTIVATION_CLIENT_EVIDENCE = join(output, 'client-update-rollback.json');
      env.RULE_CLIENT_FAILURE_EVIDENCE = join(output, 'client-failure-cache.json');
    }
    const steps = [{ name: 'check', command: [join(binDirectory, 'pnpm'), 'check'], cwd: root }];
    if (!values['check-only']) steps.push({ name: 'integration', command: [join(binDirectory, 'pnpm'), 'test:integration'], cwd: root });
    if (values.release) steps.push({ name: 'release', command: [process.execPath, '--import', 'tsx', '--test', 'test/acceptance/release.test.ts', 'test/acceptance/configured-release.test.ts'], cwd: join(root, 'packages/rule-set-pipeline') });
    for (const step of steps) {
      console.log(`Running ${step.name}; log: ${join(output, `${step.name}.log`)}`);
      const record = await runStep(step, env, output);
      // Store a reproducible command, rather than a path to the disposable PATH wrapper.
      if (step.name !== 'release') record.command = [...command, ...step.command.slice(1)];
      summary.steps.push(record);
      await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      if (record.exitCode !== 0 || record.interrupted) throw new Error(`${step.name} failed (${record.interrupted ?? record.signal ?? record.exitCode ?? record.error}); see ${record.log}`);
      if (!record.suites.length || record.suites.some(suite =>
        !['tests', 'pass', 'fail', 'skipped'].every(key => Number.isSafeInteger(suite[key])) || suite.tests === 0
        || suite.fail !== 0 || suite.skipped !== 0 || (suite.cancelled ?? 0) !== 0 || (suite.todo ?? 0) !== 0 || suite.pass !== suite.tests)) {
        throw new Error(`${step.name} did not report complete passing tests without skips; see ${record.log}`);
      }
    }
    summary.status = 'passed';
  } catch (error) {
    summary.status = 'failed'; summary.error = error.message;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    if (binDirectory) await rm(binDirectory, { recursive: true, force: true });
    summary.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    const files = [];
    for (const name of (await readdir(output)).sort()) {
      const bytes = await readFile(join(output, name));
      files.push({ path: name, byteLength: bytes.length, sha256: sha256(bytes) });
    }
    await writeFile(join(output, 'files.json'), JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n');
    console.log(`${summary.status}: ${join(output, 'summary.json')}`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
