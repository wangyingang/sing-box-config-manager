import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const detector = fileURLToPath(new URL('../ci-changes.mjs', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'CI test');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  const write = (path, value = 'content\n') => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), value);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  write('README.md');
  write('code.js');
  const base = commit();
  const run = (name, event, raw = false) => {
    const eventPath = join(directory, 'event.json');
    const output = join(directory, 'output');
    writeFileSync(eventPath, raw ? event : JSON.stringify(event));
    writeFileSync(output, '');
    const result = JSON.parse(execFileSync(process.execPath, [detector], { cwd: repo,
      env: { ...process.env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(readFileSync(output, 'utf8'), `run_tests=${result.runTests}\n`);
    return result;
  };
  return { git, write, commit, base, run };
}

const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } });

test('Markdown-only PR and push skip full checks, including unusual filenames', t => {
  const f = fixture(t);
  f.write('README.md', 'updated');
  f.write('docs/spaces and\nnewline.md');
  const head = f.commit();
  for (const [name, event] of [['pull_request', pr(f.base, head)], ['push', { before: f.base, after: head }]]) {
    const result = f.run(name, event);
    assert.equal(result.runTests, false);
    assert.equal(result.changedPaths, 2);
  }
});

test('PR includes code changed before the final Markdown-only commit', t => {
  const f = fixture(t);
  f.write('code.js', 'changed');
  f.commit();
  f.write('README.md', 'updated');
  const head = f.commit();
  assert.equal(f.run('pull_request', pr(f.base, head)).runTests, true);
});

test('push compares the whole pushed range, not only the final commit', t => {
  const f = fixture(t);
  f.write('code.js', 'changed');
  f.commit();
  f.write('README.md', 'updated');
  const head = f.commit();
  assert.equal(f.run('push', { before: f.base, after: head }).runTests, true);
});

test('PR uses merge-base when target branch has unrelated newer code', t => {
  const f = fixture(t);
  f.git('checkout', '-b', 'docs');
  f.write('README.md', 'updated');
  const head = f.commit();
  f.git('checkout', 'main');
  f.write('code.js', 'target branch change');
  const base = f.commit();
  assert.equal(f.run('pull_request', pr(base, head)).runTests, false);
  // A push compares endpoint trees, not the merge-base.
  assert.equal(f.run('push', { before: base, after: head }).runTests, true);
});

test('renaming code to Markdown still runs checks', t => {
  const f = fixture(t);
  f.git('mv', 'code.js', 'code.md');
  const head = f.commit();
  assert.equal(f.run('pull_request', pr(f.base, head)).runTests, true);
});

test('Markdown deletions and renames can skip checks', t => {
  const f = fixture(t);
  f.git('mv', 'README.md', 'NOTES.md');
  const renamed = f.commit();
  assert.equal(f.run('push', { before: f.base, after: renamed }).runTests, false);
  f.git('rm', 'NOTES.md');
  const deleted = f.commit();
  assert.equal(f.run('push', { before: renamed, after: deleted }).runTests, false);
});

test('deleting code still runs checks', t => {
  const f = fixture(t);
  f.git('rm', 'code.js');
  const head = f.commit();
  assert.equal(f.run('push', { before: f.base, after: head }).runTests, true);
});

test('JSON evidence under docs and workflow changes require checks', t => {
  const f = fixture(t);
  for (const path of ['docs/verification/summary.json', '.github/workflows/ci.yml']) {
    const before = f.git('rev-parse', 'HEAD');
    f.write(path);
    const after = f.commit();
    assert.equal(f.run('push', { before, after }).runTests, true);
  }
});

test('manual and unsupported events run full checks', t => {
  const f = fixture(t);
  assert.equal(f.run('workflow_dispatch', 'invalid JSON', true).runTests, true);
  assert.equal(f.run('unknown', {}).runTests, true);
});

test('empty diffs, missing commits and invalid event payloads conservatively run checks', t => {
  const f = fixture(t);
  for (const event of [
    { before: f.base, after: f.base },
    { before: '0'.repeat(40), after: f.base },
    { before: 'f'.repeat(40), after: f.base },
    { before: '--help', after: f.base },
    {},
  ]) assert.equal(f.run('push', event).runTests, true);
  assert.equal(f.run('pull_request', {}).runTests, true);
  assert.equal(f.run('push', '{broken', true).runTests, true);
});
