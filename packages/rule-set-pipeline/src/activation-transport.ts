import { ARTIFACT_REPOSITORY, ghJson, githubPublication } from './publication.js';

export interface ActivationTransport {
  readonly branch: string;
  head(): Promise<string>;
  download(url: string): Promise<Buffer>;
  /** Exactly one parent, expectedHead; never rebase or force-push on conflict. */
  commit(expectedHead: string, files: Record<string, Buffer>, message: string): Promise<string>;
}

/** Branch must already exist. Creating a production or acceptance environment is separate. */
export function githubActivation(branch = 'main', request: typeof ghJson = ghJson): ActivationTransport {
  if (!/^[a-zA-Z0-9-]+$/.test(branch) || branch === 'candidates') throw new Error('Invalid activation branch');
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  return {
    branch,
    async head() {
      const repository = await request(['api', `repos/${ARTIFACT_REPOSITORY}`]);
      if (repository.private) throw new Error('Artifact repository must be public');
      const ref = await api(`git/ref/heads/${branch}`);
      if (!/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Invalid remote head');
      return ref.object.sha;
    },
    download: githubPublication(request).download,
    async commit(expectedHead, files, message) {
      if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('Expected full old commit');
      // Recheck immediately before constructing the single-parent update.
      if (await this.head() !== expectedHead) throw new Error('ACTIVATION_CONFLICT: remote head changed');
      const parent = await api(`git/commits/${expectedHead}`);
      const tree = [];
      for (const [path, bytes] of Object.entries(files)) {
        if (!/^stable\/[a-zA-Z0-9/_.-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..' || !part)) throw new Error('Invalid stable path');
        const blob = await api('git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const createdTree = await api('git/trees', { base_tree: parent.tree.sha, tree });
      const commit = await api('git/commits', { message, tree: createdTree.sha, parents: [expectedHead] });
      // The caller knows this identity before PATCH, so even a lost reply can be reconciled.
      try {
        await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'],
          { sha: commit.sha, force: false });
      } catch (error) {
        throw new ActivationWriteError(commit.sha, error);
      }
      return commit.sha;
    },
  };
}
export class ActivationWriteError extends Error {
  constructor(public readonly attemptedCommit: string, cause: unknown) {
    super(`Activation write response uncertain: ${String(cause)}`, { cause });
  }
}
