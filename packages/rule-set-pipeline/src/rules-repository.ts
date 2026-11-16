import { createGitCommit, githubPublicationRepository, PublicationWriteError, type PublicationSnapshot } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, ghJson, GitHubHttpError, githubPublication } from './publication.js';

export type RuleWrites = Record<string, Buffer | null>;
export interface RulesRepository {
  readonly branch: string;
  snapshot(branch?: string): Promise<PublicationSnapshot>;
  lastChange(head: string, path: string): Promise<string>;
  /** A guarded single-parent write; null deletes a path from the current tree. */
  commit(branch: string, expectedHead: string, files: RuleWrites, message: string, guard: () => Promise<void>): Promise<string>;
  download(url: string): Promise<Buffer>;
}

export function githubRulesRepository(targetBranch: string, request: typeof ghJson = ghJson): RulesRepository {
  if (targetBranch !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(targetBranch)) throw new Error('Invalid rules target');
  const branch = targetBranch === 'main' ? 'candidates' : targetBranch;
  const reader = githubPublicationRepository(branch, request);
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  return {
    branch,
    snapshot: reader.snapshot,
    lastChange: reader.lastChange,
    download: githubPublication(request, branch).download,
    async commit(target, expectedHead, files, message, guard) {
      if (![branch, targetBranch].includes(target) || !/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('Unapproved write target');
      const current = await reader.snapshot(target);
      if (current.head !== expectedHead) throw new Error('RULE_WRITE_CONFLICT: remote head changed');
      if (!Object.keys(files).length) throw new Error('Empty rules write');
      for (const [path, bytes] of Object.entries(files)) {
        const control = ['pipeline/state.json', 'pipeline/identity.json', 'pipeline/rule-operation.json'].includes(path);
        const candidate = /^candidates\/[a-f0-9-]{36}\/[a-z0-9][a-z0-9.-]*$/.test(path);
        const stable = /^stable\/(?:[a-z0-9][a-z0-9._-]*\/)+(?:activation\.json|(?:route|domains)\.(?:json|srs))$/.test(path);
        if ((!control && !candidate && !stable) || path.split('/').some(part => part === '.' || part === '..')
          || (candidate && target !== branch) || (stable && target !== targetBranch)) throw new Error(`Invalid rules write path: ${path}`);
        if (candidate && bytes && current.paths.includes(path)) throw new Error('Cannot overwrite a retained candidate');
      }
      // Guard before creating objects and again immediately before moving a ref.
      await guard();
      const parent = await api(`git/commits/${expectedHead}`);
      const commit = await createGitCommit(api, files, message, { tree: parent.tree.sha, head: expectedHead });
      await guard();
      try {
        await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${target}`, '--method', 'PATCH', '--input', '-'],
          { sha: commit, force: false });
      } catch (error) {
        if (error instanceof GitHubHttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) throw error;
        throw new PublicationWriteError(commit, error);
      }
      return commit;
    },
  };
}
