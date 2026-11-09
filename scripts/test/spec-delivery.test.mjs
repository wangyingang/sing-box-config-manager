import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../check-spec-delivery.mjs', import.meta.url));
const repository = 'example/project';
const head = 'a'.repeat(40), merge = 'b'.repeat(40), previous = 'c'.repeat(40);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const issue = number => ({ id: `I_${number}`, number, url: `https://github.com/${repository}/issues/${number}`,
  title: `Issue ${number}`, body: `Acceptance criteria for ${number}`, state: 'CLOSED', stateReason: 'COMPLETED',
  updatedAt: '2026-11-09T01:00:00Z', repository: { nameWithOwner: repository } });
const reference = number => ({ number, repository: { nameWithOwner: repository } });
const prReference = number => ({ id: `PR_${number}`, number, url: `https://github.com/${repository}/pull/${number}`,
  repository: { nameWithOwner: repository } });
const comment = (id, body = 'Full evidence is retained only in the report') => ({ id, body,
  url: `https://github.com/${repository}/issues/40#issuecomment-${id}`, author: { login: 'reviewer' },
  createdAt: '2026-11-09T01:00:00Z', updatedAt: '2026-11-09T01:00:00Z' });
const cloud = (id = 'cloud-1', state = {}) => ({ ...comment(id,
  `Review completed.\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: {
    status: 'completed', commit_sha: head, has_any_findings: false, has_unresolved_findings: false, ...state,
  } })} -->`), author: { login: 'chatgpt-codex-connector[bot]' } });
const page = (nodes = [], totalCount = nodes.length, next = null) => ({ nodes, totalCount,
  pageInfo: { hasNextPage: next !== null, endCursor: next } });

