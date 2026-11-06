import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../check-pr-delivery.mjs', import.meta.url));
const repository = 'example/project';
const issue = (number = 48) => ({ number, url: `https://github.com/${repository}/issues/${number}`, state: 'OPEN', stateReason: null });
const reference = (number = 48, nameWithOwner = repository) => ({ number, repository: { nameWithOwner } });
const page = (references = [reference()]) => ({ data: { repository: {
  nameWithOwner: repository, defaultBranchRef: { name: 'main' }, pullRequest: {
    number: 56, url: `https://github.com/${repository}/pull/56`, state: 'OPEN', isDraft: false,
    baseRefName: 'main', headRefOid: 'a'.repeat(40), mergeCommit: null,
    closingIssuesReferences: { nodes: references, pageInfo: { hasNextPage: false, endCursor: null } },
  },
} } });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pr-delivery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = { pages: [page()], issues: { 48: issue() } };
  const callsPath = join(directory, 'calls.jsonl');
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(process.env.DELIVERY_TEST_DATA));
fs.appendFileSync(process.env.DELIVERY_TEST_CALLS, JSON.stringify(args) + '\\n');
const field = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
let result, kind;
if (args[0] === 'repo' && args[1] === 'view') {
  kind = 'repo'; result = { nameWithOwner: '${repository}' };
} else if (args[0] === 'api' && args[1] === 'graphql') {
  if (!/^query\\b/.test(field('query')) || /\\bmutation\\b/.test(field('query'))) throw new Error('Only a GraphQL query is allowed');
  kind = 'pr';
  const cursor = field('cursor');
  result = data.pages[cursor ? Number(cursor.replace('page-', '')) : 0];
} else if (args[0] === 'issue' && args[1] === 'view') {
  kind = 'issue'; result = data.issues[args[2]];
} else throw new Error('Unexpected or mutating gh command: ' + JSON.stringify(args));
if (data.failOn === kind) { console.error('GitHub is unavailable'); process.exit(1); }
if (data.invalidJson === kind) console.log('{broken');
else console.log(JSON.stringify(result));
`, { mode: 0o755 });
  return {
    data,
    run(args = ['--pr', '56', '--issue', '48', '--phase', 'before-merge']) {
      const dataPath = join(directory, 'data.json');
      writeFileSync(dataPath, JSON.stringify(data)); writeFileSync(callsPath, '');
      const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8',
        env: { ...process.env, PATH: `${directory}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
          DELIVERY_TEST_DATA: dataPath, DELIVERY_TEST_CALLS: callsPath } });
      const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls,
        report: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : undefined };
    },
  };
}

test('before merge verifies the explicit issue set and only invokes read-only GitHub commands', t => {
  const f = fixture(t), result = f.run(['--pr', '56', '--issue', '48', '--phase', 'before-merge', '--repo', repository]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.report.status, 'passed');
  assert.equal(result.report.repository, repository);
  assert.equal(result.report.pullRequest.headCommit, 'a'.repeat(40));
  assert.deepEqual(result.report.issues.map(entry => entry.number), [48]);
  assert.deepEqual(result.calls[0], ['repo', 'view', repository, '--json', 'nameWithOwner']);
  assert.ok(result.calls.every(args => ['repo view', 'api graphql', 'issue view'].includes(args.slice(0, 2).join(' '))));
});

for (const [name, mutate, expected] of [
  ['missing closing reference', data => { data.pages[0].data.repository.pullRequest.closingIssuesReferences.nodes = []; }, /48/],
  ['unexpected issue', data => { data.pages[0].data.repository.pullRequest.closingIssuesReferences.nodes.push(reference(47)); }, /47/],
  ['same number in another repository', data => { data.pages[0].data.repository.pullRequest.closingIssuesReferences.nodes = [reference(48, 'other/project')]; }, /other\/project/],
  ['non-default target', data => { data.pages[0].data.repository.pullRequest.baseRefName = 'release'; }, /main|默认分支/],
  ['draft PR', data => { data.pages[0].data.repository.pullRequest.isDraft = true; }, /草稿|draft/],
  ['closed unmerged PR', data => { data.pages[0].data.repository.pullRequest.state = 'CLOSED'; }, /OPEN|打开/],
  ['already closed issue', data => { data.issues[48].state = 'CLOSED'; data.issues[48].stateReason = 'COMPLETED'; }, /48/],
]) {
  test(`before merge rejects ${name}`, t => {
    const f = fixture(t); mutate(f.data);
    const result = f.run();
    assert.equal(result.code, 1);
    assert.equal(result.report.status, 'failed');
    assert.match(result.report.errors.join('\n'), expected);
  });
}

