import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredRuleInput, parseBuildConfiguration, parseProjectedConfiguration, readOfficialConfiguration } from '../src/configuration.js';
import { readV3Fixture } from './fixtures/baseline-configuration.js';
import { syncRules } from '../src/rules-operations.js';
import { rulesEnvironment } from './fixtures/rules-environment.js';

const target = 'acceptance-issue-170';
const configuration = `schemaVersion: 4
candidateRetentionDays: 30
target:
  repository: wangyingang/sing-box-rule-artifacts
  branch: ${target}
sources:
  example:
    fetch:
      method: url
      url: https://rules.example.test/mixed.json
    format: sing-box-source-json
ruleSets:
  first:
    data:
      source: example
    publishPath: stable/shared
    artifact: first
  second:
    data:
      source: example
    publishPath: stable/shared
    artifact: second
`;

const branchSource = configuration.replace(
  '      method: url\n      url: https://rules.example.test/mixed.json\n    format: sing-box-source-json',
  '      method: github-branch\n      repository: example/rules\n      branch: main',
);
const locate = (line: number, path: string, message: string) => ({ line, path, message });

for (const [scenario, input, expected] of [
  ['duplicate YAML key', configuration.replace('    artifact: second', '    artifact: second\n    artifact: duplicate'),
    locate(23, '', 'Map keys must be unique')],
  ['unknown field', configuration.replace('    artifact: second', '    artifact: second\n    usages: {}'),
    locate(23, 'ruleSets.second.usages', 'unknown field')],
  ['wrong type', configuration.replace('    artifact: second', '    artifact: 123'),
    locate(22, 'ruleSets.second.artifact', 'string')],
  ['unknown format', configuration.replace('sing-box-source-json', 'source-json'),
    locate(11, 'sources.example.format', 'allowed')],
  ['unknown source', configuration.replace('      source: example\n    publishPath: stable/shared\n    artifact: second',
    '      source: missing\n    publishPath: stable/shared\n    artifact: second'),
    locate(20, 'ruleSets.second.data.source', 'unknown source missing')],
  ['list on a whole-file format', configuration.replace('      source: example', '      source: example\n      list: all'),
    locate(16, 'ruleSets.first.data.list', 'sing-box-source-json')],
  ['filter on an unsupported format', configuration.replace('    artifact: first',
    '    artifact: first\n    filter: {include: {type: {anyOf: [DOMAIN]}}}'),
    locate(18, 'ruleSets.first.filter', 'sing-box-source-json')],
  ['empty filter condition', configuration.replace('    artifact: first',
    '    artifact: first\n    filter: {include: {type: {anyOf: []}}}'),
    locate(18, 'ruleSets.first.filter.include.type.anyOf', 'at least one')],
  ['wrong acquisition method', configuration.replace('method: url', 'method: release'),
    locate(9, 'sources.example.fetch.method', 'github-branch')],
  ['wrong source fields for URL', configuration.replace('method: url', 'method: url\n      branch: main'),
    locate(10, 'sources.example.fetch.branch', 'not allowed')],
  ['URL source missing a format', configuration.replace('    format: sing-box-source-json\n', ''),
    locate(8, 'sources.example.format', 'required')],
  ['branch source declaring the file format', branchSource.replace('      branch: main', '      branch: main\n    format: cidr-text'),
    locate(12, 'sources.example.format', 'not allowed')],
  ['branch-only format on a URL source', configuration.replace('sing-box-source-json', 'cidr-text'),
    locate(11, 'sources.example.format', 'allowed values')],
  ['URL input and checksum using the same address', configuration.replace('      url: https://rules.example.test/mixed.json',
    '      url: https://rules.example.test/mixed.json\n      sha256Url: https://rules.example.test/mixed.json'),
    locate(11, 'sources.example.fetch.sha256Url', 'must differ from the input URL')],
  ['branch source with no selected file', branchSource,
    locate(15, 'ruleSets.first.data.file', 'required for a GitHub branch source')],
  ['branch file with no format', branchSource.replace('      source: example', '      source: example\n      file: rules/example'),
    locate(15, 'ruleSets.first.data.format', 'required when file is present')],
  ['URL source with a rule-level file and format', configuration.replace('      source: example',
    '      source: example\n      file: rules/example\n      format: cidr-text'),
    locate(16, 'ruleSets.first.data.file', 'omitted for a URL source')],
  ['DLC source with no list', configuration.replace('sing-box-source-json', 'v2fly-dlc-yaml'),
    locate(15, 'ruleSets.first.data.list', 'required for v2fly-dlc-yaml')],
  ['DLC source with a Clash type condition', configuration.replace('sing-box-source-json', 'v2fly-dlc-yaml')
    .replace('      source: example', '      source: example\n      list: all')
    .replace('    artifact: first', '    artifact: first\n    filter: {include: {type: {anyOf: [DOMAIN]}}}'),
    locate(19, 'ruleSets.first.filter', 'invalid filter for v2fly-dlc-yaml')],
  ['two filter actions', configuration.replace('    artifact: first',
    '    artifact: first\n    filter: {include: {tags: {allOf: [cn]}}, exclude: {tags: {anyOf: [us]}}}'),
    locate(18, 'ruleSets.first.filter', 'more than 1 properties')],
  ['duplicate output', configuration.replace('    artifact: second', '    artifact: first'),
    locate(22, 'ruleSets.second.artifact', 'first and second')],
  ['file replacing a publish directory', configuration.replace('    publishPath: stable/shared\n    artifact: second',
    '    publishPath: stable/shared/first.json/nested\n    artifact: second'),
    locate(21, 'ruleSets.second.publishPath', 'first and second')],
] as const) {
  test(`sync stops before fetching or publishing on ${scenario}`, async () => {
    const { context, writes } = rulesEnvironment('/unused', target);
    context.readConfiguration = async () => ({ origin: 'iso-170', revision: 'invalid', content: input });
    let downloads = 0;
    let snapshots = 0;
    context.fetch = async () => { downloads++; throw new Error('unexpected source request'); };
    context.repository.snapshot = async () => { snapshots++; throw new Error('unexpected artifact access'); };
    const result = await syncRules({ context });
    const { line, path, message } = expected;
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.results, []);
    const diagnostic = result.error?.split('\n').find(entry =>
      new RegExp(`^${line}:\\d+ ${path ? path.replaceAll('.', '\\.') + ':' : ''}`).test(entry) && entry.includes(message));
    assert.ok(diagnostic, result.error ?? 'Missing configuration diagnostics');
    assert.deepEqual([downloads, snapshots, writes.length], [0, 0, 0]);
  });
}


