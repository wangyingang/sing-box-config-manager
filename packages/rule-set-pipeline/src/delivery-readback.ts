import { sha256 } from './release.js';
import type { FileEvidence } from './rules-model.js';

export interface DeliveryReadback {
  url: string;
  httpStatus?: number;
  byteLength?: number;
  sha256?: string;
  ok: boolean;
  error?: string;
}

/** A retired address must return 404. Each published address must serve the recorded bytes over GET. */
export async function readDeliveryUrl(url: string, expected: FileEvidence | 'retired', request: typeof fetch): Promise<DeliveryReadback> {
  const result: DeliveryReadback = { url, ok: false };
  try {
    const response = await request(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    result.httpStatus = response.status;
    if (expected === 'retired' || response.status !== 200) {
      await response.body?.cancel();
      const status = expected === 'retired' ? 404 : 200;
      if (response.status !== status) throw new Error(`Expected HTTP ${status}, received ${response.status}`);
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      result.byteLength = bytes.length;
      result.sha256 = sha256(bytes);
      if (result.byteLength !== expected.byteLength || result.sha256 !== expected.sha256) {
        throw new Error('Response differs from the delivery record');
      }
    }
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function readPublishedFile(urls: { candidate: string; fixedDelivery: string; stable: string }, expected: FileEvidence, request: typeof fetch) {
  const [candidate, fixedDelivery, stable] = await Promise.all([
    readDeliveryUrl(urls.candidate, expected, request),
    readDeliveryUrl(urls.fixedDelivery, expected, request),
    readDeliveryUrl(urls.stable, expected, request),
  ]);
  return { candidate, fixedDelivery, stable };
}
