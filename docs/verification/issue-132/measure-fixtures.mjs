import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2]);
const pkg = join(root, 'packages/rule-set-pipeline');
const realBinary = resolve(process.env.SING_BOX_TEST_BINARY);
const temporary = await mkdtemp(join(tmpdir(), 'pipeline-fixture-counts-'));
const wrapper = join(temporary, 'sing-box');
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const stages = [
  { file: 'rules-selection', prepare: 'prepareVersions', before: 'versions' },
  { file: 'rules-cleanup', prepare: 'prepareRetainedHistory', before: 'retainedFixture' },
];
const measurements = [];
const gitText = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitStatus = gitText('status', '--porcelain');
const trackedDiffSha256 = sha256(gitText('diff', '--binary', 'HEAD'));

try {
  await writeFile(wrapper, `#!/bin/sh
if [ -f "$0.stage" ]; then
  IFS= read -r target < "$0.stage"
  printf '%s\t%s\n' "$target" "$*" >> "$0.log"
fi
exec ${shellQuote(realBinary)} "$@"
`, { mode: 0o700 });

  for (const { file, prepare, before } of stages) {
    const source = join(pkg, 'test/integration', file + '.test.ts');
    const probe = join(pkg, 'test/integration', `.${file}-${process.pid}-probe.ts`);
    const input = await readFile(source, 'utf8');
    const start = input.indexOf(`async function ${input.includes(`async function ${prepare}(`) ? prepare : before}(`);
    assert.notEqual(start, -1, source);
    const open = input.indexOf('{\n', start) + 2;
    const close = input.indexOf('\n}\n', open);
    assert.ok(open > start && close > open, source);
    await writeFile(wrapper + '.log', '');
    const observed = input.slice(0, open) + `
  const { appendFileSync, writeFileSync, rmSync } = await import('node:fs');
  appendFileSync(binary + '.log', target + '\\tprepare\\n');
  writeFileSync(binary + '.stage', target + '\\n');
  try {
` + input.slice(open, close) + `
  } finally {
    rmSync(binary + '.stage', { force: true });
  }
` + input.slice(close);
    await writeFile(probe, observed, { flag: 'wx' });
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', probe], {
        cwd: pkg, env: { ...process.env, SING_BOX_TEST_BINARY: wrapper },
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      });
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      assert.equal(result.status, 0, result.error?.message ?? source);
      const calls = (await readFile(wrapper + '.log', 'utf8')).trim().split('\n').filter(Boolean);
      const perTarget = {};
      for (const call of calls) {
        const [target, command] = call.split('\t');
        const counts = perTarget[target] ??= { preparations: 0, compile: 0, decompile: 0, jsonLoad: 0, srsLoad: 0, other: 0 };
        if (command === 'prepare') counts.preparations++;
        else if (command.startsWith('rule-set compile ')) counts.compile++;
        else if (command.startsWith('rule-set decompile ')) counts.decompile++;
        else if (command.startsWith('rule-set match ') && command.endsWith('--format source')) counts.jsonLoad++;
        else if (command.startsWith('rule-set match ') && command.endsWith('--format binary')) counts.srsLoad++;
        else counts.other++;
      }
      measurements.push({ source, sourceSha256: sha256(input), instrumentedSha256: sha256(observed),
        exitCode: result.status, perTarget, calls });
    } finally {
      await rm(probe);
    }
  }
  console.log(JSON.stringify({ source: gitText('rev-parse', 'HEAD'), gitStatus, trackedDiffSha256,
    probeSha256: sha256(await readFile(fileURLToPath(import.meta.url))), wrapperSha256: sha256(await readFile(wrapper)),
    node: process.version, platform: `${process.platform}/${process.arch}`, command: process.argv,
    singBoxSha256: sha256(await readFile(realBinary)), measurements }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
