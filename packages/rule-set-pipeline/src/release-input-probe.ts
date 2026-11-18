import { fullGitCommit } from './github-commit.js';
import { readReleaseInput, sha256, validReleaseAssetIdentities, type ReleaseInput, type ReleaseOptions } from './release.js';
import type { SourceRecord } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const assetDigest = ({ digest, state }: Record<string, unknown>) => state === 'uploaded'
  && typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest) ? digest.slice(7) : undefined;

function releaseAssets(input: ReleaseInput, tag: string, metadata: Record<string, unknown>) {
  const { id, assets } = metadata;
  if (!tag || tag.toLowerCase() === 'latest' || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0
    || !Array.isArray(assets) || !assets.every(object)) return;
  const files = assets.filter(asset => asset.name === input.input.asset);
  const checksums = assets.filter(asset => asset.name === input.input.checksum);
  if (files.length !== 1 || checksums.length !== 1 || files[0].id === checksums[0].id) return;
  const identity = (asset: Record<string, unknown>) => ({
    id: asset.id as number, name: asset.name as string, url: asset.browser_download_url as string,
  });
  const pinned = { repository: input.repository, releaseId: id, tag, yaml: identity(files[0]), checksum: identity(checksums[0]) };
  if (!validReleaseAssetIdentities(pinned, input)) return;
  return { pinned, inputDigest: assetDigest(files[0]), checksumDigest: assetDigest(checksums[0]) };
}

/** Optional evidence only. Incomplete metadata leaves all validation to readReleaseInput. */
export function probeReleaseInput(input: ReleaseInput, options: ReleaseOptions & { releaseMetadata: Record<string, unknown> }) {
  const assets = releaseAssets(input, options.tag, options.releaseMetadata);
  const fetcher = options.fetch ?? fetch;
  const base = `https://api.github.com/repos/${input.repository}`;
  const headers = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
  const checksumUrl = assets && `${base}/releases/assets/${assets.pinned.checksum.id}`;
  let tag: { commit: string; refs: Map<string, Record<string, unknown>> } | undefined;
  let checksumBytes: Uint8Array<ArrayBuffer> | undefined;
  const get = (url: string, accept: string) => fetcher(url, { headers: { Accept: accept, ...headers }, signal: AbortSignal.timeout(120_000) });

  async function resolveTag() {
    const refs = new Map<string, Record<string, unknown>>();
    async function readRef(path: string) {
      const url = `${base}/${path}`;
      const response = await get(url, 'application/vnd.github+json');
      if (!response.ok) return;
      const value: unknown = await response.json();
      if (object(value) && object(value.object)) {
        refs.set(url, value);
        return value.object;
      }
    }
    let ref = await readRef(`git/ref/tags/${encodeURIComponent(options.tag)}`);
    const seen = new Set<string>();
    while (ref?.type === 'tag' && fullGitCommit(ref.sha) && !seen.has(ref.sha) && seen.size < 16) {
      seen.add(ref.sha);
      ref = await readRef(`git/tags/${ref.sha}`);
    }
    if (ref?.type === 'commit' && fullGitCommit(ref.sha)) return { commit: ref.sha, refs };
  }

  async function readChecksumDigest() {
    if (!checksumUrl) return;
    if (!checksumBytes) {
      const response = await get(checksumUrl, 'application/octet-stream');
      if (!response.ok) return;
      checksumBytes = new Uint8Array(await response.arrayBuffer());
    }
    return sha256(checksumBytes);
  }

  return {
    async unchanged(previous: SourceRecord): Promise<SourceRecord | undefined> {
      if (!assets || !assets.inputDigest || assets.inputDigest !== previous.inputSha256
        || assets.pinned.repository !== previous.repository) return;
      try {
        const checksumSha256 = assets.checksumDigest ?? await readChecksumDigest();
        if (checksumSha256 !== previous.checksumSha256) return;
        tag ??= await resolveTag();
        if (!tag) return;
        return { ...assets.pinned, commit: tag.commit, inputSha256: previous.inputSha256, inputBytes: previous.inputBytes, checksumSha256 };
      } catch {
        // Retry any failed fetch the checked body reader needs.
        return undefined;
      }
    },
    read() {
      return readReleaseInput({ ...options, fetch: async (address, init) => {
        const url = String(address);
        const accept = new Headers(init?.headers).get('accept');
        if (accept === 'application/octet-stream' && checksumBytes && url === checksumUrl) return new Response(checksumBytes);
        const ref = accept === 'application/vnd.github+json' ? tag?.refs.get(url) : undefined;
        return ref ? Response.json(ref) : fetcher(address, init);
      } }, input);
    },
  };
}
