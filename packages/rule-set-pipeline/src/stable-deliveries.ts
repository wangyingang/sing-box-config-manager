import type { PublicationSnapshot } from './publication-repository.js';
import { sha256 } from './release.js';
import type { FileEvidence, RuleDelivery } from './rules-model.js';

interface StableDeliveries {
  records: ReadonlyMap<string, RuleDelivery>;
  recordPaths: ReadonlyMap<string, string>;
}

export async function verifyStableDeliveries(snapshot: PublicationSnapshot): Promise<StableDeliveries> {
  const records = new Map<string, RuleDelivery>();
  const recordPaths = new Map<string, string>();
  for (const path of snapshot.paths.filter(path => path.startsWith('stable/') && path.endsWith('/activation.json'))) {
    const bytes = await snapshot.read(path);
    const record = bytes && JSON.parse(bytes.toString());
    if (record?.schemaVersion !== 2 || typeof record.id !== 'string' || typeof record.logicalId !== 'string'
      || typeof record.candidateId !== 'string' || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
      throw new Error(`RULE_DELIVERY_CORRUPT: ${path}`);
    }
    if (records.has(record.logicalId)) throw new Error('RULE_DELIVERY_CORRUPT: duplicate logical ID');
    for (const [file, evidence] of Object.entries(record.files) as [string, FileEvidence][]) {
      if (!file.startsWith(path.slice(0, -'activation.json'.length))) throw new Error('RULE_DELIVERY_CORRUPT: unowned file');
      const actual = await snapshot.read(file);
      if (!actual || actual.length !== evidence.byteLength || sha256(actual) !== evidence.sha256) throw new Error(`RULE_DELIVERY_CORRUPT: ${file}`);
    }
    records.set(record.logicalId, record);
    recordPaths.set(record.logicalId, path);
  }
  return { records, recordPaths };
}

/** One request owns one target. Only a completely verified immutable head can be reused. */
export function createStableDeliveryReader() {
  let last: { head: string; verified: StableDeliveries } | undefined;
  return async (snapshot: PublicationSnapshot) => {
    if (last?.head === snapshot.head) return last.verified;
    const verified = await verifyStableDeliveries(snapshot);
    last = { head: snapshot.head, verified };
    return verified;
  };
}
