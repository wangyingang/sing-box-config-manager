import { isDeepStrictEqual } from 'node:util';
import { github, readPullRequest, deliveryErrors, requireThat, repositoryName, commitId, nonempty } from './github-delivery.mjs';

const pageInfo = 'totalCount pageInfo{hasNextPage endCursor}';
const issueFields = 'id number url title body state stateReason updatedAt repository{nameWithOwner}';
const prFields = 'id number url headRefOid state baseRefName mergeCommit{oid}';
const commentFields = 'id url body author{login} createdAt updatedAt';
const key = node => `${node.repository.nameWithOwner.toLowerCase()}#${node.number}`;

function query(document, variables) {
  const args = Object.entries(variables).filter(([, value]) => value !== undefined)
    .flatMap(([name, value]) => [typeof value === 'number' ? '-F' : '-f', `${name}=${value}`]);
  const response = github('api', 'graphql', '-f', `query=${document}`, ...args);
  requireThat(response?.data && (response.errors === undefined || (Array.isArray(response.errors) && response.errors.length === 0)), 'GitHub GraphQL 返回错误或部分结果');
  return response.data;
}

// A missing page, repeated cursor, duplicate node or changing identity is not an empty result.
export function collectPages(fetchPage, label) {
  let cursor, identity, total;
  const cursors = new Set(), ids = new Set(), items = [];
  do {
    const page = fetchPage(cursor), connection = page.connection;
    requireThat(page.identity && (!identity || isDeepStrictEqual(identity, page.identity)), `${label}：分页期间对象发生变化`);
    identity = page.identity;
    requireThat(Array.isArray(connection?.nodes) && Number.isSafeInteger(connection.totalCount) && connection.totalCount >= 0
      && typeof connection.pageInfo?.hasNextPage === 'boolean', `${label}：分页数据不完整`);
    requireThat(total === undefined || total === connection.totalCount, `${label}：分页期间总数发生变化`);
    total = connection.totalCount;
    for (const node of connection.nodes) {
      requireThat(nonempty(node?.id) && !ids.has(node.id), `${label}：节点身份缺失或重复`);
      ids.add(node.id); items.push(node);
    }
    requireThat(items.length <= total, `${label}：节点数超过声明总数`);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
    if (connection.pageInfo.hasNextPage) {
      requireThat(connection.nodes.length > 0 && nonempty(cursor) && !cursors.has(cursor), `${label}：分页游标缺失或重复`);
      cursors.add(cursor);
    }
  } while (cursor);
  requireThat(items.length === total, `${label}：节点数与声明总数不符`);
  return { identity, items };
}

function issueConnection(repository, number, field, selection, argumentsText = '') {
  const [owner, name] = repository.split('/');
  const document = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$name){nameWithOwner defaultBranchRef{name target{oid}}
      issue(number:$number){${issueFields} ${field}(first:100,after:$cursor${argumentsText}){${pageInfo} nodes{${selection}}}}
    }} `;
  return collectPages(cursor => {
    const repo = query(document, { owner, name, number, cursor }).repository;
    const issue = repo?.issue;
    requireThat(repo?.nameWithOwner?.toLowerCase() === repository.toLowerCase() && nonempty(repo.defaultBranchRef?.name)
      && commitId(repo.defaultBranchRef.target?.oid), '仓库身份或默认分支不完整');
    requireThat(issue?.number === number && nonempty(issue.id) && nonempty(issue.url) && typeof issue.body === 'string'
      && typeof issue.title === 'string' && nonempty(issue.updatedAt) && ['OPEN', 'CLOSED'].includes(issue.state)
      && (issue.stateReason === null || typeof issue.stateReason === 'string')
      && issue.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase(), `工单 ${repository}#${number} 数据不完整`);
    const { [field]: connection, ...record } = issue;
    return { identity: { issue: record, defaultBranch: repo.defaultBranchRef }, connection };
  }, `${repository}#${number} ${field}`);
}

