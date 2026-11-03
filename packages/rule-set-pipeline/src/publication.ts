import { execFile } from 'node:child_process';

export const ARTIFACT_REPOSITORY = 'wangyingang/sing-box-rule-artifacts';
export const PUBLICATION_BRANCH = 'candidates';
export interface PublicationTransport {
  commit(files: Record<string, Buffer>, message: string): Promise<string>;
  download(url: string): Promise<Buffer>;
}

/** Uses the existing gh login; credentials never enter files or published records. */
export function ghJson(args: string[], input?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh failed: ${stderr.trim() || error.message}`));
      else { try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch (error) { reject(error); } }
    });
    if (input !== undefined) child.stdin!.end(JSON.stringify(input));
  });
}
export function immutableUrl(commit: string, path: string): string {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Publication did not return a full commit');
  return `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${commit}/${path}`;
}

export function githubPublication(request: typeof ghJson = ghJson): PublicationTransport {
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}${path ? `/${path}` : ''}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  return {
    async commit(files, message) {
      const repository = await api('');
      if (repository.private) throw new Error('Artifact repository must be public');
      const refs = await api(`git/matching-refs/heads/${PUBLICATION_BRANCH}`);
      let head = refs.find((ref: { ref: string }) => ref.ref === `refs/heads/${PUBLICATION_BRANCH}`)?.object.sha;
      if (!head) {
        const main = await api(`git/ref/heads/${repository.default_branch}`);
        // A concurrent creator causes a safe retry rather than an overwrite.
        const ref = await api('git/refs', { ref: `refs/heads/${PUBLICATION_BRANCH}`, sha: main.object.sha });
        head = ref.object.sha;
      }
      const parent = await api(`git/commits/${head}`);
      const existing = await api(`git/trees/${parent.tree.sha}?recursive=1`);
      if (existing.truncated) throw new Error('Cannot prove candidate paths are new: truncated tree');
      const paths = new Set(existing.tree.map((entry: { path: string }) => entry.path));
      const tree = [];
      for (const [path, content] of Object.entries(files)) {
        // This transport can only append unique candidate paths, never stable files.
        if (!/^candidates\/[a-f0-9-]+\/[a-z0-9.-]+$/.test(path)) throw new Error('Invalid candidate path');
        if (paths.has(path)) throw new Error('Refusing to overwrite a historical candidate file');
        const blob = await api('git/blobs', { content: content.toString('base64'), encoding: 'base64' });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const createdTree = await api('git/trees', { base_tree: parent.tree.sha, tree });
      const commit = await api('git/commits', { message, tree: createdTree.sha, parents: [head] });
      // GitHub rejects a non-fast-forward update if another publisher moved head.
      await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${PUBLICATION_BRANCH}`,
        '--method', 'PATCH', '--input', '-'], { sha: commit.sha, force: false });
      return commit.sha;
    },
    async download(url) {
      if (!url.startsWith(`https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`)) throw new Error('Unexpected readback URL');
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000), cache: 'no-store' });
      if (!response.ok) throw new Error(`Readback HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