function evidence(directory, { status = 'passed', commit = head } = {}) {
  mkdirSync(directory);
  const log = '# tests 3\n# pass 3\n# fail 0\n# skipped 0\n';
  const summary = { schemaVersion: 1, status, scope: 'check-only',
    source: { commit, clean: true, status: '', trackedDiffSha256: sha256('') },
    tools: { node: { version: process.version, executable: process.execPath } }, preflight: [],
    steps: [{ name: 'check', exitCode: status === 'passed' ? 0 : 1, signal: null, log: 'check.log',
      byteLength: Buffer.byteLength(log), sha256: sha256(log),
      suites: [{ name: 'node:test', tests: 3, pass: 3, fail: 0, skipped: 0 }] }] };
  const bytes = JSON.stringify(summary, null, 2) + '\n';
  writeFileSync(join(directory, 'summary.json'), bytes); writeFileSync(join(directory, 'check.log'), log);
  writeFileSync(join(directory, 'files.json'), JSON.stringify({ schemaVersion: 1,
    files: [['summary.json', bytes], ['check.log', log]].map(([path, contents]) => ({ path,
      byteLength: Buffer.byteLength(contents), sha256: sha256(contents) })) }));
  return directory;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'spec-delivery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const issues = { 40: { ...issue(40), state: 'OPEN', stateReason: null }, 41: issue(41), 42: issue(42) };
  const pr = { id: 'PR_56', number: 56, url: `https://github.com/${repository}/pull/56`,
    state: 'MERGED', isDraft: false, baseRefName: 'main', headRefOid: head, mergeCommit: { oid: merge } };
  const thread = { id: 'THREAD_1', isResolved: true, isOutdated: false };
  const data = { repository, defaultBranchRef: { name: 'main', target: { oid: merge } }, issues,
    prs: { 56: pr }, threads: { THREAD_1: thread }, rollups: { 56: { commit: { oid: head }, state: 'SUCCESS' } },
    pages: {
      'issue:40:subIssues': [page([issues[41]])], 'issue:41:subIssues': [page([issues[42]])], 'issue:42:subIssues': [page()],
      'issue:40:comments': [page([comment('spec-comment')])], 'issue:41:comments': [page()], 'issue:42:comments': [page()],
      'issue:41:closedByPullRequestsReferences': [page([prReference(56)])],
      'issue:42:closedByPullRequestsReferences': [page([prReference(56)])],
      'pr:56:closingIssuesReferences': [page([reference(41), reference(42)])],
      'pr:56:comments': [page([cloud()])],
      'pr:56:reviews': [page([{ id: 'REVIEW_1', url: `${pr.url}#pullrequestreview-1`, body: 'Verified the change',
        state: 'COMMENTED', author: { login: 'reviewer' }, commit: { oid: head }, submittedAt: '2026-11-09T01:00:00Z' }])],
      'pr:56:reviewThreads': [page([thread])],
      'pr:56:contexts': [page([{ __typename: 'CheckRun', id: 'CHECK_1', name: 'test', status: 'COMPLETED',
        conclusion: 'SUCCESS', detailsUrl: `${pr.url}/checks` },
      { __typename: 'StatusContext', id: 'STATUS_1', context: 'external', state: 'SUCCESS', targetUrl: `${pr.url}/checks` }])],
      'thread:THREAD_1:comments': [page([{ ...comment('thread-comment'), originalCommit: { oid: head },
        commit: { oid: head }, path: 'src/main.ts', line: 8 }])],
    }, errors: {}, failures: {}, invalidJson: {}, overrides: {}, afterResponse: {} };
  const callsPath = join(directory, 'calls.jsonl'), dataPath = join(directory, 'data.json');
  const evidenceDirectory = evidence(join(directory, 'evidence'));
  writeFileSync(join(directory, 'gh'), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(process.env.SPEC_TEST_DATA));
fs.appendFileSync(process.env.SPEC_TEST_CALLS, JSON.stringify(args) + '\n');
const field = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
let result, route;
if (args[0] === 'repo' && args[1] === 'view') {
  route = 'repo'; result = { nameWithOwner: data.repository };
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const query = field('query');
  if (!/^query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error('Only a GraphQL query is allowed');
  const number = field('number'), cursor = field('cursor');
  const index = cursor ? Number(cursor.replace('page-', '')) : 0;
  const repo = { nameWithOwner: data.repository, defaultBranchRef: data.defaultBranchRef };
  let connection;
  if (query.includes('node(id:$id)')) {
    const id = field('id'); route = 'thread:' + id + ':comments';
    result = { data: { node: { ...data.threads[id], comments: data.pages[route]?.[index] } } };
  } else if (query.includes('issue(number:$number)')) {
    connection = ['subIssues', 'closedByPullRequestsReferences', 'comments'].find(name => query.includes(name + '(first:'));
    route = 'issue:' + number + ':' + connection;
    result = { data: { repository: { ...repo, issue: { ...data.issues[number], [connection]: data.pages[route]?.[index] } } } };
  } else if (query.includes('pullRequest(number:$number)')) {
    connection = ['closingIssuesReferences', 'comments', 'reviews', 'reviewThreads', 'contexts'].find(name => query.includes(name + '(first:'));
    route = 'pr:' + number + ':' + connection;
    const fields = connection === 'contexts' ? { statusCheckRollup: data.rollups[number] === null ? null :
      { ...data.rollups[number], contexts: data.pages[route]?.[index] } } : { [connection]: data.pages[route]?.[index] };
    result = { data: { repository: { ...repo, pullRequest: { ...data.prs[number], ...fields } } } };
  } else throw new Error('Unrecognized GraphQL query');
  if (Object.hasOwn(data.errors, route)) result.errors = data.errors[route];
} else throw new Error('Unexpected or mutating gh command: ' + JSON.stringify(args));
if (Object.hasOwn(data.overrides, route)) result = data.overrides[route];
if (data.failures[route]) { console.error('GitHub is unavailable'); process.exit(1); }
if (data.invalidJson[route]) console.log('{broken');
else console.log(JSON.stringify(result));
const patches = data.afterResponse[route];
if (patches) {
  delete data.afterResponse[route];
  for (const { path, value } of patches) {
    const target = path.slice(0, -1).reduce((node, key) => node[key], data);
    target[path.at(-1)] = value;
  }
  fs.writeFileSync(process.env.SPEC_TEST_DATA, JSON.stringify(data));
}
`, { mode: 0o755 });
  let runNumber = 0;
  function run({ args = [], rawArgs, withEvidence = true, output = join(directory, `report-${runNumber++}`) } = {}) {
    writeFileSync(dataPath, JSON.stringify(data)); writeFileSync(callsPath, '');
    const actualArgs = rawArgs ?? ['--spec', '40', '--repo', repository, '--out', output,
      ...(withEvidence ? ['--evidence', evidenceDirectory] : []), ...args];
    const result = spawnSync(process.execPath, [script, ...actualArgs], { cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${directory}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
        SPEC_TEST_DATA: dataPath, SPEC_TEST_CALLS: callsPath } });
    assert.ifError(result.error);
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const reportPath = join(output, 'report.json');
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls, report, output, reportPath,
      state: JSON.parse(readFileSync(dataPath, 'utf8')) };
  }
  return { directory, data, evidenceDirectory, run };
}

function assertStatus(result, status) {
  assert.equal(result.code, status === 'passed' ? 0 : 1, result.stderr || result.stdout);
  assert.equal(result.report?.status, status, JSON.stringify(result.report));
  assert.equal(result.report.acceptance, 'not-evaluated');
}

test('recursively audits native child relationships and a shared PR without judging acceptance or writing GitHub', t => {
  const f = fixture(t), result = f.run();
  assertStatus(result, 'passed');
  assert.equal(result.report.parent.number, 40); assert.equal(result.report.parent.state, 'OPEN');
  assert.deepEqual(result.report.issues.map(entry => [entry.number, entry.parent]),
    [[41, `${repository}#40`], [42, `${repository}#41`]]);
  assert.deepEqual(result.report.pullRequests.map(pr => [pr.pullRequest.number, pr.linkedIssues]), [[56, [41, 42]]]);
  assert.equal(result.report.pullRequests[0].reviewThreads[0].comments[0].path, 'src/main.ts');
  assert.equal(result.report.pullRequests[0].cloudReviews[0].commit_sha, head);
  assert.deepEqual(result.report.warnings, []);
  assert.ok(result.calls.every(args => ['repo view', 'api graphql'].includes(args.slice(0, 2).join(' '))));
  assert.ok(result.calls.filter(args => args[0] === 'api').every(args => args.find(value => value.startsWith('query='))?.startsWith('query=query(')));
  assert.equal(result.stdout.trim().split('\n').length, 1); assert.ok(result.stdout.length < 500);
  assert.ok(!result.stdout.includes('Full evidence')); assert.match(result.stdout, /验收语义未判断/);
  assert.deepEqual(JSON.parse(readFileSync(result.reportPath)), result.report);
});

