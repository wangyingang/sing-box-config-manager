import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationEvidenceVerifier } from '../src/evidence-download.js';
import { ARTIFACT_REPOSITORY, immutableUrl } from '../src/publication.js';

const commit = 'a'.repeat(40);
const address = immutableUrl(commit, 'candidates/id/readback.json');

test('失败的传输和校验均可重试，调用方和传输持有的字节无法修改已校验证据', async () => {
  let reads = 0;
  const transportBytes = Buffer.from('evidence');
  const verify = createOperationEvidenceVerifier(async () => {
    reads++;
    if (reads === 1) throw new Error('HTTP 503');
    return reads === 2 ? Buffer.from('corrupt') : transportBytes;
  });
  const read = () => verify(async download => {
    const bytes = await download(address);
    assert.equal(bytes.toString(), 'evidence');
    return bytes;
  });

  await assert.rejects(read(), /HTTP 503/);
  await assert.rejects(read(), /corrupt/);
  const first = await read();
  first.fill(0);
  transportBytes.fill(0);
  const next = await read();
  next.fill(0);
  assert.equal((await read()).toString(), 'evidence');
  assert.equal(reads, 3);
});

test('可信完整提交地址才复用，淘汰后重新下载', async () => {
  const requests: string[] = [];
  const verify = createOperationEvidenceVerifier(async url => {
    requests.push(url);
    return Buffer.from('evidence');
  });
  const read = (url: string) => verify(async download => {
    assert.equal((await download(url)).toString(), 'evidence');
  });

  for (const url of [
    `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/main/stable/domains.srs`,
    `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${commit.slice(0, 7)}/candidates/id/readback.json`,
    address.replace(ARTIFACT_REPOSITORY, 'untrusted/other-artifacts'),
  ]) {
    await read(url);
    await read(url);
    assert.equal(requests.filter(request => request === url).length, 2);
  }

  await read(address);
  await read(address);
  assert.equal(requests.filter(request => request === address).length, 1);
  for (let index = 0; index < 128; index++) {
    await read(immutableUrl(commit, `candidates/id/${index}.json`));
  }
  await read(address);
  assert.equal(requests.filter(request => request === address).length, 2);
});

test('超出 64 MiB 的证据逐次下载，调用方仍得到独立字节', async () => {
  const transportBytes = Buffer.alloc(64 * 1024 * 1024 + 1);
  transportBytes[0] = 42;
  let reads = 0;
  const verify = createOperationEvidenceVerifier(async () => {
    reads++;
    return transportBytes;
  });
  const read = () => verify(async download => {
    const bytes = await download(address);
    assert.equal(bytes[0], 42);
    return bytes;
  });

  (await read())[0] = 0;
  await read();
  assert.equal(reads, 2);
  assert.equal(transportBytes[0], 42);
});
