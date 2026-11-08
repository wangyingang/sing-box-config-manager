import { createHash } from 'node:crypto';
import type { AssetIdentity, SourceRecord } from './types.js';

export interface ReleaseInput {
  repository: 'v2fly/domain-list-community';
  version: 'latest-release';
  input: { format: 'plain-yaml'; asset: string; checksum: string };
}
export const V2FLY_RELEASE_INPUT = {
  repository: 'v2fly/domain-list-community', version: 'latest-release',
  input: { format: 'plain-yaml', asset: 'dlc.dat_plain.yml', checksum: 'dlc.dat_plain.yml.sha256sum' },
} as const satisfies ReleaseInput;
export const sha256 = (input: Uint8Array | string): string => createHash('sha256').update(input).digest('hex');
export class SourceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export interface ReleaseOptions { tag: string; fetch?: typeof fetch; token?: string; expectedSource?: SourceRecord; releaseMetadata?: Record<string, unknown>;
  onPinned?: (identity: Pick<SourceRecord, 'repository' | 'releaseId' | 'tag' | 'commit' | 'yaml' | 'checksum'>) => Promise<void>;
  onSource?: (source: SourceRecord) => Promise<void> }
function releaseAssetUrl(repository: string, tag: string, name: string) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

export function validReleaseAssetIdentities(record: Record<string, unknown>, source: ReleaseInput = V2FLY_RELEASE_INPUT): boolean {
  const tag = record.tag;
  if (typeof tag !== 'string') return false;
  return ([['yaml', source.input.asset], ['checksum', source.input.checksum]] as const).every(([key, name]) => {
    const value = record[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const asset = value as Partial<AssetIdentity>;
    return typeof asset.id === 'number' && Number.isSafeInteger(asset.id) && asset.id > 0
      && asset.name === name && asset.url === releaseAssetUrl(source.repository, tag, name);
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError('INVALID_METADATA', 'GitHub 元数据不是 object');
  return value as Record<string, unknown>;
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new SourceError('INVALID_METADATA', 'GitHub ID 非法');
  return value as number;
}

export async function lookupRelease(source: ReleaseInput, selector: string, options: Pick<ReleaseOptions, 'fetch' | 'token'>) {
  const response = await (options.fetch ?? fetch)(`https://api.github.com/repos/${source.repository}/releases/${selector}`, {
    headers: { Accept: 'application/vnd.github+json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Release lookup HTTP ${response.status}`);
  return object(await response.json());
}

export function readRelease(options: ReleaseOptions) {
  return readReleaseInput(options, V2FLY_RELEASE_INPUT);
}

/** No latest lookup; the tag, release, assets and peeled commit are pinned. */
export async function readReleaseInput(options: ReleaseOptions, input: ReleaseInput): Promise<{ bytes: Uint8Array; source: SourceRecord }> {
  const { tag } = options;
  const { repository, input: { asset: assetName, checksum: checksumName } } = input;
  if (!tag || tag.toLowerCase() === 'latest') throw new SourceError('INVALID_TAG', '必须指定固定 Release tag');
  const fetcher = options.fetch ?? fetch;
  const get = async (url: string, api = false, accept = 'application/vnd.github+json'): Promise<Response> => {
    const response = await fetcher(url, {
      headers: api ? { Accept: accept, ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) } : {},
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new SourceError('DOWNLOAD_FAILED', `HTTP ${response.status}: ${url}`);
    return response;
  };
  const api = async (path: string) => object(await (await get(`https://api.github.com/repos/${repository}/${path}`, true)).json());
  const release = options.releaseMetadata ?? await api(`releases/tags/${encodeURIComponent(tag)}`);
  if (release.tag_name !== tag) throw new SourceError('RELEASE_MISMATCH', 'Release tag 与指定值不一致');
  const releaseId = id(release.id);
  if (!Array.isArray(release.assets)) throw new SourceError('MISSING_ASSET', 'Release 缺少 assets');
  const assets = release.assets.map(object);
  const asset = (name: string): AssetIdentity => {
    const found = assets.filter((entry) => entry.name === name);
    if (found.length !== 1) throw new SourceError('MISSING_ASSET', `${name} 必须唯一存在于同一 Release`);
    const expectedUrl = releaseAssetUrl(repository, tag, name);
    if (found[0].browser_download_url !== expectedUrl) throw new SourceError('ASSET_MISMATCH', `${name} 下载地址不属于固定官方 Release`);
    return { id: id(found[0].id), name, url: expectedUrl };
  };
  const yaml = asset(assetName);
  const checksum = asset(checksumName);
  let ref = object((await api(`git/ref/tags/${encodeURIComponent(tag)}`)).object);
  const seen = new Set<string>();
  while (ref.type === 'tag') {
    if (typeof ref.sha !== 'string' || !/^[a-f0-9]{40}$/.test(ref.sha) || seen.has(ref.sha) || seen.size >= 16) {
      throw new SourceError('INVALID_TAG_REF', 'tag 解引用失败或存在循环');
    }
    seen.add(ref.sha);
    ref = object((await api(`git/tags/${ref.sha}`)).object);
  }
  if (ref.type !== 'commit' || typeof ref.sha !== 'string' || !/^[a-f0-9]{40}$/.test(ref.sha)) {
    throw new SourceError('INVALID_TAG_REF', 'tag 未指向有效源码 commit');
  }
  await options.onPinned?.({ repository, releaseId, tag, commit: ref.sha, yaml, checksum });
  const [bytes, checksumBytes] = await Promise.all([yaml, checksum].map(async (entry) =>
    // Download by the pinned asset ID, so replacing an asset under the same tag
    // cannot silently supply new bytes labelled with the original identity.
    new Uint8Array(await (await get(`https://api.github.com/repos/${repository}/releases/assets/${entry.id}`, true, 'application/octet-stream')).arrayBuffer())));
  let checksumText: string;
  try { checksumText = new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes); }
  catch { throw new SourceError('INVALID_CHECKSUM', '摘要文件不是 UTF-8'); }
  const match = /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)\r?\n?$/.exec(checksumText);
  if (!match || match[2] !== assetName) throw new SourceError('INVALID_CHECKSUM', `摘要必须只包含 ${assetName} 的 SHA-256 记录`);
  const inputSha256 = sha256(bytes);
  if (inputSha256 !== match[1].toLowerCase()) throw new SourceError('CHECKSUM_MISMATCH', '实际 YAML 字节 SHA-256 与官方摘要不一致');
  const source: SourceRecord = {
    repository, releaseId, tag, commit: ref.sha, yaml, checksum,
    inputSha256, inputBytes: bytes.byteLength, checksumSha256: sha256(checksumBytes),
  };
  if (options.expectedSource) {
    // Compare canonical fields, independent of JSON property enumeration order.
    const expected = options.expectedSource;
    if (source.repository !== expected.repository || source.releaseId !== expected.releaseId || source.tag !== expected.tag ||
        source.commit !== expected.commit || source.inputSha256 !== expected.inputSha256 || source.inputBytes !== expected.inputBytes ||
        source.checksumSha256 !== expected.checksumSha256 || [yaml, checksum].some((entry, index) => {
          const old = index === 0 ? expected.yaml : expected.checksum;
          return !old || entry.id !== old.id || entry.name !== old.name || entry.url !== old.url;
        })) throw new SourceError('SOURCE_CHANGED', '已固定输入身份或内容发生变化');
  }
  await options.onSource?.(source);
  return { bytes, source };
}
