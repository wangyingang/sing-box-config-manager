#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(process.env.CLOSEOUT_DATA));
const save = () => fs.writeFileSync(process.env.CLOSEOUT_DATA, JSON.stringify(data));
fs.appendFileSync(process.env.CLOSEOUT_CALLS, JSON.stringify(args) + '\n');
const field = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const connection = nodes => ({ totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false } });
const repo = 'example/project';
const pr = () => ({ id: 'pr56', number: 56, url: `https://github.com/${repo}/pull/56`, state: data.merged ? 'MERGED' : 'OPEN',
  isDraft: !!data.draft, baseRefName: 'main', headRefOid: data.head, headRefName: 'codex/test', headRepository: { nameWithOwner: data.fork ?? repo },
  mergeCommit: data.merged ? { oid: data.merge } : null });
let result;
if (args[0] === 'repo' && args[1] === 'view') result = { nameWithOwner: repo };
else if (args[0] === 'api' && args[1] === 'graphql') {
  const query = field('query');
  if (data.failRead) throw new Error('GitHub read unavailable');
  if (query.includes('node(id:')) result = { data: { node: { ...data.threads[0], comments: connection([]) } } };
  else {
    const value = pr();
    if (query.includes('closingIssuesReferences')) {
      if (data.moveOnGuard && (data.prReads ?? 0) > 0) value.headRefOid = 'f'.repeat(40);
      data.prReads = (data.prReads ?? 0) + 1; save();
      value.closingIssuesReferences = { nodes: (data.references ?? [48]).map(number => ({ number, repository: { nameWithOwner: repo } })), pageInfo: { hasNextPage: false } };
    } else if (query.includes('statusCheckRollup')) value.statusCheckRollup = {
      commit: { oid: data.ciHead ?? data.head }, state: data.ciState ?? 'SUCCESS', contexts: connection(data.checks ?? [
        { id: 'ci1', __typename: 'CheckRun', name: 'Workspace checks', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.com/ci' },
      ]),
    };
    else if (query.includes('reviewThreads(')) value.reviewThreads = connection(data.threads ?? []);
    else if (query.includes('reviews(')) value.reviews = connection(data.reviews ?? []);
    else value.comments = connection(data.noCloud ? [] : [{ id: 'cloud', url: 'https://example.com/review', author: { login: 'chatgpt-codex-connector[bot]' },
      createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', body: '<!-- codex-review-state:v1 '+JSON.stringify({ code_review: {
        commit_sha: data.reviewHead ?? data.head, status: data.reviewStatus ?? 'completed', has_any_findings: false, has_unresolved_findings: !!data.findings,
      } })+' -->' }]);
    result = { data: { repository: { nameWithOwner: repo, defaultBranchRef: { name: 'main' }, pullRequest: value } } };
  }
} else if (args[0] === 'issue' && args[1] === 'view') {
  const closed = data.merged && !data.noAutoClose || data.closed;
  result = { number: Number(args[2]), url: `https://github.com/${repo}/issues/${args[2]}`, state: closed ? 'CLOSED' : 'OPEN', stateReason: closed ? 'COMPLETED' : null };
} else if (args[0] === 'run' && args[1] === 'view') result = { headSha: data.runHead ?? data.head, status: 'completed', conclusion: 'success',
  url: 'https://example.com/run', jobs: [{ status: 'completed', conclusion: 'success', name: 'Native sing-box' }] };
else {
  const kind = args.slice(0, 2).join(' ');
  if (data.failWrite === kind) { console.error('write failed or response unknown'); process.exit(1); }
  if (kind === 'pr merge') {
    if (data.queueOnly) { console.log('queued'); process.exit(0); }
    const git = (...argv) => cp.execFileSync('git', ['--git-dir', data.origin, ...argv], { encoding: 'utf8' }).trim();
    data.merge = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit-tree', data.head+'^{tree}', '-p', data.base, '-m', 'merged fixture');
    git('update-ref', 'refs/heads/main', data.merge, data.base); data.merged = true;
    if (data.moveRemote) git('update-ref', 'refs/heads/codex/test', data.merge);
    if (data.injectAfterMerge) fs.writeFileSync(data.injectAfterMerge.path, data.injectAfterMerge.content);
    save();
    if (data.lostMergeResponse) { console.error('response lost after merge'); process.exit(1); }
  } else if (kind === 'issue close') { data.closed = true; save(); }
  else if (kind === 'issue edit') { data.edited = fs.readFileSync(args[args.indexOf('--body-file')+1], 'utf8'); save(); }
  else if (kind === 'pr comment' || kind === 'issue comment') {
    (data.records ??= []).push({ kind, body: fs.readFileSync(args[args.indexOf('--body-file')+1], 'utf8') }); save();
  } else throw new Error('Unexpected gh operation '+JSON.stringify(args));
  console.log('https://example.com/result'); process.exit(0);
}
console.log(JSON.stringify(result));
