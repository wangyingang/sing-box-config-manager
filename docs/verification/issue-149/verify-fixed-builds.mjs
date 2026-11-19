import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildConfiguredCommit, buildConfiguredRelease } from '../../../packages/rule-set-pipeline/src/configured-build.ts';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../../packages/rule-set-pipeline/src/configuration.ts';
import { OPENAI_VOICE_URL } from '../../../packages/rule-set-pipeline/src/openai-voice-source.ts';
import { sha256 } from '../../../packages/rule-set-pipeline/src/release.ts';
import { buildRulesInput } from '../../../packages/rule-set-pipeline/src/rules-build.ts';
import { loadRulesRequest } from '../../../packages/rule-set-pipeline/src/rules-context.ts';
import { rulesEnvironment } from '../../../packages/rule-set-pipeline/test/fixtures/rules-environment.ts';

const [out, binary] = process.argv.slice(2);
assert.ok(out && binary, 'Pass a new evidence directory and the sing-box 1.14.4 binary');
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
const identity = { commit: await git('rev-parse', 'HEAD'), clean: (await git('status', '--porcelain')) === '' };
const configuration = readOfficialConfiguration();
const parsed = parseBuildConfiguration(configuration);
const releaseLists = {
  openai: 'openai', anthropic: 'anthropic', 'google-deepmind': 'google-deepmind',
  'china-domains': 'geolocation-cn', global: 'geolocation-!cn', apple: 'apple',
  microsoft: 'microsoft', docker: 'docker', github: 'github', google: 'google', youtube: 'youtube',
};
const commits = {
  'china-ip': {
    repository: 'gaoyifan/china-operator-ip', branch: 'ip-lists', format: 'cidr-text',
    path: 'china46.txt', commit: 'be3de75a9698c50193c35c1215509e89d5d5cf6f',
  },
  gfw: {
    repository: 'Loyalsoldier/v2ray-rules-dat', branch: 'release', format: 'domain-suffix-text',
    path: 'gfw.txt', commit: '3914c5cf42be87696db5139fc4b7d681b09b8d4a',
  },
  onedrive: {
    repository: 'blackmatrix7/ios_rule_script', branch: 'master', format: 'typed-domain-text',
    path: 'rule/Clash/OneDrive/OneDrive.list', commit: '0b6897dc17e0c513d25449c935a9694818e32f0c',
  },
  stream: {
    repository: 'SukkaLab/ruleset.skk.moe', branch: 'master', format: 'sing-box-domain-json',
    path: 'sing-box/non_ip/stream.json', commit: '838801f009734aa324e7d42d7b7b51561d1df5ba',
  },
};
assert.deepEqual(parsed.ruleSets.map(rule => rule.id).sort(),
  [...Object.keys(releaseLists), ...Object.keys(commits), 'chatgpt-voice'].sort());
await mkdir(out);

const releaseTag = '20261118141523';
const token = process.env.GITHUB_TOKEN;
const requests = [];
const release = await buildConfiguredRelease({ configuration, binary, selectedIds: Object.keys(releaseLists),
  release: { tag: releaseTag, token, fetch: (input, init) => {
    requests.push(String(input));
    return fetch(input, init);
  } },
});
assert.equal(release.source.repository, 'v2fly/domain-list-community');
assert.equal(release.source.tag, releaseTag);
assert.equal(release.source.commit, 'bc3a8f5e24792303cf82bfff33b1ff164a0e4b3c');
assert.equal(release.source.inputSha256, '20352b9263f6e3db420465efb565a7a0345ddde535afedf92515a7bb0ffa4dd8');
for (const [asset, name] of [[release.source.yaml, 'dlc.dat_plain.yml'], [release.source.checksum, 'dlc.dat_plain.yml.sha256sum']]) {
  assert.equal(asset.name, name);
  assert.equal(requests.filter(url => url.endsWith('/assets/' + asset.id)).length, 1);
}
assert.deepEqual(Object.fromEntries(release.results.map(rule => [rule.id, rule.definition.list])), releaseLists);

const gitBuilds = [];
let upstreamStream;
for (const [id, expected] of Object.entries(commits)) {
  const definition = parsed.ruleSets.find(rule => rule.id === id);
  const { repository, branch, format, path, commit } = expected;
  assert.deepEqual(parsed.sources[definition.source], { repository, version: 'git-branch', branch, input: { format, path } });
  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
  let input;
  const build = await buildConfiguredCommit({ configuration, binary, selectedIds: [id],
    github: { commit, token, fetch: async (address, init) => {
      const response = await fetch(address, init);
      if (String(address) === url) input = Buffer.from(await response.clone().arrayBuffer());
      return response;
    } },
  });
  assert.equal(build.results[0].definition.list, 'all');
  assert.deepEqual(build.source, { kind: 'github-commit', repository, branch, commit, file: { path, url },
    inputSha256: sha256(input), inputBytes: input.length });
  assert.ok(input.length > 0);
  if (id === 'stream') upstreamStream = input;
  gitBuilds.push(build);
}

