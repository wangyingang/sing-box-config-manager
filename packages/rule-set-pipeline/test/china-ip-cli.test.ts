import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const commit = 'a'.repeat(40);
const forkCommit = 'b'.repeat(40);

async function fixture(directory: string, bytes: Uint8Array) {
  const preload = join(directory, 'source.mjs');
  await writeFile(preload, `let discovered = false;
globalThis.fetch = async (url, options) => {
  if (url === 'https://api.github.com/repos/gaoyifan/china-operator-ip/branches/ip-lists') {
    if (discovered) throw new Error('Branch resolved more than once');
    discovered = true;
    return Response.json({ name: 'ip-lists', commit: { sha: '${commit}' } });
  }
  if (url === 'https://api.github.com/repos/gaoyifan/china-operator-ip/compare/${forkCommit}...${commit}?per_page=1') {
    return Response.json({ merge_base_commit: { sha: 'c'.repeat(40) } });
  }
  if (url === 'https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${commit}/china46.txt') {
    if (!discovered) throw new Error('Download before fixing the commit');
    if (new Headers(options?.headers).has('Authorization')) throw new Error('Source token leaked to raw host');
    return new Response(Uint8Array.from(${JSON.stringify([...bytes])}));
  }
  throw new Error('Unexpected source request: ' + url);
};`);
  return (out: string, ...args: string[]) => exec(process.execPath, ['--import', 'tsx', '--import', preload,
    'src/cli.ts', 'build', '--config', 'config/china-ip.yml', '--out', out, ...args],
  { env: { ...process.env, GITHUB_TOKEN: 'controlled-cli-fixture' } });
}

test('china-ip 构建失败时只写入固定来源和可定位的诊断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'china-ip-invalid-'));
  try {
    const cases = [
      { bytes: Buffer.from('# comment\r\n192.0.2.0/24\r\n2001:db8::/129\r\n'), code: 'INVALID_CIDR', line: 3 },
      { bytes: Buffer.from('192.0.2.1'), code: 'INVALID_CIDR', line: 1 },
      { bytes: Buffer.from('fe80::%eth0/64'), code: 'INVALID_CIDR', line: 1 },
      { bytes: Buffer.from('192.0.2.0/24 # comment'), code: 'INVALID_CIDR', line: 1 },
      { bytes: Buffer.from([0xff]), code: 'INVALID_UTF8' },
      { bytes: Buffer.from(' # comment\n\n'), code: 'EMPTY_INPUT' },
    ];
    for (const [index, { bytes, code, line }] of cases.entries()) {
      const out = join(directory, String(index));
      const run = await fixture(directory, bytes);
      await assert.rejects(run(out, '--binary', '/unused'), { code: 1 });
      const rule = join(out, 'china-ip');
      assert.deepEqual((await readdir(rule)).sort(), ['conversion-report.json', 'failure.json']);
      const report = JSON.parse(await readFile(join(rule, 'conversion-report.json'), 'utf8'));
      assert.equal(report.status, 'failed');
      assert.deepEqual(report.diagnostics.map((entry: { code: string; file: string; line?: number }) =>
        [entry.code, entry.file, entry.line]), [[code, 'china46.txt', line]]);
      const source = JSON.parse(await readFile(join(out, 'source.json'), 'utf8'));
      assert.equal(source.commit, commit);
      assert.equal(source.inputBytes, bytes.length);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('china-ip 拒绝从不在可信分支历史中的 commit 下载', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'china-ip-fork-'));
  try {
    const run = await fixture(directory, Buffer.from('192.0.2.0/24'));
    const out = join(directory, 'out');
    await assert.rejects(run(out, '--commit', forkCommit, '--binary', '/unused'),
      (error: { code?: number; stderr?: string }) => error.code === 1 && /outside .*ip-lists history/.test(error.stderr ?? ''));
    assert.deepEqual(await readdir(directory), ['source.mjs']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