test('the formal v4 YAML preserves every v3 publication path and selected input', () => {
  const yaml = readOfficialConfiguration();
  assert.match(yaml, /^# yaml-language-server: \$schema=\.\/rulesets\.schema\.json$/m);
  const current = parseBuildConfiguration(yaml);
  const baseline = parseProjectedConfiguration(readV3Fixture());
  assert.equal(current.candidateRetentionDays, 30);
  assert.equal(current.candidateRetentionDays, baseline.candidateRetentionDays);
  assert.deepEqual(current.target, baseline.target);
  assert.equal(current.ruleSets.length, 16);
  assert.deepEqual(current.ruleSets.map(({ id, stablePath, artifact }) => [id, stablePath, artifact]),
    baseline.ruleSets.map(rule => [rule.id, rule.stablePath, rule.usages.route.artifact]));

  for (const rule of current.ruleSets) {
    const previousRule = baseline.ruleSets.find(({ id }) => id === rule.id)!;
    assert.equal(rule.source, previousRule.source);
    const previousInput = baseline.sources[previousRule.source];
    const acquired = configuredRuleInput(current, rule);
    if (previousInput.version === 'latest-release') {
      const prefix = `https://github.com/${previousInput.repository}/releases/latest/download/`;
      assert.deepEqual(acquired, { version: 'url', input: { format: 'v2fly-dlc-yaml',
        url: prefix + previousInput.input.asset, sha256Url: prefix + previousInput.input.checksum } });
      assert.equal(rule.list, previousRule.list);
    } else if (previousInput.version === 'openai-voice') {
      assert.deepEqual(acquired, { version: 'url', input: previousInput.input });
      assert.equal(rule.list, undefined);
    } else {
      const format = previousInput.input.format === 'typed-domain-text' ? 'clash-rule-list'
        : previousInput.input.format === 'sing-box-domain-json' ? 'sing-box-source-json' : previousInput.input.format;
      assert.deepEqual(acquired, { ...previousInput, input: { ...previousInput.input, format } });
      assert.equal(rule.list, undefined);
    }
    assert.deepEqual(rule.filter, rule.id === 'onedrive' ? { include: { type: { anyOf: ['DOMAIN-KEYWORD', 'DOMAIN-SUFFIX'] } } } : undefined);
  }
});