function prIdentity(pr, snapshot) {
  const expected = snapshot.pullRequest;
  requireThat(nonempty(pr?.id) && pr.number === expected.number && pr.url === expected.url
    && pr.headRefOid === expected.headCommit && pr.state === expected.state && pr.baseRefName === expected.baseBranch
    && (pr.mergeCommit?.oid ?? null) === expected.mergeCommit, `PR #${expected.number} 在读取期间发生变化或数据不完整`);
  return { id: pr.id, number: pr.number, head: pr.headRefOid, state: pr.state, base: pr.baseRefName, merge: pr.mergeCommit?.oid ?? null };
}

function prConnection(snapshot, field, selection) {
  const [owner, name] = snapshot.repository.split('/'), number = snapshot.pullRequest.number;
  const document = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$number){${prFields}
      ${field}(first:100,after:$cursor){${pageInfo} nodes{${selection}}}}}}`;
  return collectPages(cursor => {
    const pr = query(document, { owner, name, number, cursor }).repository?.pullRequest;
    return { identity: prIdentity(pr, snapshot), connection: pr[field] };
  }, `${snapshot.repository}#${number} ${field}`).items;
}

function readChecks(snapshot) {
  const [owner, name] = snapshot.repository.split('/'), number = snapshot.pullRequest.number;
  const document = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$number){${prFields}
      statusCheckRollup{commit{oid} state contexts(first:100,after:$cursor){${pageInfo} nodes{
        __typename ... on CheckRun{id name status conclusion detailsUrl}
        ... on StatusContext{id context state targetUrl}
      }}}}}}`;
  let state = null, commit = null;
  const result = collectPages(cursor => {
    const pr = query(document, { owner, name, number, cursor }).repository?.pullRequest;
    const identity = prIdentity(pr, snapshot), rollup = pr.statusCheckRollup;
    requireThat(rollup === null || (commitId(rollup?.commit?.oid)
      && ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'].includes(rollup.state)), 'CI 汇总数据不完整');
    commit = rollup?.commit.oid ?? null; state = rollup?.state ?? null;
    return { identity: { ...identity, commit, state }, connection: rollup?.contexts ?? { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } };
  }, `PR #${number} CI`);
  for (const check of result.items) {
    requireThat((check.__typename === 'CheckRun' && nonempty(check.name) && nonempty(check.status)
      && (check.conclusion === null || nonempty(check.conclusion))) || (check.__typename === 'StatusContext'
      && nonempty(check.context) && nonempty(check.state)), `PR #${number} CI 节点数据不完整`);
  }
  return { commit, state, checks: result.items };
}

function readThreadComments(thread) {
  return collectPages(cursor => {
    const node = query(`query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{
      id isResolved isOutdated comments(first:100,after:$cursor){${pageInfo} nodes{
        ${commentFields} originalCommit{oid} commit{oid} path line
      }}}}}`, { id: thread.id, cursor }).node;
    requireThat(node?.id === thread.id && node.isResolved === thread.isResolved && node.isOutdated === thread.isOutdated,
      '审查讨论在读取期间发生变化或数据不完整');
    return { identity: thread, connection: node.comments };
  }, `审查讨论 ${thread.id}`).items;
}

function validateComments(comments) {
  for (const comment of comments) requireThat(typeof comment.body === 'string' && nonempty(comment.url)
    && (comment.author === null || nonempty(comment.author?.login)), '评论数据不完整');
}

