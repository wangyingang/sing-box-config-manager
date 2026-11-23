import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { runRulesCli } from '../../src/cli.js';
import { sha256 } from '../../src/release.js';
import { runRuleAutomation } from '../../src/rule-workflow.js';
import type { RulesResult } from '../../src/rules-model.js';
import type { getRulesStatus } from '../../src/rules-status.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const branch = 'acceptance-issue-169';
const repository = 'wangyingang/sing-box-rule-artifacts';
const url = 'https://rules.example.test/issue-169.json';
const initialInput = {
  version: 4,
  rules: [{ domain_suffix: ['mixed.example'] }, { ip_cidr: ['192.0.2.0/24'] }],
};
const revisedInput = {
  version: 4,
  rules: [{ domain_suffix: ['resumed.example'] }, { ip_cidr: ['198.51.100.0/24'] }],
};

const publishPath = (id: string) => `stable/issue-169/${id}`;
const subscriptionPaths = (id: string) => [`${publishPath(id)}/${id}.json`, `${publishPath(id)}/${id}.srs`] as const;
const stableUrl = (path: string) => `https://raw.githubusercontent.com/${repository}/${branch}/${path}`;

function fixture(ids: string[]) {
  const env = rulesEnvironment(binary!, branch);
  let revision = 1;
  let input = initialInput;
  const requests: string[] = [];
  env.context.fetch = async address => {
    assert.equal(String(address), url);
    requests.push(url);
    return Response.json(input);
  };
  env.context.readConfiguration = async () => ({
    revision: String(revision),
    origin: 'isolated-fixture',
    content: stringify({
      schemaVersion: 4, candidateRetentionDays: 30,
      target: { repository, branch },
      sources: { example: { fetch: { method: 'url', url }, format: 'sing-box-source-json' } },
      ruleSets: Object.fromEntries(ids.map(id => [id, { data: { source: 'example' }, publishPath: publishPath(id), artifact: id }])),
    }),
  });
  return { ...env, requests,
    setInput(next: typeof initialInput) { input = next; },
    setRules(next: string[]) { ids = next; revision++; },
    readPublished(id: string) {
      return Promise.all(subscriptionPaths(id).map(path => env.context.repository.download(stableUrl(path))));
    },
  };
}

test('v4 status, pin and resume operate on the rule version from an empty target', async () => {
  const id = 'mixed';
  const env = fixture([id]);
  const [json, srs] = subscriptionPaths(id);
  async function rules(...args: string[]) {
    let report: Awaited<ReturnType<typeof getRulesStatus>> | undefined;
    const code = await runRulesCli([...args, '--json'], output => { report = JSON.parse(output); }, env.context, () => {});
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(report?.status, 'success');
    return report;
  }

  const first = (await rules('sync')).results[0].current!;
  const version = first.versionId!;
  assert.ok(version);
  const published = await env.readPublished(id);
  const status = (await rules('status', id)).rules![0];
  assert.deepEqual(status.current, first);
  assert.deepEqual(status.candidates.map(({ versionId, current, selectable }) => ({ versionId, current, selectable })),
    [{ versionId: version, current: true, selectable: true }]);
  assert.equal(status.control?.mode, 'auto');
  assert.deepEqual(first.subscription, {
    schemaVersion: 3, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats: { source: { url: stableUrl(json) }, binary: { url: stableUrl(srs) } },
  });

  const pinned = (await rules('pin', id, version)).results[0];
  assert.equal(pinned.status, 'pinned');
  assert.equal(pinned.control?.mode, 'pinned');
  assert.equal(pinned.control.candidateId, first.candidateId);
  assert.equal(pinned.current?.versionId, version);
  assert.deepEqual(pinned.current.subscription, first.subscription);
  env.setInput(revisedInput);
  const skipped = (await rules('sync')).results[0];
  assert.equal(skipped.status, 'pinned-skipped');
  assert.equal(skipped.current?.versionId, version);
  assert.deepEqual(env.requests, [url]);
  assert.deepEqual(await env.readPublished(id), published);

  const resumed = (await rules('resume', id)).results[0];
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.control?.mode, 'auto');
  assert.ok(resumed.current?.versionId);
  assert.notEqual(resumed.current.versionId, version);
  assert.deepEqual(resumed.current.subscription, first.subscription);
  assert.deepEqual((await rules('status', id)).rules![0].current, resumed.current);
  const [sourceBytes, binaryBytes] = await env.readPublished(id);
  assert.deepEqual(JSON.parse(sourceBytes.toString()), revisedInput);
  assert.notDeepEqual(binaryBytes, published[1]);
  assert.equal(sha256(binaryBytes), resumed.current.files[srs].sha256);
});

test('v4 sync keeps the previous pair on SRS validation failure, skips a failed first pair and delivers its peer', async t => {
  const env = fixture(['existing', 'peer']);
  async function automaticSync() {
    let report: RulesResult | undefined;
    const code = await runRuleAutomation({ event: 'push', target: branch }, output => { report = JSON.parse(output); }, env.context);
    assert.ok(report);
    assert.equal(report.operation, 'sync');
    assert.equal(report.exitCode, code);
    return report;
  }
  const initial = await automaticSync();
  assert.equal(initial.status, 'success', JSON.stringify(initial));
  const previous = await env.readPublished('existing');
  const previousPeer = await env.readPublished('peer');
  const previousById = new Map(initial.results.map(row => [row.id, row.current]));

  const directory = await mkdtemp(join(tmpdir(), 'rules-issue-169-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = join(directory, 'sing-box');
  await writeFile(wrapper, `#!/bin/sh
if [ "$2" = match ] && [ "$3" = existing.srs ]; then
  echo 'injected SRS validation failure' >&2
  exit 7
fi
if [ "$2" = compile ] && [ "$3" = first.json ]; then
  echo 'injected SRS compile failure' >&2
  exit 7
fi
exec '${binary.replaceAll("'", "'\\''")}' "$@"
`, { mode: 0o700 });
  env.context.binary = wrapper;
  env.setInput(revisedInput);
  env.setRules(['existing', 'first', 'peer']);

  const result = await automaticSync();
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results.map(({ id, status }) => [id, status]),
    [['existing', 'failed'], ['first', 'failed'], ['peer', 'delivered']]);
  const [existing, first, peer] = result.results;
  assert.match(existing.error!, /injected SRS validation failure/);
  assert.deepEqual(existing.current, previousById.get('existing'));
  assert.deepEqual(await env.readPublished('existing'), previous);
  assert.match(first.error!, /injected SRS compile failure/);
  assert.equal(first.current, undefined);
  const snapshot = await env.context.repository.snapshot();
  for (const path of subscriptionPaths('first')) assert.equal(await snapshot.read(path), undefined);

  assert.ok(peer.current?.versionId);
  assert.notEqual(peer.current.versionId, previousById.get('peer')?.versionId);
  const [peerJson, peerSrs] = await env.readPublished('peer');
  assert.deepEqual(JSON.parse(peerJson.toString()), revisedInput);
  assert.notDeepEqual(peerSrs, previousPeer[1]);
  const [jsonPath, srsPath] = subscriptionPaths('peer');
  assert.equal(await env.context.repository.lastChange(snapshot.head, jsonPath),
    await env.context.repository.lastChange(snapshot.head, srsPath));
});
