import { sha256, SourceError } from './release.js';

export interface FixedUrlInput {
  version: 'url';
  input: { format: 'sing-box-source-json'; url: string };
}

export interface FixedUrlSource {
  kind: 'fixed-url';
  url: string;
  inputSha256: string;
  inputBytes: number;
}

// GitHub blob reads are base64-encoded within the transport response limit.
const maxInputBytes = 8 * 1024 * 1024;

export function validFixedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\#]/.test(value)) return false;
  const parsed = URL.parse(value);
  return Boolean(parsed?.hostname && !parsed.username && !parsed.password);
}

export function validFixedUrlSource(value: unknown, input: FixedUrlInput): value is FixedUrlSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<FixedUrlSource>;
  return source.kind === 'fixed-url' && source.url === input.input.url
    && typeof source.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(source.inputSha256)
    && typeof source.inputBytes === 'number' && Number.isSafeInteger(source.inputBytes)
    && source.inputBytes > 0 && source.inputBytes <= maxInputBytes;
}

export async function readFixedUrlInput(input: FixedUrlInput, fetcher: typeof fetch = fetch) {
  const { url } = input.input;
  const response = await fetcher(url, {
    headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 || !response.body) throw new SourceError('URL_DOWNLOAD_FAILED', `Rule input HTTP ${response.status}: ${url}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxInputBytes) throw new SourceError('INVALID_URL_INPUT', 'Rule input exceeds 8 MiB');
    chunks.push(chunk);
  }
  if (!length) throw new SourceError('INVALID_URL_INPUT', 'Rule input is empty');
  const bytes = Buffer.concat(chunks, length);
  const source: FixedUrlSource = { kind: 'fixed-url', url, inputSha256: sha256(bytes), inputBytes: length };
  return { bytes, source };
}

export function verifyFixedUrlSnapshot(source: FixedUrlSource, bytes: Uint8Array | undefined) {
  if (!bytes || bytes.byteLength !== source.inputBytes || sha256(bytes) !== source.inputSha256) {
    throw new SourceError('URL_INPUT_CHANGED', 'Retained URL input is missing or differs from its recorded digest or length');
  }
  return bytes;
}
