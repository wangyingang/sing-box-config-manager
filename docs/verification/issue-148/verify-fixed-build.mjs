import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, binary] = process.argv.slice(2);
const runner = async file => import(pathToFileURL(resolve('packages/rule-set-pipeline/src', file)).href);
const { buildConfiguredCommit } = await runner('configured-build.ts');
const { readOfficialConfiguration } = await runner('configuration.ts');
const { sha256 } = await runner('release.ts');
const commit = '0b6897dc17e0c513d25449c935a9694818e32f0c';
const repository = 'blackmatrix7/ios_rule_script';
const path = 'rule/Clash/OneDrive/OneDrive.list';
const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
const checked = await fetch(url);
assert.equal(checked.status, 200);
const input = Buffer.from(await checked.arrayBuffer());
const expected = { 'DOMAIN-SUFFIX': [], 'DOMAIN-KEYWORD': [], 'PROCESS-NAME': [] };
for (const [index, row] of input.toString('utf8').split(/\r?\n/).entries()) {
  if (row === '' || row.startsWith('#')) continue;
  const [type, value, ...other] = row.split(',');
  assert.ok(Object.hasOwn(expected, type), row);
  assert.ok(value && !other.length, row);
  expected[type].push(type === 'PROCESS-NAME' ? { type, value, line: index + 1 } : value);
}

const build = await buildConfiguredCommit({
  binary, configuration: readOfficialConfiguration(), selectedIds: ['onedrive'], github: { commit },
});
assert.deepEqual(build.source, {
  kind: 'github-commit', repository, branch: 'master', commit, file: { path, url },
  inputSha256: sha256(input), inputBytes: input.length,
});
const [result] = build.results;
assert.equal(result.status, 'built-validated', JSON.stringify(result));
assert.equal(result.definition.stablePath, 'stable/onedrive');
assert.equal(result.report.inputCount, 18);
assert.equal(result.report.outputTermCount, 16);
assert.deepEqual(result.report.filteredRules, expected['PROCESS-NAME']);
assert.deepEqual(result.report.filteredRules.map(rule => rule.value), ['OneDrive', 'OneDriveUpdater']);
assert.deepEqual(result.report.diagnostics, []);
assert.equal(result.native.tool.version, '1.14.4');
assert.equal(result.native.validation.status, 'passed');
assert.deepEqual(result.native.usages.route, { artifactFiles: ['domains.json', 'domains.srs'] });
assert.deepEqual(result.native.usages['dns-query'], result.native.usages.route);
assert.deepEqual(result.native.usages['dns-response'], { status: 'unavailable', reason: 'empty' });

const parsed = JSON.parse(result.native.artifacts.find(artifact => artifact.format === 'source').content);
const expectedJson = { version: 4, rules: [
  { domain_suffix: expected['DOMAIN-SUFFIX'].sort() },
  { domain_keyword: expected['DOMAIN-KEYWORD'].sort() },
] };
assert.deepEqual(parsed, expectedJson);
await mkdir(out);
for (const artifact of result.native.artifacts) {
  await writeFile(join(out, artifact.file), artifact.content, { flag: 'wx' });
  assert.equal(artifact.sha256, sha256(artifact.content));
}
const decompiledFile = join(out, 'decompiled.json');
execFileSync(binary, ['rule-set', 'decompile', join(out, 'domains.srs'), '-o', decompiledFile]);
const decompiled = JSON.parse(await readFile(decompiledFile, 'utf8'));
for (const rule of decompiled.rules) for (const values of Object.values(rule)) values.sort();
assert.deepEqual(decompiled.rules, expectedJson.rules);

const probes = [
  ['sharepoint.com', true], ['cdn.sharepoint.com', true], ['notsharepoint.com', false],
  ['sharepoint.com.example', false], ['xskydrivey.example', true], ['xsky-drivey.example', false],
  ['xonedrivey.example', true], ['x1drvy.example', true], ['unrelated.invalid', false],
];
const matches = result.native.artifacts.flatMap(artifact => probes.map(([domain, expected]) => {
  const args = ['rule-set', 'match', join(out, artifact.file), domain, '--format', artifact.format];
  const command = spawnSync(binary, args, { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  const actual = (command.stdout + command.stderr).includes('match rules.');
  assert.equal(actual, expected, args.join(' '));
  return { file: artifact.file, domain, expected, actual };
}));
const { artifacts, buildId: nativeBuildId, ...native } = result.native;
const evidence = {
  repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  source: build.source, definition: result.definition, buildId: result.buildId, nativeBuildId,
  tools: build.tools, ...native, report: result.report,
  artifacts: artifacts.map(({ content: _content, ...rest }) => rest), decompiledRulesEqualSource: true, decompiledSourceFormat: decompiled.version, matches,
};
await writeFile(join(out, 'build.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(evidence));
