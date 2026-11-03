import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNative, decodedTerms, projectTerms, renderRuleJson, type BuildTerm } from '../src/index.js';

const domain: BuildTerm = { type: 'domain_suffix', value: 'example.test' };
const ip: BuildTerm = { type: 'ip_cidr', value: '192.0.2.0/24' };

test('pure IP and mixed IR project independently, deduplicate and preserve OR', () => {
  assert.deepEqual(projectTerms([ip]), { route: [ip], 'dns-query': [], 'dns-response': [ip] });
  assert.deepEqual(projectTerms([ip, domain, domain]), { route: [domain, ip], 'dns-query': [domain], 'dns-response': [ip] });
  assert.equal(renderRuleJson([ip, domain, ip]), renderRuleJson([domain, ip]));
  assert.deepEqual(JSON.parse(renderRuleJson([ip, domain])).rules, [
    { domain_suffix: ['example.test'] }, { ip_cidr: ['192.0.2.0/24'] },
  ]);
  assert.throws(() => projectTerms([]));
  assert.throws(() => renderRuleJson([]));
});

test('decoder normalization tolerates only version, scalar, ordering and exact duplicate differences', () => {
  assert.deepEqual(decodedTerms({ version: 2, rules: [{ ip_cidr: ip.value }, { domain_suffix: domain.value }] }), [domain, ip]);
  for (const rules of [[], [{}], [{ domain: 'a', ip_cidr: ip.value }], [{ type: 'logical', mode: 'and', rules: [] }],
    [{ domain: [] }], [{ source_ip_cidr: ip.value }], [{ domain: 42 }]]) {
    assert.throws(() => decodedTerms({ version: 4, rules }));
  }
  assert.throws(() => decodedTerms({ version: 99, rules: [{ domain: 'a' }] }));
});

test('missing, relative and wrong-version binaries explicitly fail without a passed build', async () => {
  for (const binary of ['', 'sing-box', '/no-such-issue16-binary', process.execPath]) {
    await assert.rejects(buildNative([domain], binary), /binary|Binary/);
  }
  await assert.rejects(buildNative([], process.execPath), /empty/);
});
