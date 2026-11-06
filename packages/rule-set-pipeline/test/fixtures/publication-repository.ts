import type { PublicationRepository } from '../../src/publication-repository.js';
import type { PublicationTransport } from '../../src/publication.js';

export function memoryRepository(branch = 'acceptance-recovery') {
  let serial = 1;
  let head = serial.toString(16).padStart(40, '0');
  const versions = new Map<string, Map<string, Buffer>>([[head, new Map()]]);
  const writes: Record<string, Buffer>[] = [];
  let fault: ((files: Record<string, Buffer>, applied: boolean) => void) | undefined;
  const repository: PublicationRepository = {
    branch,
    async snapshot() {
      const fixed = versions.get(head)!;
      return { head, paths: [...fixed.keys()], async read(path) { return fixed.get(path); } };
    },
    async commit(expectedHead, files) {
      fault?.(files, false);
      if (head !== expectedHead) throw new Error('PUBLICATION_CONFLICT');
      const tree = new Map(versions.get(head)!);
      for (const [path, bytes] of Object.entries(files)) {
        if (path.startsWith('candidates/') && tree.has(path)) throw new Error('Candidate overwrite');
        tree.set(path, bytes);
      }
      head = (++serial).toString(16).padStart(40, '0');
      versions.set(head, tree); writes.push(files);
      fault?.(files, true);
      return head;
    },
  };
  const publication: PublicationTransport = { repository,
    async commit() { throw new Error('Unregistered publication'); },
    async download(url) {
      const parts = new URL(url).pathname.split('/').slice(3);
      const bytes = versions.get(parts[0])?.get(parts.slice(1).join('/'));
      if (!bytes) throw new Error('Readback HTTP 404');
      return bytes;
    },
  };
  return { repository, publication, writes,
    fault(value: typeof fault) { fault = value; },
    replace(path: string, bytes: Buffer) {
      const tree = new Map(versions.get(head)!); tree.set(path, bytes);
      head = (++serial).toString(16).padStart(40, '0'); versions.set(head, tree);
    },
    remove(path: string) {
      const tree = new Map(versions.get(head)!); tree.delete(path);
      head = (++serial).toString(16).padStart(40, '0'); versions.set(head, tree);
    },
  };
}
