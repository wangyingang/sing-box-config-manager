import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildConfiguredCommit } from '../src/configured-build.js';

const commit = 'a'.repeat(40);
const forkCommit = 'b'.repeat(40);

function fixture(bytes: Uint8Array) {
  let discovered = false;
  const fetcher: typeof fetch = async (address, options) => {
    const url = String(address);
    if (url === 'https://api.github.com/repos/gaoyifan/china-operator-ip/branches/ip-lists') {
      if (discovered) throw new Error('Branch resolved more than once');
      discovered = true;
      return Response.json({ name: 'ip-lists', commit: { sha: commit } });
    }
    if (url === `https://api.github.com/repos/gaoyifan/china-operator-ip/compare/${forkCommit}...${commit}?per_page=1`) {
      return Response.json({ merge_base_commit: { sha: 'c'.repeat(40) } });
    }
    if (url === `https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${commit}/china46.txt`) {
      if (!discovered) throw new Error('Download before fixing the commit');
      if (new Headers(options?.headers).has('Authorization')) throw new Error('Source token leaked to raw host');
      return new Response(Uint8Array.from(bytes));
    }
    throw new Error('Unexpected source request: ' + url);
  };
  return fetcher;
}

test('内部 china-ip 构建失败保留固定来源和可定位诊断', async () => {
  const configuration = await readFile('config/china-ip.yml', 'utf8');
  const cases = [
    { bytes: Buffer.from('# comment\r\n192.0.2.0/24\r\n2001:db8::/129\r\n'), code: 'INVALID_CIDR', line: 3 },
    { bytes: Buffer.from('192.0.2.1'), code: 'INVALID_CIDR', line: 1 },
    { bytes: Buffer.from('fe80::%eth0/64'), code: 'INVALID_CIDR', line: 1 },
    { bytes: Buffer.from('192.0.2.0/24 # comment'), code: 'INVALID_CIDR', line: 1 },
    { bytes: Buffer.from([0xff]), code: 'INVALID_UTF8' },
    { bytes: Buffer.from(' # comment\n\n'), code: 'EMPTY_INPUT' },
  ];
  for (const { bytes, code, line } of cases) {
    const built = await buildConfiguredCommit({ configuration, binary: '/unused', github: { fetch: fixture(bytes), token: 'controlled-fixture' } });
    const result = built.results[0];
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.report.diagnostics.map(entry => [entry.code, entry.file, entry.line]), [[code, 'china46.txt', line]]);
    assert.equal(built.source.commit, commit);
    assert.equal(built.source.inputBytes, bytes.length);
    assert.ok(!('native' in result));
  }
});

test('内部 china-ip 构建拒绝可信分支历史之外的 commit', async () => {
  await assert.rejects(buildConfiguredCommit({ configuration: await readFile('config/china-ip.yml', 'utf8'), binary: '/unused',
    github: { fetch: fixture(Buffer.from('192.0.2.0/24')), commit: forkCommit } }), /outside .*ip-lists history/);
});