test('explicit links recover historical PR associations and deduplicate an existing native link', t => {
  const f = fixture(t);
  f.data.pages['issue:42:closedByPullRequestsReferences'] = [page()];
  const missing = f.run(); assertStatus(missing, 'attention');
  assert.ok(missing.report.warnings.some(message => /42.*PR|42.*关联/.test(message)));
  const linked = f.run({ args: ['--link', '42:56', '--link', '41:56'] });
  assertStatus(linked, 'passed');
  assert.deepEqual(linked.report.issues.map(entry => entry.pullRequests.map(pr => pr.origin)), [['github'], ['explicit']]);
  assert.equal(linked.report.pullRequests.length, 1);
});

test('a link outside the parent Spec fails rather than expanding the requested scope', t => {
  const f = fixture(t), result = f.run({ args: ['--link', '99:56'] });
  assertStatus(result, 'failed'); assert.match(result.report.errors.join('\n'), /99.*子工单/);
});

test('every connection is paginated, including nested review comments and closing references', t => {
  const f = fixture(t);
  const child = issue(43); f.data.issues[43] = child;
  f.data.pages['issue:43:subIssues'] = [page()]; f.data.pages['issue:43:comments'] = [page()];
  f.data.pages['issue:43:closedByPullRequestsReferences'] = [page([prReference(56)])];
  f.data.pages['issue:40:subIssues'] = [page([f.data.issues[41]], 2, 'page-1'), page([child], 2)];
  f.data.pages['issue:40:comments'] = [page([comment('spec-1')], 2, 'page-1'), page([comment('spec-2')], 2)];
  const secondPr = { ...f.data.prs[56], id: 'PR_57', number: 57, url: `https://github.com/${repository}/pull/57` };
  f.data.prs[57] = secondPr; f.data.rollups[57] = f.data.rollups[56];
  for (const name of ['comments', 'reviews', 'reviewThreads', 'contexts']) f.data.pages[`pr:57:${name}`] = structuredClone(f.data.pages[`pr:56:${name}`]);
  f.data.pages['pr:57:closingIssuesReferences'] = [page([reference(41)])];
  f.data.pages['issue:41:closedByPullRequestsReferences'] = [page([prReference(56)], 2, 'page-1'), page([prReference(57)], 2)];
  f.data.pages['pr:56:closingIssuesReferences'] = [page([reference(41)], 3, 'page-1'), page([reference(42), reference(43)], 3)];
  f.data.pages['pr:56:comments'] = [page([comment('pr-comment')], 2, 'page-1'), page([cloud()], 2)];
  const review = f.data.pages['pr:56:reviews'][0].nodes[0];
  f.data.pages['pr:56:reviews'] = [page([review], 2, 'page-1'), page([{ ...review, id: 'REVIEW_2' }], 2)];
  const thread = { id: 'THREAD_2', isResolved: true, isOutdated: false };
  f.data.threads.THREAD_2 = thread; f.data.pages['thread:THREAD_2:comments'] = [page([comment('thread-2')])];
  f.data.pages['pr:56:reviewThreads'] = [page([f.data.threads.THREAD_1], 2, 'page-1'), page([thread], 2)];
  f.data.pages['thread:THREAD_1:comments'] = [page([comment('inline-1')], 2, 'page-1'), page([comment('inline-2')], 2)];
  const [check, status] = f.data.pages['pr:56:contexts'][0].nodes;
  f.data.pages['pr:56:contexts'] = [page([check], 2, 'page-1'), page([status], 2)];
  const result = f.run(); assertStatus(result, 'passed');
  assert.deepEqual(result.report.issues.map(entry => entry.number), [41, 42, 43]);
  assert.equal(result.report.parent.comments.length, 2);
  const pr = result.report.pullRequests.find(record => record.pullRequest.number === 56);
  assert.equal(pr.comments.length, 2); assert.equal(pr.reviews.length, 2); assert.equal(pr.reviewThreads.length, 2);
  assert.equal(pr.reviewThreads[0].comments.length, 2); assert.equal(pr.ci.checks.length, 2);
  assert.deepEqual(pr.closingIssues, [41, 42, 43].map(number => `${repository}#${number}`));
  assert.equal(result.report.pullRequests.length, 2);
  const paginated = result.calls.filter(args => args.includes('cursor=page-1')).map(args => args.find(value => value.startsWith('query=')));
  for (const name of ['subIssues', 'closedByPullRequestsReferences', 'closingIssuesReferences', 'reviews', 'reviewThreads', 'contexts']) {
    assert.ok(paginated.some(query => query.includes(`${name}(first:`)), `${name} was not paginated`);
  }
  assert.ok(paginated.some(query => query.includes('node(id:$id)')));
});