test('closing references are fully paginated and compared with every selected issue', t => {
  const f = fixture(t);
  f.data.pages[0].data.repository.pullRequest.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'page-1' };
  f.data.pages.push(page([reference(49)])); f.data.issues[49] = issue(49);
  const result = f.run(['--pr', '56', '--issue', '48', '--issue', '49', '--phase', 'before-merge']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.calls.filter(args => args[0] === 'api').length, 2);
  assert.deepEqual(result.report.issues.map(entry => entry.number), [48, 49]);
});

for (const fault of ['head-change', 'repeated-cursor', 'missing-page-info', 'graphql-error', 'invalid-json', 'missing-pr', 'wrong-issue', 'read-failure']) {
  test(`incomplete or inconsistent GitHub reads fail closed: ${fault}`, t => {
    const f = fixture(t);
    if (['head-change', 'repeated-cursor'].includes(fault)) {
      f.data.pages[0].data.repository.pullRequest.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'page-1' };
      f.data.pages.push(page([]));
      if (fault === 'head-change') f.data.pages[1].data.repository.pullRequest.headRefOid = 'b'.repeat(40);
      else f.data.pages[1].data.repository.pullRequest.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'page-1' };
    }
    if (fault === 'missing-page-info') delete f.data.pages[0].data.repository.pullRequest.closingIssuesReferences.pageInfo;
    if (fault === 'graphql-error') f.data.pages[0].errors = [{ message: 'partial response' }];
    if (fault === 'invalid-json') f.data.invalidJson = 'pr';
    if (fault === 'missing-pr') f.data.pages[0].data.repository.pullRequest = null;
    if (fault === 'wrong-issue') f.data.issues[48].number = 49;
    if (fault === 'read-failure') f.data.failOn = 'issue';
    const result = f.run();
    assert.equal(result.code, 1);
    assert.equal(result.report.status, 'failed');
    assert.ok(result.report.errors.length > 0);
  });
}

function merged(f) {
  const pr = f.data.pages[0].data.repository.pullRequest;
  pr.state = 'MERGED'; pr.mergeCommit = { oid: 'b'.repeat(40) };
  pr.closingIssuesReferences.nodes = [];
  f.data.issues[48].state = 'CLOSED'; f.data.issues[48].stateReason = 'COMPLETED';
}

test('after merge accepts a manually completed historical issue without an automatic closing reference', t => {
  const f = fixture(t); merged(f);
  const result = f.run(['--pr', '56', '--issue', '48', '--phase', 'after-merge']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.pullRequest.mergeCommit, 'b'.repeat(40));
  assert.equal(result.report.issues[0].stateReason, 'COMPLETED');
});

for (const [name, mutate] of [
  ['open issue', data => { data.issues[48].state = 'OPEN'; data.issues[48].stateReason = null; }],
  ['not planned', data => { data.issues[48].stateReason = 'NOT_PLANNED'; }],
  ['missing close reason', data => { data.issues[48].stateReason = null; }],
  ['unmerged PR', data => { data.pages[0].data.repository.pullRequest.state = 'OPEN'; data.pages[0].data.repository.pullRequest.mergeCommit = null; }],
  ['missing merge commit', data => { data.pages[0].data.repository.pullRequest.mergeCommit = null; }],
  ['non-default target', data => { data.pages[0].data.repository.pullRequest.baseRefName = 'release'; }],
]) {
  test(`after merge rejects ${name}`, t => {
    const f = fixture(t); merged(f); mutate(f.data);
    const result = f.run(['--pr', '56', '--issue', '48', '--phase', 'after-merge']);
    assert.equal(result.code, 1);
    assert.equal(result.report.status, 'failed');
  });
}

test('help and invalid arguments never contact GitHub', t => {
  const f = fixture(t), help = f.run(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /before-merge/); assert.deepEqual(help.calls, []);
  for (const args of [[], ['--pr', '56', '--issue', '48'],
    ['--pr', '56', '--issue', '48', '--phase', 'unknown'],
    ['--pr', '56', '--issue', '48', '--issue', '48', '--phase', 'before-merge'],
    ['--pr', '56', '--issue', '0', '--phase', 'before-merge'],
    ['--pr', '56', '--issue', '48', '--phase', 'before-merge', '--repo', 'owner/repo/extra'],
  ]) {
    const result = f.run(args);
    assert.equal(result.code, 1); assert.deepEqual(result.calls, []);
  }
});
