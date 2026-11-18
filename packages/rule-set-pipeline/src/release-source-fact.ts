import { validReleaseAssetIdentities, type ReleaseInput } from './release.js';
import { validRepository } from './source-input.js';
import type { SourceRecord } from './types.js';

export function validReleaseSource(record: Record<string, unknown>, input?: ReleaseInput): record is SourceRecord & Record<string, unknown> {
  return validRepository(record.repository) && (!input || record.repository === input.repository)
    && typeof record.releaseId === 'number' && Number.isSafeInteger(record.releaseId) && record.releaseId > 0
    && typeof record.tag === 'string' && record.tag.length > 0
    && typeof record.commit === 'string' && /^[a-f0-9]{40}$/.test(record.commit)
    && typeof record.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.inputSha256)
    && typeof record.inputBytes === 'number' && Number.isSafeInteger(record.inputBytes) && record.inputBytes > 0
    && typeof record.checksumSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.checksumSha256)
    && validReleaseAssetIdentities(record, input);
}
