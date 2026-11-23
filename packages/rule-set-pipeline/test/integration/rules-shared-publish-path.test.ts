import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { syncRules } from '../../src/rules-operations.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
assert.ok(binary, 'Set SING_BOX_TEST_BINARY to the sing-box 1.14.4 executable');
const target = 'acceptance-issue-170';
const source = (id: string) => ({
  fetch: { method: 'url', url: `https://rules.example.test/${id}.json` },
  format: 'sing-box-source-json',
});

for (const publishPath of ['stable/shared', 'stable/shared/activation.json']) {
  test(`sync delivers two artifact pairs at ${publishPath} and removes only the withdrawn rule set`, async () => {
    const { context } = cleanupEnvironment(binary, target);
    const snapshot = context.repository.snapshot;
    // GitHub's recursive tree lists directory entries as well as files.
    context.repository.snapshot = async (...args) => {
      const view = await snapshot(...args);
      const directories = new Set<string>();
      for (const path of view.paths) {
        const parts = path.split('/');
        for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join('/'));
      }
      return { ...view, paths: [...directories, ...view.paths], isDirectory: (path: string) => directories.has(path),
        async read(path) {
          if (directories.has(path)) throw new Error(`Invalid remote record type: ${path}`);
          return view.read(path);
        } };
    };
    const first = { data: { source: 'domains' }, publishPath, artifact: 'domains' };
    const second = { data: { source: 'networks' }, publishPath, artifact: 'networks' };
    let ruleSets: Record<string, typeof first> = { 'shared-domains': first, 'shared-networks': second };
    let revision = 1;
    context.readConfiguration = async () => ({
      origin: 'isolated-issue-170', revision: String(revision),
      content: stringify({
        schemaVersion: 4, candidateRetentionDays: 30,
        target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: target },
        sources: { domains: source('domains'), networks: source('networks') }, ruleSets,
      }),
    });
    const domains = { version: 4, rules: [{ domain_suffix: ['shared.example'] }] };
    const networks = { version: 4, rules: [{ ip_cidr: ['192.0.2.0/24'] }] };
    context.fetch = async address => {
      if (address === 'https://rules.example.test/domains.json') return Response.json(domains);
      if (address === 'https://rules.example.test/networks.json') return Response.json(networks);
      throw new Error(`Unexpected source request: ${address}`);
    };

    const initial = await syncRules({ context });
    assert.equal(initial.status, 'success', JSON.stringify(initial));
    assert.deepEqual(initial.results.map(row => [row.id, row.status]),
      [['shared-domains', 'delivered'], ['shared-networks', 'delivered']]);
    const urls = new Map<string, Buffer>();
    for (const [row, expectedName, expectedJson] of [
      [initial.results[0], 'domains', domains],
      [initial.results[1], 'networks', networks],
    ] as const) {
      const prefix = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${target}/${publishPath}/${expectedName}`;
      const formats = { source: { url: prefix + '.json' }, binary: { url: prefix + '.srs' } };
      assert.deepEqual(row.current!.subscription, {
        schemaVersion: 3, systemRuleSetId: row.id, targetVersion: '1.14.4', sourceFormatVersion: 4, formats,
      });
      for (const [format, { url }] of Object.entries(formats)) {
        const bytes = await context.repository.download(url);
        if (format === 'source') assert.deepEqual(JSON.parse(bytes.toString()), expectedJson);
        else assert.ok(bytes.length > 0);
        urls.set(url, bytes);
      }
    }

    ruleSets = { 'shared-networks': second };
    revision++;
    const after = await syncRules({ context });
    assert.equal(after.status, 'success', JSON.stringify(after));
    assert.deepEqual(after.results.map(row => [row.id, row.status]),
      [['shared-domains', 'deleted'], ['shared-networks', 'unchanged']]);
    assert.deepEqual(after.results[1].current, initial.results[1].current);
    for (const [url, bytes] of urls) {
      if (url.includes('/domains.')) await assert.rejects(context.repository.download(url), /404/);
      else assert.deepEqual(await context.repository.download(url), bytes);
    }

    const cleanup = await cleanupRuleHistory({ context });
    assert.equal(cleanup.status, 'success', JSON.stringify(cleanup));
    const retained = await syncRules({ context });
    assert.equal(retained.status, 'success', JSON.stringify(retained));
    assert.equal(retained.results[0].status, 'unchanged');
    assert.equal(retained.results[0].current?.versionId, after.results[1].current?.versionId);
    assert.deepEqual(retained.results[0].current?.files, after.results[1].current?.files);
  });
}
