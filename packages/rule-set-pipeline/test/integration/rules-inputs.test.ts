import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules, pinRuleVersion } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { sha256 } from '../../src/release.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
for (const mechanism of ['latest-release', 'git-branch'] as const) for (const format of ['plain-yaml', 'cidr-text'] as const) {
  test(`配置新增任意仓库：${mechanism} + ${format} 完成交付、证据复验及 pin`, { skip: !binary }, async () => {
    const env = rulesEnvironment(binary!); const config = env.config();
    const repo = 'another-owner/another-repo'; const commit = 'b'.repeat(40), tag = 'v2.3.0';
    const body = format === 'plain-yaml' ? JSON.stringify({ lists: [{ name: 'other', length: 1, rules: ['domain:example.org'] }] }) : '192.0.2.0/24\n2001:db8::/32\n';
    const rule = { ...config.ruleSets[0], id: 'custom', list: format === 'plain-yaml' ? 'other' : 'all', source: 'custom', stablePath: 'stable/custom' };
    if (format === 'cidr-text') rule.usages = { route: { artifact: 'route' }, 'dns-query': { unavailable: 'empty' }, 'dns-response': { artifact: 'route' } };
    config.ruleSets = [rule]; config.sources = { custom: mechanism === 'latest-release'
      ? { repository: repo, version: mechanism, input: { format, asset: 'rules.data', checksum: 'rules.sha256' } }
      : { repository: repo, version: mechanism, branch: 'data/rules', input: { format, path: 'lists/rules.data' } } };
    env.configure(config);
    const requests: string[] = [];
    env.context.fetch = async address => {
      const url = String(address); requests.push(url);
      assert.ok(url.includes(repo), url);
      if (url.includes('/branches/')) { assert.ok(url.endsWith('data%2Frules')); return Response.json({ name: 'data/rules', commit: { sha: commit } }); }
      if (url.includes('raw.githubusercontent.com/')) { assert.ok(url.endsWith(`/${commit}/lists/rules.data`)); return new Response(body); }
      if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: commit } });
      if (url.endsWith('/assets/10')) return new Response(body);
      if (url.endsWith('/assets/11')) return new Response(`${sha256(body)}  rules.data\n`);
      if (url.includes('/releases/')) return Response.json({ id: 3, tag_name: tag, assets: ['rules.data', 'rules.sha256'].map((name, i) =>
        ({ id: i + 10, name, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` })) });
      throw new Error(`Unexpected request ${url}`);
    };
    const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success', JSON.stringify(first));
    assert.equal(first.results[0].current?.source.repository, repo);
    const status = await getRulesStatus({ context: env.context }); assert.equal(status.rules?.[0].candidateCount, 1);
    const before = requests.length;
    const pinned = await pinRuleVersion({ context: env.context, id: 'custom', version: first.results[0].current!.versionId! });
    assert.equal(pinned.status, 'success', JSON.stringify(pinned)); assert.equal(requests.length, before);
  });
}
