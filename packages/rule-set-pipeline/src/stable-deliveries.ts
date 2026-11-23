import type { PublicationSnapshot } from './publication-repository.js';
import { sha256 } from './release.js';
import { singleArtifactPaths, stableRecordLocation } from './stable-rule-paths.js';
import type { FileEvidence, RuleDelivery } from './rules-model.js';

export interface StableDeliveries {
  records: ReadonlyMap<string, RuleDelivery>;
  recordPaths: ReadonlyMap<string, string>;
}

export async function verifyStableDeliveries(snapshot: PublicationSnapshot): Promise<StableDeliveries> {
  const records = new Map<string, RuleDelivery>();
  const recordPaths = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const path of snapshot.paths) {
    const location = stableRecordLocation(path);
    if (!location || snapshot.isDirectory?.(path)) continue;
    if (location.artifact === undefined) throw new Error('RULE_STATE_MIGRATION_REQUIRED: v4 requires an empty artifact target');
    const bytes = await snapshot.read(path);
    const record = bytes && JSON.parse(bytes.toString());
    if (record?.schemaVersion !== 2 || typeof record.id !== 'string' || typeof record.logicalId !== 'string'
      || typeof record.candidateId !== 'string' || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
      throw new Error(`RULE_DELIVERY_CORRUPT: ${path}`);
    }
    if (records.has(record.logicalId)) throw new Error('RULE_DELIVERY_CORRUPT: duplicate logical ID');
    const files = Object.entries(record.files) as [string, FileEvidence][];
    if (files.length !== 2
      || !singleArtifactPaths(location.directory, location.artifact).every(file => Object.hasOwn(record.files, file))) {
      throw new Error(`RULE_DELIVERY_CORRUPT: unexpected files for ${path}`);
    }
    for (const [file, evidence] of files) {
      if (!file.startsWith(location.directory + '/')) throw new Error('RULE_DELIVERY_CORRUPT: unowned file');
      const owner = owners.get(file);
      if (owner !== undefined) throw new Error(`SUBSCRIPTION_PATH_CONFLICT: ${file} is owned by ${owner} and ${record.logicalId}`);
      owners.set(file, record.logicalId);
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