for (const [name, mutate] of [
  ['missing later page', data => { data.pages['issue:40:subIssues'][0].pageInfo = { hasNextPage: true, endCursor: 'page-1' }; }],
  ['incomplete declared total', data => { data.pages['pr:56:comments'][0].totalCount++; }],
  ['missing cursor', data => { data.pages['pr:56:comments'][0].pageInfo = { hasNextPage: true }; }],
  ['repeated cursor', data => { data.pages['pr:56:comments'] = [page([comment('first')], 3, 'page-1'), page([comment('second')], 3, 'page-1')]; }],
  ['duplicate identity', data => { data.pages['pr:56:comments'] = [page([comment('same')], 2, 'page-1'), page([comment('same')], 2)]; }],
  ['wrong total type', data => { data.pages['pr:56:contexts'][0].totalCount = '2'; }],
  ['invalid CI rollup state', data => { data.rollups[56].state = 'unexpected'; }],
  ['wrong thread flag type', data => { data.pages['pr:56:reviewThreads'][0].nodes[0].isResolved = 'true'; }],
  ['partial GraphQL errors', data => { data.errors['issue:40:subIssues'] = [{ message: 'Partial response' }]; }],
  ['wrong GraphQL errors type', data => { data.errors['issue:40:subIssues'] = { message: 'Partial response' }; }],
  ['wrong PR GraphQL errors type', data => { data.errors['pr:56:closingIssuesReferences'] = { message: 'Partial response' }; }],
  ['non-object GraphQL data', data => { data.overrides['issue:40:subIssues'] = { data: 1 }; }],
  ['issue changes during audit', data => { data.overrides['issue:41:comments'] = { data: { repository: {
    nameWithOwner: repository, defaultBranchRef: data.defaultBranchRef,
    issue: { ...data.issues[41], updatedAt: '2026-11-09T02:00:00Z', comments: page() },
  } } }; }],
  ['PR head changes during audit', data => { data.overrides['pr:56:comments'] = { data: { repository: {
    pullRequest: { ...data.prs[56], headRefOid: previous, comments: data.pages['pr:56:comments'][0] },
  } } }; }],
  ['invalid JSON', data => { data.invalidJson['issue:40:subIssues'] = true; }],
  ['failed gh read', data => { data.failures['issue:40:subIssues'] = true; }],
  ['cyclic sub-issue graph', data => { data.pages['issue:42:subIssues'] = [page([data.issues[40]])]; }],
]) {
  test(`incomplete or malformed reads fail closed: ${name}`, t => {
    const f = fixture(t); mutate(f.data);
    const result = f.run(); assertStatus(result, 'failed');
    assert.ok(result.report.errors.length > 0); assert.ok(result.stdout.length < 500);
  });
}