const voiceInput = '{ "prefixes": [{ "ipv4Prefix": "192.0.2.0/24" }, { "ipv6Prefix": "2001:db8:1::/48" }] }\n';
const env = rulesEnvironment(binary, 'main');
env.configure(parsed);
env.context.allowWrites = false;
env.context.fetch = async address => {
  assert.equal(String(address), OPENAI_VOICE_URL);
  return new Response(voiceInput, { headers: { etag: '"verification-149"' } });
};
const loaded = await loadRulesRequest({ context: env.context });
assert.deepEqual(loaded.configuration, parsed);
const voice = await buildRulesInput(loaded, loaded.configuration.ruleSets.filter(rule => rule.id === 'chatgpt-voice'));
assert.deepEqual(voice.source, { kind: 'openai-voice', url: OPENAI_VOICE_URL, etag: '"verification-149"',
  inputSha256: sha256(voiceInput), inputBytes: Buffer.byteLength(voiceInput) });
assert.deepEqual(env.writes, []);

const rows = [];
for (const build of [release, ...gitBuilds, voice]) {
  for (const result of build.results) {
    const { id, definition, report } = result;
    assert.equal(result.status, 'built-validated', JSON.stringify({ id, report }));
    assert.equal(definition.stablePath, `stable/${id}`);
    const { native } = result;
    const ip = id === 'china-ip' || id === 'chatgpt-voice';
    const stem = ip ? 'route' : 'domains';
    assert.equal(native.tool.version, '1.14.4');
    assert.equal(native.validation.status, 'passed');
    assert.ok(report.outputTermCount > 0, id);
    assert.deepEqual(native.usages.route, { artifactFiles: [stem + '.json', stem + '.srs'] });
    assert.deepEqual(native.usages[ip ? 'dns-response' : 'dns-query'], native.usages.route);
    assert.deepEqual(native.usages[ip ? 'dns-query' : 'dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual(native.artifacts.map(artifact => artifact.file), native.usages.route.artifactFiles);
    for (const artifact of native.artifacts) {
      assert.ok(artifact.bytes > 0 && artifact.bytes === artifact.content.length);
      assert.equal(artifact.sha256, sha256(artifact.content));
    }
    const generated = JSON.parse(native.artifacts[0].content.toString());
    assert.equal(generated.version, 4);
    assert.ok(generated.rules.every(rule => Object.keys(rule).length === 1 && Object.hasOwn(rule, 'ip_cidr') === ip));
    rows.push({ id, definition, source: build.source, tools: build.tools, tool: native.tool,
      validation: native.validation, report, usages: native.usages, buildId: result.buildId, nativeBuildId: native.buildId,
      artifacts: native.artifacts.map(({ content, ...metadata }) => metadata) });
  }
}
assert.equal(rows.length, 16);

const streamBuild = gitBuilds.find(build => build.results[0].id === 'stream');
const stream = streamBuild.results[0];
const original = JSON.parse(upstreamStream.toString());
assert.equal(original.version, 2);
assert.equal(original.rules.length, 1);
const [{ domain, domain_suffix: suffix, domain_keyword: keyword }] = original.rules;
const expectedRules = [
  { domain_suffix: [...new Set(suffix)].sort() }, { domain: [...new Set(domain)].sort() },
  { domain_keyword: [...new Set(keyword)].sort() },
];
assert.deepEqual(JSON.parse(stream.native.artifacts[0].content.toString()), { version: 4, rules: expectedRules });
const upstreamFile = join(out, 'upstream-stream.json');
await writeFile(upstreamFile, upstreamStream, { flag: 'wx' });
for (const artifact of stream.native.artifacts) await writeFile(join(out, artifact.file), artifact.content, { flag: 'wx' });

const probes = [
  ['tubi.tv', ['domain']], ['sub.viu.tv', ['domain_suffix']], ['xnetflixdnstesty.invalid', ['domain_keyword']],
  ['unrelated.invalid', []], ['sub.tubi.tv', []], ['notviu.tv', []],
];
const matches = [];
for (const [value, fields] of probes) {
  const matchingFields = [
    domain.includes(value) && 'domain',
    suffix.some(item => value === item || value.endsWith('.' + item)) && 'domain_suffix',
    keyword.some(item => value.includes(item)) && 'domain_keyword',
  ].filter(Boolean);
  assert.deepEqual(matchingFields, fields);
  for (const [path, format] of [[upstreamFile, 'source'],
    ...stream.native.artifacts.map(artifact => [join(out, artifact.file), artifact.format])]) {
    const { stdout, stderr } = await exec(binary, ['rule-set', 'match', path, value, '--format', format]);
    const matched = (stdout + stderr).includes('match rules.');
    assert.equal(matched, fields.length > 0, `${path}: ${value}`);
    matches.push({ path, format, domain: value, matchingFields, matched });
  }
}

const evidence = { identity, configurationSha256: sha256(configuration), ruleSets: rows, streamMatch: matches };
await writeFile(join(out, 'builds.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(`${rows.length} builds and ${matches.length} native stream assertions passed. Evidence: ${join(out, 'builds.json')}`);
