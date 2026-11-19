import { isIP } from 'node:net';
import { convertCidrText } from './cidr-text-adapter.js';
import { sha256, SourceError } from './release.js';
import { diagnostic, emptyReport } from './types.js';

export const OPENAI_VOICE_URL = 'https://openai.com/chatgpt-voice.json';
export const OPENAI_VOICE_FILE = 'chatgpt-voice.json';

export interface OpenAiVoiceInput {
  version: 'openai-voice';
  input: { format: 'openai-voice-json'; url: typeof OPENAI_VOICE_URL };
}

export interface OpenAiVoiceSource {
  kind: 'openai-voice';
  url: typeof OPENAI_VOICE_URL;
  inputSha256: string;
  inputBytes: number;
  etag?: string;
}

const maxInputBytes = 1024 * 1024;
const strongEtag = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && /^"[\x21\x23-\x7e]*"$/.test(value);

export function validOpenAiVoiceSource(value: unknown): value is OpenAiVoiceSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<OpenAiVoiceSource>;
  return source.kind === 'openai-voice' && source.url === OPENAI_VOICE_URL
    && typeof source.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(source.inputSha256)
    && typeof source.inputBytes === 'number' && Number.isSafeInteger(source.inputBytes)
    && source.inputBytes > 0 && source.inputBytes <= maxInputBytes
    && (source.etag === undefined || strongEtag(source.etag));
}

export const openAiVoiceSnapshotPath = (id: string) => `candidates/${id}/${OPENAI_VOICE_FILE}`;

export function verifyOpenAiVoiceSnapshot(source: OpenAiVoiceSource, bytes: Uint8Array | undefined) {
  if (!bytes || bytes.byteLength !== source.inputBytes || sha256(bytes) !== source.inputSha256) {
    throw new SourceError('VOICE_INPUT_CHANGED', 'Retained ChatGPT Voice input is missing or differs from its recorded digest or length');
  }
  return bytes;
}

async function readBounded(response: Response) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxInputBytes) throw new SourceError('INVALID_VOICE_INPUT', 'ChatGPT Voice input exceeds 1 MiB');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  if (!length) throw new SourceError('INVALID_VOICE_INPUT', 'ChatGPT Voice input is empty');
  return Buffer.concat(chunks, length);
}

export function probeOpenAiVoiceInput(fetcher: typeof fetch = fetch) {
  type AcquiredInput = { bytes: Uint8Array; source: OpenAiVoiceSource };
  let acquired: AcquiredInput | undefined;
  async function download(previous?: OpenAiVoiceSource) {
    if (acquired) return acquired;
    const etag = previous?.etag;
    const response = await fetcher(OPENAI_VOICE_URL, {
      headers: { Accept: 'application/json', ...(etag && { 'If-None-Match': etag }) },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const returnedEtag = response.headers.get('etag');
    if (response.status === 304 && etag && (!returnedEtag || returnedEtag === etag)) return;
    if (response.status !== 200) {
      throw new SourceError('VOICE_DOWNLOAD_FAILED', `ChatGPT Voice input HTTP ${response.status}`);
    }
    const bytes = await readBounded(response);
    acquired = { bytes, source: { kind: 'openai-voice', url: OPENAI_VOICE_URL,
      inputSha256: sha256(bytes), inputBytes: bytes.length, ...(strongEtag(returnedEtag) && { etag: returnedEtag }) } };
    return acquired;
  }
  return {
    async read() {
      const fetched = await download();
      if (!fetched) throw new SourceError('VOICE_DOWNLOAD_FAILED', 'ChatGPT Voice input requires a response body');
      return fetched;
    },
    async unchanged(previous: unknown) {
      if (!validOpenAiVoiceSource(previous)) return;
      const fetched = await download(previous);
      if (!fetched) return previous;
      if (fetched.source.inputSha256 === previous.inputSha256) return fetched.source;
    },
  };
}

export function convertOpenAiVoice(bytes: Uint8Array, file: string, list: string): ReturnType<typeof convertCidrText> {
  try {
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(document?.prefixes) || !document.prefixes.length) throw new Error('Expected a nonempty prefixes array');
    const prefixes = document.prefixes.map((entry: unknown, index: number) => {
      const fields = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.entries(entry) : [];
      const [name, value] = fields[0] ?? [];
      const family = name === 'ipv4Prefix' ? 4 : name === 'ipv6Prefix' ? 6 : 0;
      if (fields.length !== 1 || !family || typeof value !== 'string' || !value.includes('/')
        || /\s/.test(value) || isIP(value.split('/')[0]) !== family) throw new Error(`Invalid IP prefix at prefixes[${index}]`);
      return value;
    });
    return convertCidrText(Buffer.from(prefixes.join('\n')), file, list);
  } catch (error) {
    const report = emptyReport();
    report.diagnostics.push(diagnostic('INVALID_VOICE_INPUT', error instanceof Error ? error.message : 'Invalid ChatGPT Voice input', { file, list }));
    return { ok: false, report, error: 'ChatGPT Voice JSON conversion failed' };
  }
}
