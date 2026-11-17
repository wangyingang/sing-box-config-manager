import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { requireThat } from './github-delivery.mjs';

export function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
export function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function remoteRepository(value) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/.exec(value);
  return match?.[1].toLowerCase();
}
function registeredWorktrees(directory) {
  return git(directory, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map(record => {
    const fields = Object.fromEntries(record.split('\0').filter(Boolean).map(field => {
      const index = field.indexOf(' '); return [index < 0 ? field : field.slice(0, index), index < 0 ? true : field.slice(index + 1)];
    }));
    return { path: fields.worktree, head: fields.HEAD, branch: fields.branch, locked: !!fields.locked };
  });
}
export function assertClean(directory) {
  requireThat(git(directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all') === '', `工作区有未提交或未跟踪文件：${directory}`);
}

export async function inspectWorkspace(options, snapshot, output) {
  if (!options.cleanup && !options.syncMain) return undefined;
  const main = await realpath(options.mainWorktree);
  requireThat(git(main, 'rev-parse', '--show-toplevel') === main, 'main-worktree 必须指向工作区根目录');
  requireThat(remoteRepository(git(main, 'config', '--get', 'remote.origin.url')) === snapshot.repository.toLowerCase(), 'origin 与 PR 仓库身份不同');
  requireThat(git(main, 'branch', '--show-current') === snapshot.defaultBranch, '保留工作区当前分支不是默认分支');
  assertClean(main);
  const workspaces = registeredWorktrees(main);
  const canonicalOutput = resolve(await realpath(dirname(output)), relative(dirname(output), output));
  const state = { main, repository: snapshot.repository, branch: snapshot.pullRequest.headBranch, defaultBranch: snapshot.defaultBranch };
  if (options.cleanup) {
    const task = await realpath(options.taskWorktree);
    requireThat(task !== main && !contains(task, main) && !contains(main, task), '任务与保留工作区必须是互不嵌套的独立 worktree');
    requireThat(!contains(task, canonicalOutput) && !contains(task, await realpath(process.cwd())), '输出目录和执行目录须位于待删除 worktree 之外');
    requireThat(snapshot.pullRequest.headRepository.toLowerCase() === snapshot.repository.toLowerCase(), '不自动清理 fork 的来源分支');
    requireThat(state.branch !== state.defaultBranch, '不能清理默认分支');
    const registered = workspaces.find(entry => entry.path === task);
    requireThat(registered && registered.branch === `refs/heads/${state.branch}` && !registered.locked, '任务 worktree 的注册、分支或锁定状态不符');
    requireThat(workspaces.filter(entry => entry.branch === registered.branch).length === 1, '任务分支被其他 worktree 使用');
    requireThat(git(task, 'rev-parse', '--show-toplevel') === task, 'task-worktree 必须指向工作区根目录');
    state.task = task;
    git(main, 'check-ref-format', '--branch', state.branch);
    requireThat(await realpath(resolve(task, git(task, 'rev-parse', '--git-common-dir'))) === await realpath(resolve(main, git(main, 'rev-parse', '--git-common-dir'))), '任务 worktree 不属于保留工作区的仓库');
    state.evidence = [];
    for (const path of options.evidence) {
      requireThat(!(await lstat(path)).isSymbolicLink(), '证据目录不能是符号链接');
      const source = await realpath(path);
      requireThat(contains(task, source) && source !== task, '清理证据必须来自指定任务 worktree 内的独立目录');
      requireThat(!state.evidence.some(item => contains(item, source) || contains(source, item)), '证据目录不能重复或相互嵌套');
      state.evidence.push(source);
    }
    await assertTask(state, snapshot.pullRequest.headCommit);
  }
  return state;
}

export function assertMain(state) {
  requireThat(remoteRepository(git(state.main, 'config', '--get', 'remote.origin.url')) === state.repository.toLowerCase(), '保留工作区 origin 仓库身份变化');
  requireThat(git(state.main, 'branch', '--show-current') === state.defaultBranch, '保留工作区分支变化');
  assertClean(state.main);
}

// Regenerable outputs are the only ignored files disposable without an archive.
const generated = /^(?:node_modules\/|apps\/web\/node_modules\/|packages\/(?:config-compiler|rule-set-pipeline)\/(?:node_modules\/|dist\/)|packages\/config-compiler\/src\/generated\/validate\.cjs$)/;
export async function assertTask(state, expectedHead) {
  requireThat(remoteRepository(git(state.main, 'config', '--get', 'remote.origin.url')) === state.repository.toLowerCase(), '清理前 origin 仓库身份变化');
  assertClean(state.task);
  const entries = registeredWorktrees(state.main);
  const registered = entries.find(entry => entry.path === state.task);
  requireThat(entries.filter(entry => entry.branch === `refs/heads/${state.branch}`).length === 1, '清理前任务分支被其他 worktree 使用');
  requireThat(await realpath(resolve(state.task, git(state.task, 'rev-parse', '--git-common-dir'))) === await realpath(resolve(state.main, git(state.main, 'rev-parse', '--git-common-dir'))), '清理前任务仓库身份变化');
  requireThat(registered && !registered.locked && registered.branch === `refs/heads/${state.branch}`, '清理前 worktree 归属发生变化');
  requireThat(git(state.task, 'rev-parse', 'HEAD') === expectedHead
    && git(state.main, 'rev-parse', `refs/heads/${state.branch}`) === expectedHead, '任务分支已偏离获准的 PR head');
  for (const path of git(state.task, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    requireThat(generated.test(path) || state.evidence.some(root => contains(root, resolve(state.task, path))), `未归档的 ignored 文件：${path}`);
  }
}

async function inventory(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    requireThat(!entry.isSymbolicLink(), `证据中含符号链接：${path}`);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else {
      requireThat(entry.isFile(), `证据中含非常规文件：${path}`);
      const bytes = await readFile(join(root, path));
      files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function archiveEvidence(state, output) {
  const archives = [];
  for (const [index, source] of state.evidence.entries()) {
    const files = await inventory(source);
    requireThat(files.length > 0, '证据目录为空');
    const destination = join(output, `evidence-${index + 1}`);
    await mkdir(destination, { mode: 0o700 });
    for (const file of files) {
      await mkdir(dirname(join(destination, file.path)), { recursive: true, mode: 0o700 });
      await writeFile(join(destination, file.path), await readFile(join(source, file.path)), { flag: 'wx', mode: 0o600 });
    }
    requireThat(JSON.stringify(await inventory(destination)) === JSON.stringify(files), '归档字节或文件清单不符');
    archives.push({ source, destination, files });
  }
  await writeFile(join(output, 'archives.json'), JSON.stringify(archives, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return archives;
}
export async function verifyArchives(archives) {
  for (const archive of archives) {
    requireThat(JSON.stringify(await inventory(archive.source)) === JSON.stringify(archive.files), '归档后源证据发生变化');
    requireThat(JSON.stringify(await inventory(archive.destination)) === JSON.stringify(archive.files), '归档损坏或缺失');
  }
}
export function remoteHead(directory, branch) {
  const lines = git(directory, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\n').filter(Boolean);
  requireThat(lines.length <= 1, '远端分支读取不完整');
  if (!lines.length) return undefined;
  const [head, ref] = lines[0].split(/\s+/);
  requireThat(/^[a-f0-9]{40}$/.test(head) && ref === `refs/heads/${branch}`, '远端分支身份无效');
  return head;
}
