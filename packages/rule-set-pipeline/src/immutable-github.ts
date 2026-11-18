import type { ghJson } from './publication.js';

/** Only content addressed by a full Git SHA is reusable. Branches, permissions
 * and latest source selectors still reach GitHub immediately before writes. */
export function cacheImmutableGitReads(request: typeof ghJson): typeof ghJson {
  const cache = new Map<string, Promise<any>>();
  return async (args, input, token) => {
    const path = args[1];
    const immutable = args.length === 2 && args[0] === 'api' && input === undefined && token === undefined
      && (/^repos\/[\w.-]+\/[\w.-]+\/(?:git\/(?:blobs|commits)\/[a-f0-9]{40}|git\/trees\/[a-f0-9]{40}\?recursive=1|contents\/[^?#]+\?ref=[a-f0-9]{40})$/.test(path)
        || /^repos\/[\w.-]+\/[\w.-]+\/commits\?sha=[a-f0-9]{40}&path=[^&#]+&per_page=1$/.test(path));
    if (!immutable) return request(args, input, token);
    let pending = cache.get(path);
    if (!pending) {
      pending = request(args, input, token);
      cache.set(path, pending);
      // Bound a long-lived host's cache; eviction only costs another read.
      if (cache.size > 128) cache.delete(cache.keys().next().value!);
      pending.catch(() => { if (cache.get(path) === pending) cache.delete(path); });
    }
    return structuredClone(await pending);
  };
}
