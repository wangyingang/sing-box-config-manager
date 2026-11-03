import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildNative, convertRules, readTargetList, NativeBuildError, type BuildTerm, type NativeBuild } from '../../src/index.js';
import { sha256 } from '../../src/release.js';

const exec = promisify(execFile);
const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

async function matches(build: NativeBuild, probes: [string, string, boolean][]) {
  const directory = await mkdtemp(join(tmpdir(), 'rule-match-'));
  const results: { usage: string; file: string; value: string; expected: boolean; matched: boolean }[] = [];
  try {
    for (const artifact of build.artifacts) await writeFile(join(directory, artifact.file), artifact.content);
    for (const [usage, value, expected] of probes) {
      const projection = build.usages[usage as keyof typeof build.usages];
      assert.ok('artifactFiles' in projection);
      for (const file of projection.artifactFiles) {
        const { stdout, stderr } = await exec(binary!, ['rule-set', 'match', join(directory, file), value,
          '--format', file.endsWith('.srs') ? 'binary' : 'source']);
        const matched = (stdout + stderr).includes('match rules.');
        results.push({ usage, file, value, expected, matched });
        assert.equal(matched, expected, `${usage}/${file}/${value}: ${stdout}${stderr}`);
      }
    }
    console.log(JSON.stringify({ matching: results }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const semantics: BuildTerm[] = [
  { type: 'domain_suffix', value: 'example.test' },
  { type: 'domain', value: 'full.test' },
  { type: 'domain_keyword', value: 'needle' },
  { type: 'domain_regex', value: '^API\\.regex\\.test$' },
  { type: 'domain_regex', value: '^api\\.lower\\.test$' },
  { type: 'domain_regex', value: '(?i)^API\\.insensitive\\.test$' },
];

test('real engine source/SRS matching: apex, labels, exact, substring, regexp anchors and case', async () => {
  const build = await buildNative(semantics, binary);
  const probes: [string, boolean][] = [
    ['example.test', true], ['sub.example.test', true], ['badexample.test', false], ['example.test.evil', false],
    ['full.test', true], ['sub.full.test', false], ['full.test.evil', false],
    ['xneedley.test', true], ['need-le.test', false],
    ['API.regex.test', false], ['api.regex.test', false], ['xAPI.regex.test', false], ['API.regex.test.evil', false],
    ['api.lower.test', true], ['API.lower.test', true], ['xapi.lower.test', false], ['api.lower.test.evil', false],
    ['API.insensitive.test', true], ['api.insensitive.test', true], ['xapi.insensitive.test', false],
  ];
  await matches(build, probes.flatMap(([value, expected]) =>
    ['route', 'dns-query'].map(usage => [usage, value, expected] as [string, string, boolean])));
  assert.deepEqual(build.usages.route, build.usages['dns-query']);
  assert.deepEqual(build.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
  console.log(JSON.stringify({ semantics: probes, tool: build.tool, validation: build.validation }));
});

test('fixed official sample independently builds identical JSON/SRS and actual byte metadata', async () => {
  const parsed = readTargetList(await readFile(new URL('../fixtures/20261102130044.category-ai-not-cn.yml', import.meta.url)));
  assert.ok(parsed.ok);
  const converted = convertRules(parsed.rules);
  assert.ok(converted.ok);
  const first = await buildNative(converted.terms, binary);
  const second = await buildNative([...converted.terms].reverse(), binary);
  assert.equal(first.buildId, second.buildId);
  assert.deepEqual(first.artifacts, second.artifacts);
  assert.equal(first.artifacts[0].content.toString(), await readFile(new URL('../fixtures/20261102130044.domains.json', import.meta.url), 'utf8'));
  for (const artifact of first.artifacts) {
    assert.equal(artifact.termCount, 214);
    assert.equal(artifact.sha256, sha256(artifact.content));
    assert.equal(artifact.bytes, artifact.content.byteLength);
    assert.deepEqual(artifact.requiredCapabilities, []);
  }
  await matches(first, [['route', 'openai.com', true], ['dns-query', 'api.openai.com', true],
    ['route', 'notopenai.com', false], ['dns-query', 'unrelated.invalid', false]]);
  console.log(JSON.stringify({ sample: '20261102130044', buildId: first.buildId, tool: first.tool,
    artifacts: first.artifacts.map(({ content: _content, ...metadata }) => metadata), usages: first.usages,
    validation: first.validation }));
});

test('pure IP and mixed synthetic IR use only applicable predicates and deduplicate physical files', async () => {
  const ip: BuildTerm = { type: 'ip_cidr', value: '192.0.2.0/24' };
  const ipv6: BuildTerm = { type: 'ip_cidr', value: '2001:db8::/32' };
  const pure = await buildNative([ip, ipv6], binary);
  assert.deepEqual(pure.usages.route, pure.usages['dns-response']);
  assert.deepEqual(pure.usages['dns-query'], { status: 'unavailable', reason: 'empty' });
  assert.equal(pure.artifacts.length, 2);
  await matches(pure, [['dns-response', '192.0.2.1', true], ['route', '192.0.3.1', false],
    ['dns-response', '2001:db8::1', true], ['dns-response', '2001:db9::1', false]]);
  const mixed = await buildNative([...semantics, ip, ipv6], binary);
  assert.equal(mixed.artifacts.length, 6);
  for (const artifact of mixed.artifacts.filter(a => a.format === 'source')) {
    const rules = JSON.parse(artifact.content.toString()).rules;
    if (artifact.file.startsWith('dns-query')) assert.ok(rules.every((rule: object) => !('ip_cidr' in rule)));
    if (artifact.file.startsWith('dns-response')) assert.ok(rules.every((rule: object) => Object.keys(rule).join() === 'ip_cidr'));
  }
  await matches(mixed, [['route', 'example.test', true], ['route', '192.0.2.1', true],
    ['dns-query', 'example.test', true], ['dns-query', '192.0.2.1', false],
    ['dns-response', 'example.test', false], ['dns-response', '192.0.2.1', true]]);
  console.log(JSON.stringify({ synthetic: 'mixed-ip', usages: mixed.usages,
    artifacts: mixed.artifacts.map(({ content: _content, ...metadata }) => metadata), validation: mixed.validation }));
});

test('target Go engine rejects invalid regexp and CIDR instead of returning a validated partial build', async () => {
  for (const term of [{ type: 'domain_regex', value: '(?=unsupported)' }, { type: 'ip_cidr', value: 'not-a-cidr' }] as BuildTerm[]) {
    await assert.rejects(buildNative([...semantics, term], binary), /Native command failed/);
  }
});

test('compile, decode, load and semantic mismatch faults never return passed builds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-fault-'));
  try {
    for (const stage of ['version', 'compile', 'decompile', 'match', 'semantic']) {
      const wrapper = join(directory, stage);
      const body = stage === 'version'
        ? `if [ \"$1\" = version ]; then echo 'sing-box version 1.14.3'; exit 0; fi`
        : stage === 'semantic'
        ? `if [ "$2" = decompile ]; then printf '%s' '{"version":4,"rules":[{"domain":"corrupted.test"}]}' > "$5"; exit 0; fi`
        : `if [ "$2" = ${stage} ]; then echo injected-${stage}-failure >&2; exit 7; fi`;
      await writeFile(wrapper, `#!/bin/sh\n${body}\nexec '${binary.replaceAll("'", "'\\''")}' "$@"\n`);
      await chmod(wrapper, 0o700);
      await assert.rejects(buildNative(semantics, wrapper), stage === 'version' ? /Expected sing-box 1\.14\.4/ : stage === 'semantic' ? /Semantic round trip failed/ : /injected-/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('term field insertion order does not change validated bytes or build identity', async () => {
  const first = await buildNative(semantics, binary);
  const reordered = semantics.map(({ type, value }) => ({ value, type })).reverse();
  const second = await buildNative(reordered, binary);
  assert.equal(second.buildId, first.buildId);
  assert.deepEqual(second.artifacts, first.artifacts);
  assert.deepEqual(second.usages, first.usages);
  console.log(JSON.stringify({ regression: 'term-field-order', buildId: first.buildId,
    reorderedBuildId: second.buildId, identicalArtifacts: true, tool: second.tool,
    validation: second.validation }));
});

test('native CIDR coalescing preserves pure IP and mixed projection semantics without rewriting source terms', async () => {
  const adjacent: BuildTerm[] = [
    { type: 'ip_cidr', value: '192.0.2.0/25' }, { type: 'ip_cidr', value: '192.0.2.128/25' },
    { type: 'ip_cidr', value: '2001:db8::/33' }, { type: 'ip_cidr', value: '2001:db8:8000::/33' },
  ];
  for (const terms of [adjacent, [semantics[0], ...adjacent]]) {
    const build = await buildNative(terms, binary);
    const repeat = await buildNative([...terms].reverse(), binary);
    assert.equal(build.buildId, repeat.buildId);
    assert.deepEqual(build.artifacts, repeat.artifacts);
    for (const artifact of build.artifacts.filter(artifact => artifact.format === 'source')) {
      const ipRules = JSON.parse(artifact.content.toString()).rules.filter((rule: object) => 'ip_cidr' in rule);
      if (!artifact.file.startsWith('dns-query')) {
        assert.deepEqual(ipRules, [{ ip_cidr: adjacent.map(term => term.value).sort() }]);
      }
    }
    const probes: [string, boolean][] = [['192.0.2.0', true], ['192.0.2.127', true],
      ['192.0.2.128', true], ['192.0.2.255', true], ['192.0.1.255', false], ['192.0.3.0', false],
      ['2001:db8::1', true], ['2001:db8:8000::1', true], ['2001:db9::1', false]];
    await matches(build, probes.flatMap(([value, expected]) =>
      ['route', 'dns-response'].map(usage => [usage, value, expected] as [string, string, boolean])));
    if (terms.length > adjacent.length) {
      await matches(build, [['dns-query', 'example.test', true], ['dns-query', '192.0.2.1', false],
        ['route', 'example.test', true], ['dns-response', 'example.test', false]]);
    }
    for (const artifact of build.artifacts) {
      const domainCount = artifact.file.startsWith('dns-response') || terms.length === adjacent.length ? 0 : 1;
      const ipCount = artifact.file.startsWith('dns-query') ? 0 : artifact.format === 'source' ? 4 : 2;
      assert.equal(artifact.termCount, domainCount + ipCount);
    }
    // Independently inspect actual decoder output to lock down the trigger.
    const directory = await mkdtemp(join(tmpdir(), 'cidr-regression-'));
    try {
      const srs = build.artifacts.find(artifact => artifact.file.endsWith('.srs'))!;
      const path = join(directory, srs.file), decoded = join(directory, 'decoded.json');
      await writeFile(path, srs.content);
      await exec(binary, ['rule-set', 'decompile', path, '-o', decoded]);
      const result = JSON.parse(await readFile(decoded, 'utf8'));
      assert.deepEqual(result.rules.filter((rule: object) => 'ip_cidr' in rule), [
        { ip_cidr: ['192.0.2.0/24', '2001:db8::/32'] },
      ]);
      console.log(JSON.stringify({ regression: 'adjacent-cidr', input: terms, decoded: result,
        buildId: build.buildId, identicalRepeat: true, tool: build.tool,
        artifacts: build.artifacts.map(({ content: _content, ...metadata }) => metadata),
        validation: build.validation }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('decoded CIDR widening and missing IPv4 or IPv6 halves still block validated builds', async () => {
  const terms: BuildTerm[] = [
    { type: 'ip_cidr', value: '192.0.2.0/25' }, { type: 'ip_cidr', value: '192.0.2.128/25' },
    { type: 'ip_cidr', value: '2001:db8::/33' }, { type: 'ip_cidr', value: '2001:db8:8000::/33' },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'cidr-drift-'));
  const failures: { decoded: string[]; message: string; steps: unknown[] }[] = [];
  try {
    for (const [index, decoded] of [
      ['192.0.2.0/23', '2001:db8::/32'],
      ['192.0.2.0/25', '2001:db8::/32'],
      ['192.0.2.0/24', '2001:db8::/33'],
    ].entries()) {
      const wrapper = join(directory, `drift-${index}`);
      const json = JSON.stringify({ version: 2, rules: [{ ip_cidr: decoded }] });
      await writeFile(wrapper, `#!/bin/sh
if [ "$2" = decompile ]; then printf '%s' '${json}' > "$5"; exit 0; fi
exec '${binary.replaceAll("'", "'\\''")}' "$@"
`);
      await chmod(wrapper, 0o700);
      await assert.rejects(buildNative(terms, wrapper), (error: unknown) => {
        assert.ok(error instanceof NativeBuildError);
        assert.match(error.message, /Semantic round trip failed/);
        failures.push({ decoded, message: error.message, steps: error.steps });
        return true;
      });
    }
    console.log(JSON.stringify({ regression: 'cidr-drift-rejection', input: terms, failures }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
