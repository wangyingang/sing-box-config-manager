import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    nameWithOwner defaultBranchRef{name}
    pullRequest(number:$number){
      number url state isDraft baseRefName headRefOid mergeCommit{oid}
      closingIssuesReferences(first:100,after:$cursor){
        nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;
export const repositoryName = value => typeof value === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value);
export const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const nonempty = value => typeof value === 'string' && value.length > 0;
export function requireThat(value, message) { if (!value) throw new Error(message); }
export function issueNumber(value, option) {
  requireThat(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)), `${option} 需要正整数编号`);
  return Number(value);
}

export function github(...args) {
  let output;
  try {
    output = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`GitHub 读取失败（gh ${args.slice(0, 2).join(' ')}）：${String(error.stderr || error.message).trim()}`);
  }
  try { return JSON.parse(output); }
  catch { throw new Error(`GitHub 返回无效 JSON（gh ${args.slice(0, 2).join(' ')}）`); }
}

export function readPullRequest(repository, number) {
  const [owner, name] = repository.split('/');
  let snapshot, cursor;
  const seenCursors = new Set(), references = new Set();
  do {
    const response = github('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-F', `number=${number}`, ...(cursor ? ['-f', `cursor=${cursor}`] : []));
    requireThat(response && (response.errors === undefined || (Array.isArray(response.errors) && response.errors.length === 0)), 'GitHub GraphQL 读取失败或仅返回部分结果');
    const repo = response.data?.repository, pr = repo?.pullRequest;
    requireThat(repositoryName(repo?.nameWithOwner) && repo.nameWithOwner.toLowerCase() === repository.toLowerCase()
      && nonempty(repo.defaultBranchRef?.name), '无法确认仓库身份或默认分支');
    requireThat(pr?.number === number && nonempty(pr.url) && ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
      && typeof pr.isDraft === 'boolean' && nonempty(pr.baseRefName) && commitId(pr.headRefOid)
      && (pr.mergeCommit === null || commitId(pr.mergeCommit?.oid)), 'PR 不存在或返回数据不完整');
    const current = { repository: repo.nameWithOwner, defaultBranch: repo.defaultBranchRef.name,
      pullRequest: { number: pr.number, url: pr.url, state: pr.state, draft: pr.isDraft,
        baseBranch: pr.baseRefName, headCommit: pr.headRefOid, mergeCommit: pr.mergeCommit?.oid ?? null } };
    requireThat(!snapshot || isDeepStrictEqual(snapshot, current), '分页期间 PR 或默认分支发生变化，请重试');
    snapshot = current;
    const connection = pr.closingIssuesReferences;
    requireThat(Array.isArray(connection?.nodes) && typeof connection.pageInfo?.hasNextPage === 'boolean', '自动关闭关联的分页数据不完整');
    for (const issue of connection.nodes) {
      requireThat(Number.isSafeInteger(issue?.number) && issue.number > 0 && repositoryName(issue.repository?.nameWithOwner), '自动关闭关联缺少工单身份');
      references.add(`${issue.repository.nameWithOwner.toLowerCase()}#${issue.number}`);
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
    if (connection.pageInfo.hasNextPage) {
      requireThat(nonempty(cursor) && !seenCursors.has(cursor), '自动关闭关联的分页游标缺失或重复');
      seenCursors.add(cursor);
    }
  } while (cursor);
  return { ...snapshot, closingIssues: [...references].sort() };
}

export function readIssue(repository, number) {
  const issue = github('issue', 'view', String(number), '--repo', repository, '--json', 'number,url,state,stateReason');
  requireThat(issue?.number === number && nonempty(issue.url) && ['OPEN', 'CLOSED'].includes(issue.state)
    && (issue.stateReason === null || typeof issue.stateReason === 'string'), `工单 #${number} 不存在或返回数据不完整`);
  return { number: issue.number, url: issue.url, state: issue.state, stateReason: issue.stateReason };
}

export function deliveryErrors(snapshot, issues, expected, phase) {
  const { pullRequest: pr } = snapshot, errors = [];
  const references = expected.map(number => `${snapshot.repository.toLowerCase()}#${number}`);
  if (pr.baseBranch !== snapshot.defaultBranch) errors.push(`PR 目标为 ${pr.baseBranch}，需要默认分支 ${snapshot.defaultBranch}`);
  for (const reference of snapshot.closingIssues) if (!references.includes(reference)) errors.push(`意外的自动关闭关联：${reference}`);
  if (phase === 'before-merge') {
    if (pr.state !== 'OPEN') errors.push(`PR 状态为 ${pr.state}，合并前需要 OPEN`);
    if (pr.draft) errors.push('PR 仍为草稿');
    for (const reference of references) if (!snapshot.closingIssues.includes(reference)) errors.push(`缺少自动关闭关联：${reference}`);
    for (const issue of issues) if (issue.state !== 'OPEN') errors.push(`工单 #${issue.number} 状态为 ${issue.state}，合并前需要 OPEN`);
  } else {
    if (pr.state !== 'MERGED' || !pr.mergeCommit) errors.push('PR 尚未确认合并，或缺少合并提交');
    for (const issue of issues) {
      if (issue.state !== 'CLOSED' || issue.stateReason !== 'COMPLETED') errors.push(`工单 #${issue.number} 尚未以 completed 关闭：${issue.state}/${issue.stateReason ?? '无原因'}`);
    }
  }
  return errors;
}
