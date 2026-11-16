import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { ghJson, GitHubHttpError } from '../src/publication.js';

test('GitHub errors identify the request without exposing query, body or credential or retrying writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gh-diagnostic-'));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(directory, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(join(directory, 'calls'))}, 'call\\n');
process.stdin.resume();
process.stdin.on('end', () => { console.error('gh: The request is taking too long to generate. (HTTP 422)'); process.exitCode = 1; });
`, { mode: 0o700 });
    process.env.PATH = directory + delimiter + (previousPath ?? '');
    await assert.rejects(ghJson(['api', 'repos/example/artifacts/git/refs/heads/acceptance-test?secret=query-value',
      '--method', 'PATCH', '--input', '-'], { secret: 'body-value' }, 'credential-value'), error => {
      assert.ok(error instanceof GitHubHttpError);
      assert.equal(error.status, 422);
      assert.match(error.message, /PATCH repos\/example\/artifacts\/git\/refs\/heads\/acceptance-test/);
      assert.doesNotMatch(error.message, /query-value|body-value|credential-value/);
      return true;
    });
    assert.equal(await readFile(join(directory, 'calls'), 'utf8'), 'call\n');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