function cloudReviews(comments) {
  const records = [];
  for (const comment of comments) {
    if (!['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]'].includes(comment.author?.login)) continue;
    const match = /<!-- codex-review-state:v1 ([\s\S]*?) -->/.exec(comment.body);
    if (!match) continue;
    let state;
    try { state = JSON.parse(match[1]).code_review; }
    catch { throw new Error(`Codex 审查摘要 JSON 无效：${comment.url}`); }
    requireThat(state && (state.commit_sha === null || commitId(state.commit_sha))
      && (state.status === null || nonempty(state.status)), `Codex 审查摘要不完整：${comment.url}`);
    if (state.status === 'completed') requireThat(commitId(state.commit_sha) && typeof state.has_any_findings === 'boolean'
      && typeof state.has_unresolved_findings === 'boolean', `已完成审查缺少提交或 findings 状态：${comment.url}`);
    requireThat(nonempty(comment.updatedAt) && Number.isFinite(Date.parse(comment.updatedAt)), 'Codex 审查摘要缺少有效更新时间');
    records.push({ url: comment.url, updatedAt: comment.updatedAt, ...state });
  }
  return records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function auditPullRequest(repository, number, issues) {
  const snapshot = readPullRequest(repository, number);
  const expected = issues.map(issue => issue.number);
  const comments = prConnection(snapshot, 'comments', commentFields);
  validateComments(comments);
  const reviews = prConnection(snapshot, 'reviews', 'id url body state author{login} commit{oid} submittedAt');
  for (const review of reviews) requireThat(typeof review.body === 'string' && nonempty(review.state)
    && nonempty(review.url) && (review.commit === null || commitId(review.commit?.oid)), '审查正文数据不完整');
  const threads = prConnection(snapshot, 'reviewThreads', 'id isResolved isOutdated');
  for (const thread of threads) {
    requireThat(typeof thread.isResolved === 'boolean' && typeof thread.isOutdated === 'boolean', '审查讨论数据不完整');
    thread.comments = readThreadComments(thread); validateComments(thread.comments);
  }
  const ci = readChecks(snapshot), cloud = cloudReviews(comments);
  requireThat(isDeepStrictEqual(snapshot, readPullRequest(repository, number)), `PR #${number} 在审计期间发生变化，请重试`);
  const warnings = deliveryErrors(snapshot, issues, expected, 'after-merge');
  if (!ci.checks.length) warnings.push('没有可核对的 CI 检查');
  if (ci.state !== null && ci.state !== 'SUCCESS') warnings.push(`CI 汇总状态：${ci.state}`);
  if (ci.commit !== null && ci.commit !== snapshot.pullRequest.headCommit) warnings.push('CI 对应提交与 PR head 不同');
  for (const check of ci.checks) {
    if (check.__typename === 'CheckRun' && (check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS'))
      warnings.push(`CI ${check.name}：${check.status}/${check.conclusion ?? '无结论'}`);
    if (check.__typename === 'StatusContext' && check.state !== 'SUCCESS') warnings.push(`CI ${check.context}：${check.state}`);
  }
  if (!cloud.length) warnings.push('没有可解析的云端 Codex 审查记录');
  for (const review of cloud.slice(0, 1)) {
    if (review.status !== 'completed') warnings.push(`云端审查未完成：${review.status ?? '未开始'}`);
    if (review.commit_sha !== snapshot.pullRequest.headCommit) warnings.push(`云端审查覆盖 ${review.commit_sha ?? '未知提交'}，不同于 PR head ${snapshot.pullRequest.headCommit}`);
    if (review.has_unresolved_findings) warnings.push('云端审查仍有未解决 findings');
  }
  if (threads.some(thread => !thread.isResolved)) warnings.push('存在未解决的行内审查讨论');
  if (reviews.some(review => review.state === 'CHANGES_REQUESTED')) warnings.push('存在请求修改的审查记录，需要核对后续处理');
  return { ...snapshot, linkedIssues: issues.map(issue => issue.number), comments, reviews, reviewThreads: threads, cloudReviews: cloud, ci, warnings };
}

export function auditSpec(repository, number, links = []) {
  const issues = [], pullRequests = [], visited = new Set();
  const issueByKey = new Map(), prIssues = new Map(), issueSnapshots = new Map();
  let parent, defaultBranch;
  function visit(repo, n, ancestry = []) {
    const identityKey = `${repo.toLowerCase()}#${n}`;
    requireThat(!ancestry.includes(identityKey), '子工单关系包含循环');
    if (visited.has(identityKey)) return;
    visited.add(identityKey);
    const children = issueConnection(repo, n, 'subIssues', `${issueFields}`);
    issueSnapshots.set(identityKey, { repository: repo, number: n, children });
    const record = { ...children.identity.issue, parent: ancestry.at(-1) ?? null, children: children.items.map(key) };
    const comments = issueConnection(repo, n, 'comments', commentFields);
    requireThat(isDeepStrictEqual(children.identity.issue, comments.identity.issue), `工单 ${identityKey} 在审计期间发生变化`);
    validateComments(comments.items); record.comments = comments.items;
    if (!parent) { parent = record; defaultBranch = children.identity.defaultBranch; }
    else {
      const refs = issueConnection(repo, n, 'closedByPullRequestsReferences', 'id number url repository{nameWithOwner}', ',includeClosedPrs:true');
      requireThat(isDeepStrictEqual(children.identity.issue, refs.identity.issue), `工单 ${identityKey} 在审计期间发生变化`);
      record.pullRequests = refs.items.map(pr => {
        requireThat(Number.isSafeInteger(pr.number) && pr.number > 0 && repositoryName(pr.repository?.nameWithOwner) && nonempty(pr.url), '关联 PR 身份不完整');
        return { repository: pr.repository.nameWithOwner, number: pr.number, origin: 'github' };
      });
      for (const link of links.filter(link => repo.toLowerCase() === repository.toLowerCase() && link.issue === n)) {
        if (!record.pullRequests.some(pr => pr.repository.toLowerCase() === repository.toLowerCase() && pr.number === link.pr))
          record.pullRequests.push({ repository, number: link.pr, origin: 'explicit' });
      }
      issues.push(record); issueByKey.set(identityKey, record);
    }
    for (const child of children.items) {
      requireThat(repositoryName(child.repository?.nameWithOwner) && Number.isSafeInteger(child.number) && child.number > 0, '子工单身份不完整');
      visit(child.repository.nameWithOwner, child.number, [...ancestry, identityKey]);
    }
  }
  visit(repository, number);
  for (const link of links) requireThat(issueByKey.has(`${repository.toLowerCase()}#${link.issue}`), `显式关联的 #${link.issue} 不是父 Spec 的子工单`);
  const warnings = [];
  if (!issues.length) warnings.push('父 Spec 没有子工单，无法据此确认交付');
  for (const issue of issues) {
    if (issue.state !== 'CLOSED' || issue.stateReason !== 'COMPLETED') warnings.push(`${key(issue)} 尚未以 completed 关闭`);
    if (!issue.pullRequests.length) warnings.push(`${key(issue)} 缺少可核对的 PR 关联；可用 --link <issue>:<pr> 显式补充`);
    for (const pr of issue.pullRequests) {
      requireThat(pr.repository.toLowerCase() === issue.repository.nameWithOwner.toLowerCase(), '暂不支持跨仓库的工单与 PR 关闭关联，请单独核对');
      const id = `${pr.repository.toLowerCase()}#${pr.number}`;
      if (!prIssues.has(id)) prIssues.set(id, { ...pr, issues: [] });
      prIssues.get(id).issues.push(issue);
    }
  }
  for (const pr of prIssues.values()) {
    const result = auditPullRequest(pr.repository, pr.number, pr.issues);
    pullRequests.push(result);
    warnings.push(...result.warnings.map(warning => `${pr.repository}#${pr.number}：${warning}`));
  }
  for (const [identityKey, snapshot] of issueSnapshots) {
    const current = issueConnection(snapshot.repository, snapshot.number, 'subIssues', issueFields);
    requireThat(isDeepStrictEqual(current, snapshot.children), `工单 ${identityKey} 或子工单关系在审计期间发生变化，请重试`);
  }
  return { repository, parent, defaultBranch, issues, pullRequests, warnings, acceptance: 'not-evaluated' };
}
