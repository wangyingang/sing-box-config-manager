import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { parseProjectedConfiguration } from '../../src/configuration.js';
import { convertInput } from '../../src/configured-build.js';
import { normalizeTerms, readSourceTerms } from '../../src/projection.js';
import { immutableUrl } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import type { RuleSource } from '../../src/rules-model.js';
import { convertSingBoxDomainJson } from '../../src/sing-box-domain-json-adapter.js';
import { readV3Fixture } from '../fixtures/baseline-configuration.js';
import { decompileRuleBinary } from '../../src/native.js';

/** Only retry reads so transport recovery cannot replay a Git write. */
export const retryProbeRead: typeof fetch = async (url, init) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 || attempt === 3) return response;
      await response.body?.cancel();
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 3 || init?.signal?.aborted) throw error;
    }
    await setTimeout(attempt * 1000);
  }
};

export async function downloadProbeFile(url: string) {
  const response = await retryProbeRead(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

interface SourceCheck {
  id: string;
  candidateId: string;
  source: RuleSource;
  artifactUrl: string;
  artifact: Buffer;
}

function normalizeDecodedRule(rule: Record<string, unknown>): Record<string, unknown> {
  const list = (value: unknown) => Array.isArray(value) ? value : [value];
  return Object.fromEntries(Object.entries(rule).map(([field, value]) => {
    if (field === 'rules') {
      assert.ok(Array.isArray(value));
      return [field, value.map(normalizeDecodedRule)];
    }
    if (field === 'network_interface_address') {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      return [field, Object.fromEntries(Object.entries(value).map(([name, prefixes]) => [name, list(prefixes)]))];
    }
    if (field === 'type' || field === 'mode' || typeof value === 'boolean') return [field, value];
    return [field, list(value)];
  }));
}

function countPredicates(rule: Record<string, unknown>): number {
  return Object.entries(rule).reduce((count, [field, value]) => {
    if (field === 'type' || field === 'mode' || field === 'invert') return count;
    if (field === 'rules' && Array.isArray(value)) return count + value.reduce((total, child) => total + countPredicates(child), 0);
    if (field === 'network_interface_address' && value && typeof value === 'object') {
      return count + Object.values(value).flat().length;
    }
    return count + (Array.isArray(value) ? value.length : 1);
  }, 0);
}

/** Compare all matched predicates against the previous formal input selections at the same upstream bytes. */
export function formalSourceVerifier(deliveryHead: string, { binary, verifyPinnedSrs = false }:
  { binary?: string; verifyPinnedSrs?: boolean } = {}) {
  const baseline = parseProjectedConfiguration(readV3Fixture());
  const inputs = new Map<string, Promise<Buffer>>();
  const expectedByInput = new Map<string, ReturnType<typeof convertInput>>();
  async function cached(url: string) {
    let pending = inputs.get(url);
    if (!pending) {
      pending = downloadProbeFile(url);
      inputs.set(url, pending);
    }
    return pending;
  }

  return async ({ id, candidateId, source, artifactUrl, artifact }: SourceCheck) => {
    if (id === 'china-domains' && 'kind' in source && source.kind === 'github-commit') {
      assert.ok(binary, 'Set SING_BOX_TEST_BINARY to verify the SRS input');
      assert.equal(source.repository, 'SagerNet/sing-geosite');
      assert.equal(source.branch, 'rule-set');
      assert.equal(source.file.path, 'geosite-geolocation-cn.srs');
      assert.match(source.commit, /^[a-f0-9]{40}$/);
      assert.equal(source.file.url, `https://raw.githubusercontent.com/SagerNet/sing-geosite/${source.commit}/geosite-geolocation-cn.srs`);
      const address = immutableUrl(deliveryHead, `candidates/${candidateId}/input.source.srs`);
      const snapshotBytes = await cached(address);
      assert.equal(sha256(snapshotBytes), source.inputSha256, id);
      assert.equal(snapshotBytes.length, source.inputBytes, id);
      if (verifyPinnedSrs) {
        assert.deepEqual(snapshotBytes, await cached(source.file.url), `${id}: retained SRS differs from the pinned upstream file`);
      }
      const decoded = JSON.parse(await decompileRuleBinary(snapshotBytes, binary)) as { rules?: Record<string, unknown>[] };
      const rules = (decoded.rules ?? []).map(normalizeDecodedRule);
      assert.deepEqual(JSON.parse(artifact.toString()), { version: 4, rules });
      const exactPredicateCount = rules.reduce((count, rule) => count + countPredicates(rule), 0);
      return { id, candidateId, sourceAddress: source.file.url, checkedInput: address,
        ...(verifyPinnedSrs && { checkedUpstream: source.file.url }), inputSha256: source.inputSha256,
        inputBytes: snapshotBytes.length, checkedOutput: artifactUrl, outputSha256: sha256(artifact), exactPredicateCount };
    }
    const old = baseline.ruleSets.find(rule => rule.id === id);
    assert.ok(old, id);
    const input = baseline.sources[old.source];
    const format = input.input.format;
    let address: string, file: string, observation: string | undefined;
    if (input.version === 'git-branch') {
      assert.ok('kind' in source && source.kind === 'github-commit', id);
      assert.equal(source.repository, input.repository, id);
      assert.equal(source.branch, input.branch, id);
      assert.equal(source.file.path, input.input.path, id);
      assert.match(source.commit, /^[a-f0-9]{40}$/);
      file = input.input.path;
      address = `https://raw.githubusercontent.com/${input.repository}/${source.commit}/${file}`;
      assert.equal(source.file.url, address, id);
    } else {
      assert.ok('kind' in source && source.kind === 'fixed-url', id);
      file = input.version === 'latest-release' ? input.input.asset : 'chatgpt-voice.json';
      observation = input.version === 'latest-release'
        ? `https://github.com/${input.repository}/releases/latest/download/${file}` : input.input.url;
      assert.equal(source.url, observation, id);
      if (input.version === 'latest-release') assert.match(source.checksumSha256!, /^[a-f0-9]{64}$/);
      const ext = input.version === 'latest-release' ? 'yml' : 'json';
      address = immutableUrl(deliveryHead, `candidates/${candidateId}/input.source.${ext}`);
    }
    const upstream = await cached(address);
    assert.equal(sha256(upstream), source.inputSha256, id);
    assert.equal(upstream.length, source.inputBytes, id);
    const inputKey = `${old.source}:${source.inputSha256}`;
    let converted = expectedByInput.get(inputKey);
    if (!converted) {
      converted = convertInput(upstream, baseline.ruleSets.filter(rule => rule.source === old.source), format, file);
      expectedByInput.set(inputKey, converted);
    }
    const expected = converted.get(id);
    assert.ok(expected?.ok, `${id}: ${expected && 'error' in expected ? expected.error : 'missing baseline conversion'}`);
    const actual = JSON.parse(artifact.toString());
    let terms;
    if (format === 'sing-box-domain-json') {
      // For the current stream source, the groups contain only alternative domain predicates.
      // Compare all predicates as well as the original number of rule boundaries.
      assert.equal(actual.version, 4);
      assert.equal(actual.rules.length, JSON.parse(upstream.toString()).rules.length);
      const domains = convertSingBoxDomainJson(Buffer.from(JSON.stringify({ ...actual, version: 2 })), file, 'all');
      assert.ok(domains.ok, id);
      terms = domains.terms;
    } else {
      terms = readSourceTerms(actual);
    }
    assert.deepEqual(terms, normalizeTerms(expected.terms as Parameters<typeof normalizeTerms>[0]), id);
    return { id, candidateId, selectedList: input.version === 'latest-release' ? old.list : undefined,
      sourceAddress: observation ?? address, checkedInput: address, inputSha256: source.inputSha256, inputBytes: upstream.length,
      checkedOutput: artifactUrl, outputSha256: sha256(artifact), exactPredicateCount: terms.length };
  };
}

/** Recheck source selection and matching content from the immutable URLs in an earlier probe. */
if (import.meta.main) {
  const [evidencePath, output] = process.argv.slice(2);
  assert.ok(evidencePath && output, 'Pass the formal v4 evidence file and a new output file');
  const { finalHead, rules } = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(rules.length, 16);
  const verify = formalSourceVerifier(finalHead, { binary: process.env.SING_BOX_TEST_BINARY });
  const sources = [];
  for (const rule of rules) {
    const source = rule.files.find(({ format }: { format: string }) => format === 'source');
    const match = /\/candidates\/([a-f0-9-]{36})\//.exec(source.candidateUrl);
    assert.ok(match);
    sources.push(await verify({ id: rule.id, candidateId: match[1], source: rule.source, artifactUrl: source.candidateUrl, artifact: await downloadProbeFile(source.candidateUrl) }));
    console.log('source checked', rule.id, sources.at(-1)!.exactPredicateCount);
  }
  await writeFile(output, JSON.stringify({ sourceEvidence: finalHead, sources }, null, 2) + '\n', { flag: 'wx' });
}
