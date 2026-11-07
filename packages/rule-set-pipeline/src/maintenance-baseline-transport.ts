import { isDeepStrictEqual } from 'node:util';
import { createGitCommit, githubPublicationRepository, type PublicationSnapshot } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, ghJson, GitHubHttpError } from './publication.js';

export interface BaselineTransport {
  snapshot(ref: string): Promise<PublicationSnapshot | undefined>;
  /** Create an immutable scratch branch, or adopt the exact stage from a prior attempt. */
  stage(ref: string, parent: string | undefined, files: Record<string, Buffer>, message: string): Promise<string>;
}

export type BaselineStage = { ref: string; head: string };
export interface BaselineStages {
  files: BaselineStage;
  metadata: BaselineStage;
  evidence: BaselineStage;
  journal: BaselineStage;
  stable: BaselineStage;
  stableRoot?: BaselineStage;
}
export interface PreparedBaseline {
  stages: BaselineStages;
  verifiedAt: string;
  toolSha256: string;
}

export function stageRef(id: string, step: string) { return `maintenance-${id}-${step}`; }

export function validBaseline(value: unknown, runId: string, shared: boolean) {
  const baseline = value as PreparedBaseline | undefined;
  if (!baseline?.stages || typeof baseline.verifiedAt !== 'string' || !Number.isFinite(Date.parse(baseline.verifiedAt))
    || !/^[a-f0-9]{64}$/.test(baseline.toolSha256)) return false;
  const stages = baseline.stages;
  const refs = { files: 'files', metadata: 'metadata', evidence: 'evidence', journal: 'journal',
    stable: shared ? 'journal' : 'stable', ...(!shared && { stableRoot: 'stable-root' }) };
  return Object.keys(stages).length === Object.keys(refs).length && Object.entries(refs).every(([key, step]) => {
    const stage = stages[key as keyof BaselineStages];
    return stage?.ref === stageRef(runId, step) && /^[a-f0-9]{40}$/.test(stage.head);
  }) && (!shared || isDeepStrictEqual(stages.stable, stages.journal));
}

/** Snapshots may list directory entries as well as files. */
export function filePaths(paths: string[]) {
  const directories = new Set(paths.flatMap(path => {
    const parts = path.split('/');
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
  }));
  return paths.filter(path => !directories.has(path));
}

const fullCommit = (sha: unknown): sha is string => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);
const scratchRef = /^maintenance-[a-f0-9-]{36}-(?:files|metadata|evidence|journal|stable-root|stable)$/;

export function githubBaselineTransport(request: typeof ghJson = ghJson): BaselineTransport {
  const repository = githubPublicationRepository(undefined, request);
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  const snapshot = async (ref: string) => {
    if (!scratchRef.test(ref)) throw new Error('Invalid maintenance scratch ref');
    try { return await repository.snapshot(ref); }
    catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return undefined;
      throw error;
    }
  };
  return { snapshot,
    async stage(ref, parent, files, message) {
      if (!scratchRef.test(ref) || parent !== undefined && !fullCommit(parent)) throw new Error('Invalid baseline stage');
      const base = parent ? await api(`git/commits/${parent}`) : undefined;
      if (parent && !fullCommit(base?.tree?.sha)) throw new Error('Invalid baseline base tree');
      const adopt = async () => {
        const current = await snapshot(ref);
        if (!current) return undefined;
        if (!isDeepStrictEqual(current.parents, parent ? [parent] : [])) throw new Error(`Baseline parent conflict: ${ref}`);
        const expected = new Set(Object.keys(files));
        if (base) {
          const tree = await api(`git/trees/${base.tree.sha}?recursive=1`);
          if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete baseline parent tree');
          for (const entry of tree.tree) {
            if (entry.type === 'tree') continue;
            expected.add(entry.path);
            if (Object.hasOwn(files, entry.path)) continue;
            const inherited = current.entries.get(entry.path);
            if (!inherited || inherited.type !== entry.type || inherited.mode !== entry.mode || inherited.sha !== entry.sha) {
              throw new Error(`Baseline inherited content conflict: ${ref}/${entry.path}`);
            }
          }
        }
        if (!isDeepStrictEqual(new Set(filePaths(current.paths)), expected)) throw new Error(`Baseline tree conflict: ${ref}`);
        for (const [path, bytes] of Object.entries(files)) {
          if (!(await current.read(path))?.equals(bytes)) throw new Error(`Baseline content conflict: ${ref}/${path}`);
        }
        return current.head;
      };
      const existing = await adopt();
      if (existing) return existing;
      const commit = await createGitCommit(api, files, message, parent ? { head: parent, tree: base.tree.sha } : undefined);
      try {
        await api('git/refs', { ref: `refs/heads/${ref}`, sha: commit });
      } catch (error) {
        const recovered = await adopt();
        if (recovered) return recovered;
        throw error;
      }
      return commit;
    },
  };
}