for (const [name, mutate, expected] of [
  ['failed CI rollup', data => { data.rollups[56].state = 'FAILURE'; }, /FAILURE/],
  ['pending CI rollup', data => { data.rollups[56].state = 'PENDING'; }, /PENDING/],
  ['pending CI', data => { const check = data.pages['pr:56:contexts'][0].nodes[0]; check.status = 'IN_PROGRESS'; check.conclusion = null; }, /IN_PROGRESS/],
  ['skipped CI', data => { data.pages['pr:56:contexts'][0].nodes[0].conclusion = 'SKIPPED'; }, /SKIPPED/],
  ['missing CI', data => { data.rollups[56] = null; }, /CI/],
  ['old CI commit', data => { data.rollups[56].commit.oid = previous; }, /CI.*提交/],
  ['pending status context', data => { data.pages['pr:56:contexts'][0].nodes[1].state = 'PENDING'; }, /PENDING/],
  ['missing cloud review', data => { data.pages['pr:56:comments'] = [page([comment('human')])]; }, /云端.*审查/],
  ['old cloud review commit', data => { data.pages['pr:56:comments'] = [page([cloud('old', { commit_sha: previous })])]; }, /云端审查覆盖/],
  ['running cloud review', data => { data.pages['pr:56:comments'] = [page([cloud('running', { status: 'in_progress' })])]; }, /未完成/],
  ['unresolved cloud finding', data => { data.pages['pr:56:comments'] = [page([cloud('finding', { has_any_findings: true, has_unresolved_findings: true })])]; }, /findings/],
  ['unresolved inline thread', data => { data.threads.THREAD_1.isResolved = false; }, /未解决.*审查讨论/],
  ['open child issue', data => { data.issues[42].state = 'OPEN'; data.issues[42].stateReason = null; }, /42.*completed/],
  ['unmerged PR', data => { data.prs[56].state = 'OPEN'; data.prs[56].mergeCommit = null; }, /合并/],
]) {
  test(`reports attention without claiming acceptance: ${name}`, t => {
    const f = fixture(t); mutate(f.data);
    const result = f.run(); assertStatus(result, 'attention');
    assert.match(result.report.warnings.join('\n'), expected); assert.deepEqual(result.report.errors, []);
  });
}

test('a child issue reopened after PR CI is read invalidates the earlier completed snapshot', t => {
  const f = fixture(t);
  const reopened = { ...f.data.issues[42], state: 'OPEN', stateReason: null, updatedAt: '2026-11-09T02:00:00Z' };
  f.data.afterResponse['pr:56:contexts'] = [
    { path: ['issues', '42'], value: reopened },
    { path: ['pages', 'issue:41:subIssues', 0, 'nodes', 0], value: reopened },
  ];
  const result = f.run();
  assert.equal(result.state.issues[42].state, 'OPEN');
  assert.equal(Object.hasOwn(result.state.afterResponse, 'pr:56:contexts'), false);
  assertStatus(result, 'failed');
  assert.match(result.report.errors.join('\n'), /工单.*审计期间发生变化/);
});

test('a deeper sub-issue added after PR CI is read invalidates the earlier hierarchy snapshot', t => {
  const f = fixture(t), added = { ...issue(43), state: 'OPEN', stateReason: null };
  f.data.afterResponse['pr:56:contexts'] = [
    { path: ['issues', '43'], value: added },
    { path: ['pages', 'issue:42:subIssues'], value: [page([added])] },
  ];
  const result = f.run();
  assert.deepEqual(result.state.pages['issue:42:subIssues'][0].nodes.map(record => record.number), [43]);
  assert.equal(Object.hasOwn(result.state.afterResponse, 'pr:56:contexts'), false);
  assertStatus(result, 'failed');
  assert.match(result.report.errors.join('\n'), /42.*子工单关系.*审计期间发生变化/);
});

test('a current completed Codex summary supersedes an earlier review of another commit', t => {
  const f = fixture(t);
  const old = { ...cloud('old', { commit_sha: previous, has_any_findings: true, has_unresolved_findings: true }),
    createdAt: '2026-11-08T01:00:00Z', updatedAt: '2026-11-08T01:00:00Z' };
  f.data.pages['pr:56:comments'] = [page([old, cloud('current')])];
  const result = f.run(); assertStatus(result, 'passed');
  assert.equal(result.report.pullRequests[0].comments.length, 2);
  assert.deepEqual(result.report.warnings, []);
});

