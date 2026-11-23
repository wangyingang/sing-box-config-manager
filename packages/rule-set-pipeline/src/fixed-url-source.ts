import { sha256, SourceError } from './release.js';

export interface FixedUrlInput {
  version: 'url';
  input: {
    format: 'sing-box-source-json' | 'v2fly-dlc-yaml' | 'openai-voice-json';
    url: string;
    sha256Url?: string;
  };
}

export interface FixedUrlSource {
  kind: 'fixed-url';
  url: string;
  inputSha256: string;
  inputBytes: number;
  checksumSha256?: string;
}

// GitHub blob reads are base64-encoded within the transport response limit.
const maxInputBytes = 8 * 1024 * 1024;
const maxChecksumBytes = 4096;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validFixedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\#]/.test(value)) return false;
  const parsed = URL.parse(value);
  return Boolean(parsed?.hostname && !parsed.username && !parsed.password);
}

export function validFixedUrlSource(value: unknown, input: FixedUrlInput): value is FixedUrlSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<FixedUrlSource>;
  return source.kind === 'fixed-url' && source.url === input.input.url
    && digest(source.inputSha256)
    && (input.input.sha256Url ? digest(source.checksumSha256) : source.checksumSha256 === undefined)
    && typeof source.inputBytes === 'number' && Number.isSafeInteger(source.inputBytes)
    && source.inputBytes > 0 && source.inputBytes <= maxInputBytes;
}

async function download(fetcher: typeof fetch, sourceUrl: string, accept: string, limit: number, label: string) {
  const signal = AbortSignal.timeout(30_000);
  let url = sourceUrl;
  let response = await fetcher(url, { headers: { Accept: accept }, redirect: 'manual', signal });
  // GitHub Release URLs redirect first to a release and then to the asset host.
  for (let count = 0; [301, 302, 303, 307, 308].includes(response.status); count++) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    const next = location && URL.parse(location, url)?.href;
    if (count === 5 || !validFixedUrl(next)) throw new SourceError('URL_DOWNLOAD_FAILED', `Invalid ${label} redirect: ${sourceUrl}`);
    url = next;
    response = await fetcher(url, { headers: { Accept: accept }, redirect: 'manual', signal });
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new SourceError('URL_DOWNLOAD_FAILED', `${label} HTTP ${response.status}: ${sourceUrl}`);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > limit) throw new SourceError('INVALID_URL_INPUT', `${label} exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (!length) throw new SourceError('INVALID_URL_INPUT', `${label} is empty`);
  return Buffer.concat(chunks, length);
}

async function readChecksum(fetcher: typeof fetch, url: string) {
  const bytes = await download(fetcher, url, 'text/plain', maxChecksumBytes, 'SHA-256 checksum').catch((error: unknown) => {
    throw new SourceError('CHECKSUM_DOWNLOAD_FAILED', `SHA-256 checksum download failed: ${String(error)}`);
  });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SourceError('INVALID_CHECKSUM', 'SHA-256 checksum must be UTF-8'); }
  const match = /^([a-fA-F0-9]{64})(?: [ *][^\r\n]+)?\r?\n?$/.exec(text);
  if (!match || match[0] !== text) throw new SourceError('INVALID_CHECKSUM', 'Expected one SHA-256 checksum');
  return { expected: match[1].toLowerCase(), checksumSha256: sha256(bytes) };
}

export async function readFixedUrlInput(input: FixedUrlInput, fetcher: typeof fetch = fetch) {
  const { url, sha256Url, format } = input.input;
  const accept = format === 'v2fly-dlc-yaml' ? 'application/yaml, text/plain;q=0.9, */*;q=0.8' : 'application/json';
  const checksum = sha256Url ? await readChecksum(fetcher, sha256Url) : undefined;
  const bytes = await download(fetcher, url, accept, maxInputBytes, 'Rule input');
  const inputSha256 = sha256(bytes);
  if (checksum && checksum.expected !== inputSha256) {
    throw new SourceError('CHECKSUM_MISMATCH', 'Rule input SHA-256 does not match the configured checksum');
  }
  const source: FixedUrlSource = { kind: 'fixed-url', url, inputSha256, inputBytes: bytes.length,
    ...(checksum && { checksumSha256: checksum.checksumSha256 }) };
  return { bytes, source };
}

export function verifyFixedUrlSnapshot(source: FixedUrlSource, bytes: Uint8Array | undefined) {
  if (!bytes || bytes.byteLength !== source.inputBytes || sha256(bytes) !== source.inputSha256) {
    throw new SourceError('URL_INPUT_CHANGED', 'Retained URL input is missing or differs from its recorded digest or length');
  }
  return bytes;
}
