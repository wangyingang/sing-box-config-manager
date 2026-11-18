import { ARTIFACT_REPOSITORY } from './publication.js';

type Download = (url: string) => Promise<Buffer>;
export type VerifyEvidence = <T>(verify: (download: Download) => Promise<T>) => Promise<T>;

export function verifyWithoutEvidenceCache(download: Download): VerifyEvidence {
  return verify => verify(download);
}

const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
const maxEntries = 128;
const maxBytes = 64 * 1024 * 1024;

function isImmutableAddress(url: string) {
  if (!url.startsWith(prefix)) return false;
  const [commit, ...path] = url.slice(prefix.length).split('/');
  return /^[a-f0-9]{40}$/.test(commit) && commit.length === 40 && path.length > 0
    && path.every(part => part && part !== '.' && part !== '..' && !/[^a-zA-Z0-9._-]/.test(part));
}

/** Scope to one rules operation. A verification may cover one file or an entire candidate chain. */
export function createOperationEvidenceVerifier(fetchBytes: Download): VerifyEvidence {
  const cache = new Map<string, { bytes: Buffer; pendingVerification?: symbol }>();
  let byteLength = 0;
  const remove = (url: string) => {
    const entry = cache.get(url);
    if (entry) byteLength -= entry.bytes.length;
    cache.delete(url);
  };

  return async verify => {
    const verification = Symbol();
    try {
      const result = await verify(async url => {
        if (!isImmutableAddress(url)) return fetchBytes(url);
        const entry = cache.get(url);
        if (entry && entry.pendingVerification === undefined) return Buffer.from(entry.bytes);

        const downloaded = await fetchBytes(url);
        // Recheck after awaiting the transport in case another verifier filled this address.
        if (!cache.has(url) && downloaded.length <= maxBytes) {
          while (cache.size >= maxEntries || byteLength + downloaded.length > maxBytes) {
            remove(cache.keys().next().value!);
          }
          const bytes = Buffer.alloc(downloaded.length);
          bytes.set(downloaded);
          cache.set(url, { bytes, pendingVerification: verification });
          byteLength += bytes.length;
          return Buffer.from(bytes);
        }
        return Buffer.from(downloaded);
      });
      for (const entry of cache.values()) {
        if (entry.pendingVerification === verification) delete entry.pendingVerification;
      }
      return result;
    } catch (error) {
      for (const [url, entry] of cache) {
        if (entry.pendingVerification === verification) remove(url);
      }
      throw error;
    }
  };
}