test('valid local evidence is included with its source identity, scope and counts without changing it', t => {
  const f = fixture(t);
  const before = readdirSync(f.evidenceDirectory).sort().map(name => [name, readFileSync(join(f.evidenceDirectory, name), 'utf8')]);
  const result = f.run(); assertStatus(result, 'passed');
  const record = result.report.evidence[0];
  assert.equal(record.source.commit, head); assert.equal(record.scope, 'check-only');
  assert.equal(record.steps[0].tests, 3); assert.equal(record.files.checked, 2);
  assert.deepEqual(readdirSync(f.evidenceDirectory).sort().map(name => [name, readFileSync(join(f.evidenceDirectory, name), 'utf8')]), before);
});

test('missing evidence requires attention even when all GitHub delivery checks pass', t => {
  const f = fixture(t), result = f.run({ withEvidence: false });
  assertStatus(result, 'attention'); assert.deepEqual(result.report.evidence, []);
  assert.match(result.report.warnings.join('\n'), /未提供.*证据/);
});

test('a Spec with no native child issues requires attention even with valid local evidence', t => {
  const f = fixture(t); f.data.pages['issue:40:subIssues'] = [page()];
  const result = f.run(); assertStatus(result, 'attention');
  assert.deepEqual(result.report.issues, []); assert.deepEqual(result.report.pullRequests, []);
  assert.match(result.report.warnings.join('\n'), /没有子工单/);
});

test('damaged evidence and an intact failed run remain distinguishable in a combined report', t => {
  const f = fixture(t), failed = evidence(join(f.directory, 'failed-evidence'), { status: 'failed' });
  writeFileSync(join(f.evidenceDirectory, 'check.log'), 'tampered');
  const result = f.run({ args: ['--evidence', failed] }); assertStatus(result, 'attention');
  assert.deepEqual(result.report.evidence.map(record => [record.status, record.integrityStatus, record.verificationStatus]),
    [['failed', 'failed', 'passed'], ['failed', 'passed', 'failed']]);
  assert.equal(result.report.warnings.filter(message => /本地证据/.test(message)).length, 2);
});

test('the CLI refuses to replace a report or create output inside source evidence', t => {
  const f = fixture(t), first = f.run(); assertStatus(first, 'passed');
  const bytes = readFileSync(first.reportPath, 'utf8');
  const repeat = f.run({ output: first.output });
  assert.equal(repeat.code, 1); assert.deepEqual(repeat.calls, []);
  assert.equal(readFileSync(first.reportPath, 'utf8'), bytes);
  const nested = join(f.evidenceDirectory, 'nested-output');
  const unsafe = f.run({ output: nested });
  assert.equal(unsafe.code, 1); assert.deepEqual(unsafe.calls, []);
  assert.equal(existsSync(nested), false);
});

test('duplicate evidence paths and filesystem aliases are rejected before creating a report or contacting GitHub', t => {
  const f = fixture(t), alias = join(f.directory, 'evidence-alias');
  symlinkSync(f.evidenceDirectory, alias, 'dir');
  for (const directory of [f.evidenceDirectory, alias]) {
    const result = f.run({ args: ['--evidence', directory] });
    assert.equal(result.code, 1); assert.deepEqual(result.calls, []);
    assert.equal(existsSync(result.output), false);
  }
  const nested = join(alias, 'nested-output'), result = f.run({ output: nested });
  assert.equal(result.code, 1); assert.deepEqual(result.calls, []);
  assert.equal(existsSync(nested), false);
});

test('help and malformed arguments make no GitHub requests', t => {
  const f = fixture(t), help = f.run({ rawArgs: ['--help'] });
  assert.equal(help.code, 0); assert.match(help.stdout, /--spec/); assert.deepEqual(help.calls, []);
  for (const rawArgs of [[], ['--spec', '0', '--out', join(f.directory, 'invalid')],
    ['--spec', '40'], ['--spec', '40', '--out', join(f.directory, 'invalid'), '--repo', 'owner/repo/extra'],
    ['--spec', '40', '--out', join(f.directory, 'invalid'), '--link', '41'],
    ['--spec', '40', '--out', join(f.directory, 'invalid'), '--link', '41:56', '--link', '41:56']]) {
    const result = f.run({ rawArgs }); assert.equal(result.code, 1); assert.deepEqual(result.calls, []);
  }
});
