import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { serialize } from 'node:v8';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import { sha256 } from '../../src/release.js';
import { pinRuleVersion, resumeRuleUpdates, syncRules } from '../../src/rules-operations.js';
import { encodeRecord, parseRulesJournal, RULE_RECEIPT_PATH, RULE_STATE_PATH } from '../../src/rules-model.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { candidateArtifactFiles } from '../../src/candidate-publication.js';
import { immutableUrl } from '../../src/publication.js';
import { countNativeCommands } from '../fixtures/native-commands.js';

const binary = process.env.SING_BOX_TEST_BINARY;

async function traceNative(t: TestContext, beforeExec = '') {
  const directory = await mkdtemp(join(tmpdir(), 'rules-native-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = join(directory, 'sing-box'), log = `${wrapper}.log`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await writeFile(log, '');
  await writeFile(wrapper, `#!/bin/sh
printf '%s\\n' "$*" >> "$0.log"
${beforeExec}
exec ${quote(binary!)} "$@"
`, { mode: 0o700 });
  return {
    wrapper,
    async take() {
      const commands = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
      await writeFile(log, '');
      return countNativeCommands(commands);
    },
  };
}

const oneNativeValidation = { compile: 1, decompile: 0, sourceLoad: 1, binaryLoad: 1 };
const noNativeValidation = { compile: 0, decompile: 0, sourceLoad: 0, binaryLoad: 0 };

test('Release 与 Git 输入更新后同语义保留交付，零编译和加载，并独立记住新输入', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = parseBuildConfiguration(readOfficialConfiguration());
  config.ruleSets = config.ruleSets.filter(rule => ['openai', 'china-ip'].includes(rule.id));
  env.configure(config);
  let revision = 'a', cidr = '192.0.2.0/24\n2001:db8::/32\n';
  const fetcher = env.context.fetch!;
  let gitBodies = 0;
  env.context.fetch = async (address, init) => {
    const url = String(address);
    if (url.startsWith('https://raw.githubusercontent.com/gaoyifan/')) gitBodies++;
    if (url.includes('gaoyifan/china-operator-ip')) return url.includes('/branches/')
      ? Response.json({ name: 'ip-lists', commit: { sha: revision.repeat(40) } })
      : new Response(cidr);
    return fetcher(address, init);
  };
  const request = { context: env.context };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  assert.deepEqual(await take(), { compile: 2, decompile: 0, sourceLoad: 2, binaryLoad: 2 });
  const original = first.results.map(result => result.current);
  const stableHead = env.heads.get('main');
  env.upstream({ other: 'domain:changed.example' });
  revision = 'b'; cidr = '# same networks\n2001:db8::/32\n192.0.2.0/24\n';
  const next = await syncRules(request);
  assert.equal(next.status, 'success', JSON.stringify(next));
  assert.deepEqual(next.results.map(result => result.status), ['unchanged', 'unchanged']);
  assert.deepEqual(await take(), noNativeValidation);
  assert.deepEqual(next.results.map(result => result.current), original);
  assert.equal(env.heads.get('main'), stableHead);
  const observed = await getRulesStatus(request);
  const release = observed.rules!.find(rule => rule.id === 'openai')!.successfulInput;
  const git = observed.rules!.find(rule => rule.id === 'china-ip')!.successfulInput;
  assert.equal(release?.source && 'releaseId' in release.source && release.source.releaseId, 2);
  assert.equal(git?.source.commit, 'b'.repeat(40));
  for (const result of next.results) {
    assert.ok(result.reliedOn?.includes('historical-native'));
    assert.ok(!result.verified?.includes('native'));
    assert.equal(result.successfulInput?.candidateId, result.current?.candidateId);
  }
  const writes = env.writes.length;
  gitBodies = 0;
  env.requests.length = 0;
  const repeated = await syncRules(request);
  assert.equal(repeated.status, 'success', JSON.stringify(repeated));
  assert.equal(gitBodies, 0);
  assert.deepEqual(env.requests.filter(url => url.includes('/releases/assets/')), []);
  for (const result of repeated.results) {
    assert.ok(result.verified?.includes('source-identity'));
    assert.ok(!result.verified?.includes('normalized-content'));
    assert.ok(result.reliedOn?.includes('historical-normalized-content'));
  }
  assert.equal(env.writes.length, writes);
  assert.deepEqual(await take(), noNativeValidation);
  const oldHeads = new Set(env.trees.keys());
  assert.equal((await cleanupRuleHistory(request)).status, 'success');
  oldHeads.forEach(head => env.blockedHeads.add(head));
  await take();
  const cleanedWrites = env.writes.length;
  const afterCleanup = await syncRules(request);
  assert.equal(afterCleanup.status, 'success', JSON.stringify(afterCleanup));
  assert.deepEqual(await take(), noNativeValidation);
  assert.equal(env.writes.length, cleanedWrites);
  assert.deepEqual(afterCleanup.results.map(result => result.successfulInput), next.results.map(result => result.successfulInput));
  assert.notEqual(afterCleanup.results[0].current?.candidateEvidenceUrl, original[0]?.candidateEvidenceUrl);
});

test('Git 分支移动后只复用可信的同路径 blob，缺失或改变时读取固定正文', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = parseBuildConfiguration(readOfficialConfiguration());
  config.ruleSets = config.ruleSets.filter(rule => rule.id === 'china-ip');
  const input = config.sources[config.ruleSets[0].source];
  assert.equal(input.version, 'git-branch');
  input.input.path = 'lists/china46.txt';
  env.configure(config);
  let revision = 1;
  const requests: string[] = [];
  const commit = (id: number) => String(id).repeat(40);
  const body = (id: number) => id < 3 ? '192.0.2.0/24\n' : '192.0.3.0/24\n';
  const oid = (id: number, base: string) => id.toString(16).padStart(2, base).repeat(20);
  const blob = (id: number) => createHash('sha1').update(`blob ${Buffer.byteLength(body(id))}\0`).update(body(id)).digest('hex');
  env.context.fetch = async address => {
    const url = String(address);
    requests.push(url);
    if (url.endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: commit(revision) } });
    const sha = url.split('/').at(-1)!;
    if (url.includes('/git/commits/')) return Response.json({ sha, tree: { sha: oid(Number(sha[0]), 'a') } });
    if (url.includes('/git/trees/')) {
      const id = Number(sha[1]);
      return Response.json({ sha, truncated: id === 4, tree: sha[0] === 'a'
        ? [{ path: 'lists', type: 'tree', mode: '040000', sha: oid(id, 'b') }]
        : [{ path: 'china46.txt', type: 'blob', mode: id === 5 ? '120000' : '100644', sha: blob(id), size: Buffer.byteLength(body(id)) }] });
    }
    assert.ok(url.endsWith(`/${commit(revision)}/lists/china46.txt`));
    return new Response(body(revision));
  };
  const sync = async (id: number) => {
    requests.length = 0;
    revision = id;
    const result = await syncRules({ context: env.context });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.results[0].successfulInput?.source.commit, commit(id));
    assert.equal(requests.filter(url => url.includes('/branches/')).length, 1);
    return { result: result.results[0], downloads: requests.filter(url => url.startsWith('https://raw.githubusercontent.com/')).length };
  };
  const first = await sync(1);
  assert.equal(first.downloads, 1);
  assert.deepEqual(await take(), oneNativeValidation);
  const equivalent = await sync(2);
  assert.equal(equivalent.downloads, 0);
  assert.deepEqual(equivalent.result.current, first.result.current);
  assert.ok(equivalent.result.verified?.includes('source-identity'));
  assert.deepEqual(await take(), noNativeValidation);
  const processedWrites = env.writes.length;
  assert.equal((await sync(2)).downloads, 0);
  assert.equal(requests.length, 1, 'same full commit needs no tree lookup');
  assert.equal(env.writes.length, processedWrites);

  const changed = await sync(3);
  assert.equal(changed.downloads, 1);
  assert.equal(changed.result.status, 'delivered');
  assert.equal(changed.result.current?.source.commit, commit(3));
  assert.deepEqual(await take(), oneNativeValidation);
  for (const id of [4, 5]) {
    const fallback = await sync(id);
    assert.equal(fallback.downloads, 1);
    assert.ok(fallback.result.verified?.includes('normalized-content'));
    assert.deepEqual(fallback.result.current, changed.result.current);
    assert.deepEqual(await take(), noNativeValidation);
  }
});

test('Release 按附件 ID 和摘要短路，保留同 tag 替换与首次或回退输入校验', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config();
  config.ruleSets = [config.ruleSets[0]];
  env.configure(config);
  const repo = config.sources.dlc.repository;
  const tag = 'fixed-tag';
  let checksumFailures = 0;
  let assetId = 11, rule = 'domain:a.example', yamlDigest = true, checksumDigest = true, badChecksum = false;
  const downloads: number[] = [];
  env.context.fetch = async address => {
    const url = String(address);
    const input = JSON.stringify({ lists: [{ name: 'openai', length: 1, rules: [rule] }] });
    const checksum = `${badChecksum ? '0'.repeat(64) : sha256(input)}  dlc.dat_plain.yml\n`;
    if (url.endsWith('/releases/latest')) return Response.json({ id: 1, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, index) => ({
        id: assetId + index, name, state: 'uploaded', size: index ? checksum.length : input.length, updated_at: '2026-11-18T00:00:00Z',
        browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
        ...(index ? checksumDigest && { digest: `sha256:${sha256(checksum)}` } : yamlDigest && { digest: `sha256:${sha256(input)}` }),
      })) });
    if (url.endsWith(`/git/ref/tags/${tag}`)) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    const match = /\/releases\/assets\/(\d+)$/.exec(url);
    assert.ok(match, url);
    const id = Number(match[1]);
    downloads.push(id);
    assert.ok(id === assetId || id === assetId + 1);
    if (id === assetId + 1 && checksumFailures > 0) {
      checksumFailures--;
      return new Response(null, { status: 503 });
    }
    return new Response(id === assetId ? input : checksum);
  };
  async function sync(expected: number[], status: 'success' | 'failed' = 'success') {
    downloads.length = 0;
    const result = await syncRules({ context: env.context });
    assert.equal(result.status, status, JSON.stringify(result));
    assert.deepEqual([...downloads].sort((a, b) => a - b), expected);
    return result.results[0];
  }
  // Even when both GitHub digests exist, first acquisition checks the attached checksum.
  badChecksum = true;
  assert.match((await sync([11, 12], 'failed')).error!, /SHA-256/);
  badChecksum = false;
  const first = await sync([11, 12]);
  assert.equal(first.status, 'delivered');
  assert.deepEqual(await take(), oneNativeValidation);
  checksumDigest = false;
  assert.ok((await sync([12])).verified?.includes('source-identity'));
  assert.deepEqual(await take(), noNativeValidation);

  checksumFailures = 1;
  assert.ok((await sync([11, 12, 12])).verified?.includes('normalized-content'));
  assert.deepEqual(await take(), noNativeValidation);

  // A successfully downloaded checksum is shared with fallback, even if it disagrees.
  badChecksum = true;
  assert.match((await sync([11, 12], 'failed')).error!, /SHA-256/);
  assert.deepEqual(await take(), noNativeValidation);
  badChecksum = false;
  await sync([11, 12]); // A previous error requires full processing.
  assert.deepEqual(await take(), oneNativeValidation);
  yamlDigest = false;
  assert.ok((await sync([11, 12])).verified?.includes('normalized-content'));
  assert.deepEqual(await take(), noNativeValidation);

  yamlDigest = checksumDigest = true;
  assetId = 21;
  const reuploaded = await sync([]);
  assert.ok(reuploaded.verified?.includes('source-identity'));
  assert.deepEqual(reuploaded.current, first.current);
  const reuploadedSource = reuploaded.successfulInput?.source;
  assert.equal(reuploadedSource && 'yaml' in reuploadedSource && reuploadedSource.yaml.id, 21);
  assert.deepEqual(await take(), noNativeValidation);

  assetId = 31;
  rule = 'domain:b.example';
  const replacement = await sync([31, 32]);
  assert.equal(replacement.status, 'delivered');
  const observed = replacement.successfulInput?.source;
  assert.equal(observed && 'yaml' in observed && observed.yaml.id, 31);
  assert.notEqual(replacement.current?.candidateId, first.current?.candidateId);
  assert.deepEqual(await take(), oneNativeValidation);
  assert.ok((await sync([])).verified?.includes('source-identity'));
  assert.deepEqual(await take(), noNativeValidation);
});

test('同源成功集跳过正文转换，失败集仍共用一次必要的 Release 下载并单独重试', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const request = { context: env.context };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  await take();

  env.upstream({ anthropic: 'unsupported:invalid.example' });
  const next = await syncRules(request);
  assert.equal(next.status, 'partial', JSON.stringify(next));
  assert.deepEqual(await take(), noNativeValidation);
  assert.ok(next.results.find(result => result.id === 'openai')?.verified?.includes('normalized-content'));
  env.requests.length = 0;
  const retried = await syncRules(request);
  assert.equal(retried.status, 'partial', JSON.stringify(retried));
  assert.deepEqual(await take(), noNativeValidation);
  assert.equal(env.requests.filter(url => url.endsWith('/releases/latest')).length, 1);
  assert.equal(env.requests.filter(url => url.includes('/git/ref/tags/')).length, 1);
  assert.deepEqual(env.requests.filter(url => url.includes('/releases/assets/')).sort().map(url => url.split('/').at(-1)), ['21', '22']);

  const openai = retried.results.find(result => result.id === 'openai')!;
  assert.deepEqual(openai.current, first.results.find(result => result.id === 'openai')?.current);
  assert.ok(openai.verified?.includes('source-identity'));
  assert.deepEqual(openai.successfulInput, next.results.find(result => result.id === 'openai')?.successfulInput);
  const anthropic = retried.results.find(result => result.id === 'anthropic')!;
  assert.equal(anthropic.status, 'failed');
  assert.deepEqual(anthropic.successfulInput, first.results.find(result => result.id === 'anthropic')?.successfulInput);
});

test('cleanup 回收到期的成功候选后，resume 从旧 pin 回退到实际构建和交付', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context, id: 'openai' };
  const original = (await syncRules(request)).results[0].current!;
  env.upstream({ openai: 'domain:latest.example' });
  const changed = (await syncRules(request)).results[0].current!;
  assert.notEqual(changed.versionId, original.versionId);
  assert.equal((await pinRuleVersion({ ...request, version: original.versionId! })).status, 'success');
  env.requests.length = 0;
  const pinned = await syncRules(request);
  assert.equal(pinned.results[0].status, 'pinned-skipped');
  assert.equal(pinned.results[0].successfulInput?.candidateId, changed.candidateId);
  assert.equal(env.requests.length, 0);
  env.clock('2026-12-20T00:00:00.000Z');
  const cleaned = await cleanupRuleHistory(request);
  assert.equal(cleaned.status, 'success', JSON.stringify(cleaned));
  assert.ok(cleaned.cleanup?.plan.discard.candidateIds.includes(changed.candidateId));
  assert.equal((await getRulesStatus(request)).rules![0].successfulInput, undefined);
  await take();
  const resumed = await resumeRuleUpdates(request);
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].status, 'resumed');
  assert.deepEqual(await take(), oneNativeValidation);
  assert.notEqual(resumed.results[0].current?.candidateId, changed.candidateId);
  assert.equal(resumed.results[0].successfulInput?.candidateId, resumed.results[0].current?.candidateId);
  assert.deepEqual(resumed.results[0].current?.source, changed.source);
  assert.deepEqual(resumed.results[0].current?.files, changed.files);
});

test('缺少候选证据时重新构建，原证据仍存的旧输入不能跳过', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  const original = first.results[0].current!;
  const journal = await env.journal();
  delete journal.candidates[original.candidateId].evidenceUrl;
  const repo = env.context.repository;
  await repo.commit(repo.branch, (await repo.snapshot()).head, { [RULE_STATE_PATH]: encodeRecord(journal) }, 'fixture', async () => {});
  await take();
  env.requests.length = 0;
  const repaired = await syncRules(request);
  assert.ok(env.requests.some(url => url.endsWith('/releases/assets/11')));
  assert.equal(repaired.status, 'success', JSON.stringify(repaired));
  assert.equal(repaired.results[0].status, 'delivered');
  assert.deepEqual(await take(), oneNativeValidation);
  assert.notEqual(repaired.results[0].current?.candidateId, original.candidateId);
  assert.deepEqual(repaired.results[0].current?.files, original.files);
  assert.equal(repaired.results[0].successfulInput?.candidateId, repaired.results[0].current?.candidateId);
});

test('来源别名保留成功关联，换列表、工具内容变化和同 ID 重建重新走原生验证', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  env.upstream({ other: 'domain:openai.example' });
  const request = { context: env.context };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  await take();
  config.sources.alias = config.sources.dlc;
  config.ruleSets[0].source = 'alias';
  env.configure(config);
  const alias = await syncRules(request);
  assert.equal(alias.results[0].status, 'unchanged');
  assert.deepEqual(await take(), noNativeValidation);
  assert.deepEqual(alias.results[0].successfulInput, first.results[0].successfulInput);

  config.ruleSets[0].list = 'other';
  env.configure(config);
  const list = await syncRules(request);
  assert.equal(list.results[0].status, 'delivered', JSON.stringify(list));
  assert.deepEqual(await take(), oneNativeValidation);
  assert.notEqual(list.results[0].successfulInput?.inputBindingRevision, alias.results[0].successfulInput?.inputBindingRevision);

  appendFileSync(wrapper, '\n# New executable digest\n');
  env.requests.length = 0;
  const tool = await syncRules(request);
  assert.ok(env.requests.some(url => url.endsWith('/releases/assets/21')));
  assert.equal(tool.results[0].status, 'delivered', JSON.stringify(tool));
  assert.deepEqual(await take(), oneNativeValidation);
  assert.notEqual(tool.results[0].successfulInput?.toolSha256, list.results[0].successfulInput?.toolSha256);

  env.configure({ ...config, ruleSets: [] });
  assert.equal((await syncRules(request)).results[0].status, 'deleted');
  env.configure(config);
  const recreated = await syncRules(request);
  assert.equal(recreated.results[0].status, 'delivered', JSON.stringify(recreated));
  assert.deepEqual(await take(), oneNativeValidation);
  assert.notEqual(recreated.results[0].successfulInput?.definitionGeneration, tool.results[0].successfulInput?.definitionGeneration);
});

test('同义输入的成功记录提交与 pin 并发时不会越过 journal 租约', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context, id: 'openai' };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  await take();
  env.upstream({ other: 'domain:unrelated.example' });
  let pinned = false;
  env.beforeWrite(async files => {
    if (!files[RULE_STATE_PATH]) return;
    const next = parseRulesJournal(files[RULE_STATE_PATH]!);
    const source = next.rules.openai.successfulInput?.source;
    if (!source || !('releaseId' in source) || source.releaseId !== 2) return;
    env.beforeWrite();
    const pin = await pinRuleVersion({ ...request, version: first.results[0].current!.versionId! });
    assert.equal(pin.status, 'success', JSON.stringify(pin));
    pinned = true;
  });
  const raced = await syncRules(request);
  assert.ok(pinned);
  assert.notEqual(raced.status, 'success');
  assert.match(raced.results[0].error!, /RULE_WRITE_CONFLICT/);
  assert.equal(raced.results[0].control?.mode, 'pinned');
  assert.deepEqual(raced.results[0].successfulInput, first.results[0].successfulInput);
  assert.deepEqual(await take(), oneNativeValidation, 'only the competing pin runs native validation');
});

test('稳定回读恢复成功后记账，候选 HTTPS 断开不阻塞已应用交付', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context };
  env.failDownload(url => { if (url.includes('/stable/')) throw new Error('interrupted stable readback'); });
  const interrupted = await syncRules(request);
  assert.equal(interrupted.status, 'pending', JSON.stringify(interrupted));
  const journal = await env.journal(), pending = journal.pendingDelivery!;
  assert.ok(pending.record);
  assert.equal(interrupted.results[0].current?.candidateId, pending.record.candidateId);
  assert.equal(journal.rules.openai.successfulInput, undefined);
  const stableHead = env.heads.get('main');
  env.failDownload(url => { if (url.includes('/candidates/')) throw new Error('503 candidate HTTPS only'); });
  env.failSource(true);
  const recovered = await syncRules({ context: { ...env.context } });
  // The independent latest-input step is offline, but the applied delivery is complete.
  assert.equal(recovered.status, 'failed', JSON.stringify(recovered));
  assert.match(recovered.results[0].error!, /Upstream unavailable/);
  assert.equal(env.heads.get('main'), stableHead);
  const after = await env.journal();
  assert.equal(after.pendingDelivery, undefined);
  assert.equal(after.rules.openai.successfulInput?.candidateId, pending.record.candidateId);
  assert.deepEqual(after.rules.openai.successfulInput?.source, pending.record.source);
});

test('单分支稳定交付回读回执原提交，后续 head 不改变固定地址', { skip: !binary }, async () => {
  const env = rulesEnvironment(binary!, 'acceptance-receipt-commit');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const repo = env.context.repository, commit = repo.commit;
  let deliveryCommit: string | undefined;
  repo.commit = async (...args) => {
    const head = await commit(...args);
    if (args[2][RULE_RECEIPT_PATH] && Object.keys(args[2]).some(path => path.startsWith('stable/'))) {
      deliveryCommit = head;
      await commit(args[0], head, { 'unrelated.txt': Buffer.from('appended after stable write') }, 'fixture append', async () => {});
    }
    return head;
  };
  const result = await syncRules({ context: env.context });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.ok(deliveryCommit);
  const stable = Object.keys(result.results[0].current!.files).map(path => immutableUrl(deliveryCommit!, path));
  assert.deepEqual(result.readbackRequests?.filter(url => url.includes('/stable/')).sort(), stable.sort());
});

test('首次 sync、pin 和 cleanup 各执行一组原生验证，同版本 resume 使用历史证明', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context, id: config.ruleSets[0].id };
  const counts = [];
  const sync = await syncRules(request);
  assert.equal(sync.status, 'success', JSON.stringify(sync));
  counts.push(await take());
  const version = sync.results[0].current!.versionId!;
  const pin = await pinRuleVersion({ ...request, version });
  assert.equal(pin.status, 'success', JSON.stringify(pin));
  counts.push(await take());
  const resume = await resumeRuleUpdates(request);
  assert.equal(resume.status, 'success', JSON.stringify(resume));
  counts.push(await take());
  const cleanup = await cleanupRuleHistory(request);
  assert.equal(cleanup.status, 'success', JSON.stringify(cleanup));
  assert.ok(env.refWrites.length);
  counts.push(await take());
  assert.deepEqual(counts, [oneNativeValidation, oneNativeValidation, noNativeValidation, oneNativeValidation], 'sync, pin, resume, cleanup');
});

test('首次交付与清理只回读各自需要的规则地址', { skip: !binary }, async t => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context };
  const downloads: string[] = [];
  env.failDownload(url => { downloads.push(url); });

  for (const [operation, run] of [['sync', syncRules], ['cleanup', cleanupRuleHistory]] as const) {
    await t.test(operation, async () => {
      downloads.length = 0;
      const result = await run(request);
      assert.equal(result.status, 'success', JSON.stringify(result));
      const candidate = Object.values((await env.journal()).candidates)[0];
      const stable = operation === 'sync' ? env.heads.get('main') : 'main';
      const paths = ['domains.json', 'domains.srs'];
      assert.deepEqual(downloads.map(url => new URL(url).pathname).sort(), [
        ...paths.map(file => `/wangyingang/sing-box-rule-artifacts/${candidate.filesCommit}/candidates/${candidate.id}/${file}`),
        ...paths.map(file => `/wangyingang/sing-box-rule-artifacts/${stable}/${config.ruleSets[0].stablePath}/${file}`),
      ].sort());
    });
  }
});

test('status、预览与无回收 cleanup 检查 Git 且没有 Raw 请求或写入', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context };
  assert.equal((await syncRules(request)).status, 'success');
  const version = (await getRulesStatus(request)).rules![0].candidates[0].versionId!;
  assert.equal((await cleanupRuleHistory(request)).status, 'success');
  const writes = env.writes.length;
  const urls: string[] = [];
  env.failDownload(url => { urls.push(url); });
  for (let run = 0; run < 2; run++) {
    const status = await getRulesStatus(request);
    assert.equal(status.status, 'success');
    assert.equal(status.rules![0].candidates[0].selectable, true);
    assert.deepEqual(status.readbackRequests, []);
  }
  const selection = { ...request, id: config.ruleSets[0].id, dryRun: true };
  for (const run of [
    () => syncRules(selection), () => pinRuleVersion({ ...selection, version }), () => resumeRuleUpdates(selection),
    () => cleanupRuleHistory(selection),
  ]) {
    const preview = await run();
    assert.equal(preview.status, 'success', JSON.stringify(preview));
    assert.deepEqual(preview.readbackRequests, []);
  }
  const unchanged = await cleanupRuleHistory(request);
  assert.equal(unchanged.status, 'success', JSON.stringify(unchanged));
  assert.equal(unchanged.cleanup?.phase, 'unchanged');
  assert.deepEqual(urls, []);
  assert.equal(env.writes.length, writes);
});

test('pin 在稳定写入前重新读取当前保留树并拒绝字节变化', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const request = { context: env.context };
  const sync = await syncRules(request);
  assert.equal(sync.status, 'success');
  const candidate = Object.values((await env.journal()).candidates)[0];
  const path = `candidates/${candidate.id}/domains.srs`;
  const url = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${candidate.filesCommit}/${path}`;
  const original = Buffer.from(await env.context.repository.download(url));
  const stableHead = env.heads.get('main');
  let downloaded = 0;
  env.failDownload(address => { if (address === url) downloaded++; });
  let retained: Map<string, Buffer> | undefined;
  const pin = await pinRuleVersion({ ...request, id: candidate.logicalId, version: candidate.versionId!, onProgress({ stage }) {
    if (stage !== 'stable-write') return;
    retained = env.trees.get(env.heads.get('candidates')!);
    retained!.set(path, Buffer.from('replaced retained bytes'));
  } });
  assert.equal(pin.status, 'pending', JSON.stringify(pin));
  assert.match(pin.results[0].error!, /Readback integrity mismatch/);
  assert.equal(downloaded, 0);
  assert.equal(env.heads.get('main'), stableHead);
  assert.deepEqual(await env.context.repository.download(url), original);
  retained!.set(path, original);
  assert.equal((await pinRuleVersion({ ...request, id: candidate.logicalId, version: candidate.versionId! })).status, 'success');
});

test('工具摘要变化时重新执行校验，两次 pin 调用共用 context 仍各自确认', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const sync = await syncRules({ context: env.context });
  assert.equal(sync.status, 'success', JSON.stringify(sync));
  const version = sync.results[0].current!.versionId!;
  await take();
  let toolChanged = false;
  const request = { context: env.context, id: config.ruleSets[0].id, version };
  const pin = await pinRuleVersion({ ...request, onProgress({ stage }) {
    if (stage !== 'stable-write') return;
    appendFileSync(wrapper, '\n# Different executable digest\n');
    toolChanged = true;
  } });
  assert.equal(pin.status, 'success', JSON.stringify(pin));
  assert.ok(toolChanged);
  assert.deepEqual(await take(), { compile: 2, decompile: 0, sourceLoad: 2, binaryLoad: 2 });
  assert.equal((await pinRuleVersion(request)).status, 'success');
  assert.deepEqual(await take(), oneNativeValidation);
});

test('执行中途工具发生变化时拒绝首个结果，同操作中相同内容仍可重新验证', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t, `
if [ "$2" = match ] && [ "$6" = binary ] && [ ! -e "$0.changed" ]; then
  touch "$0.changed"
  printf '\\n# Tool changed during native validation\\n' >> "$0"
fi`);
  const env = rulesEnvironment(wrapper, 'main');
  env.upstream({ openai: 'domain:shared.example', anthropic: 'domain:shared.example' });
  const result = await syncRules({ context: env.context });
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.equal(result.results[0].id, 'openai');
  assert.match(result.results[0].error!, /Binary changed during build/);
  assert.equal(result.results[1].status, 'delivered');
  assert.deepEqual(await take(), { compile: 2, decompile: 0, sourceLoad: 2, binaryLoad: 2 });
});

test('失败的原生加载可在同次操作用同一工具重试', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t, `
if [ "$2" = match ] && [ "$6" = binary ] && [ ! -e "$0.failed" ]; then
  touch "$0.failed"
  echo 'transient binary load failure' >&2
  exit 7
fi`);
  const env = rulesEnvironment(wrapper, 'main');
  env.upstream({ openai: 'domain:shared.example', anthropic: 'domain:shared.example' });
  const result = await syncRules({ context: env.context });
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.match(result.results[0].error!, /transient binary load failure/);
  assert.equal(result.results[1].status, 'delivered');
  assert.deepEqual(await take(), { compile: 2, decompile: 0, sourceLoad: 2, binaryLoad: 2 });
});

test('复用 pin 原生证明后以当前正式配置保护迟到的稳定写入', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = cleanupEnvironment(wrapper, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const sync = await syncRules({ context: env.context });
  assert.equal(sync.status, 'success', JSON.stringify(sync));
  const version = sync.results[0].current!.versionId!, stableHead = env.heads.get('main');
  await take();
  let superseded = false;
  env.beforeWrite(async files => {
    if (!Object.keys(files).some(path => path.startsWith('stable/'))) return;
    env.beforeWrite();
    superseded = true;
    env.configure({ ...config, ruleSets: [] });
  });
  const result = await pinRuleVersion({ context: env.context, id: config.ruleSets[0].id, version });
  assert.ok(superseded);
  assert.equal(result.status, 'pending', JSON.stringify(result));
  assert.match(result.results[0].error!, /RULE_INTENT_SUPERSEDED/);
  assert.equal(env.heads.get('main'), stableHead);
  assert.equal((await env.journal()).rules.openai.control.mode, 'auto');
  assert.deepEqual(await take(), oneNativeValidation);
});

test('新 Node 进程从持久回读阶段恢复原候选并重新执行一组原生验证', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = rulesEnvironment(wrapper, 'main');
  const configuration = env.config(); configuration.ruleSets = [configuration.ruleSets[0]]; env.configure(configuration);
  const repo = env.context.repository, commit = repo.commit;
  repo.commit = async (...args) => {
    const head = await commit(...args);
    if (Object.keys(args[2]).some(path => path.endsWith('/readback.json'))) throw new Error('RULE_WRITE_CONFLICT: interrupted after evidence');
    return head;
  };
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  assert.deepEqual(await take(), oneNativeValidation);
  const { heads, trees, parents } = env;
  const journal = parseRulesJournal((await (await repo.snapshot()).read(RULE_STATE_PATH))!);
  const [candidate] = Object.values(journal.candidates);
  const path = `${wrapper}.state`;
  await writeFile(path, serialize({ configuration, heads, trees, parents }));
  const child = `
    import { readFile } from 'node:fs/promises';
    import { deserialize } from 'node:v8';
    import { rulesEnvironment } from './test/fixtures/rules-environment.ts';
    import { syncRules } from './src/rules-operations.ts';
    const [path, binary] = process.argv.slice(1);
    const persisted = deserialize(await readFile(path));
    const env = rulesEnvironment(binary, 'main', persisted);
    env.configure(persisted.configuration);
    console.log(JSON.stringify(await syncRules({ context: env.context })));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child, path, wrapper],
    { cwd: new URL('../../', import.meta.url) });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'success', stdout);
  assert.equal(result.results[0].current.candidateId, candidate.id);
  assert.deepEqual(await take(), oneNativeValidation);
});

test('正式四集首次交付回读 16 个规则地址，成功基线重复同步的五项预算均为零', { skip: !binary }, async t => {
  const { wrapper, take } = await traceNative(t);
  const env = rulesEnvironment(wrapper, 'main');
  env.configure(parseBuildConfiguration(readOfficialConfiguration()));
  const fetcher = env.context.fetch!;
  let gitBodies = 0;
  env.context.fetch = async (address, init) => {
    const url = String(address);
    if (url.startsWith('https://raw.githubusercontent.com/gaoyifan/')) gitBodies++;
    if (url.includes('gaoyifan/china-operator-ip')) return url.includes('/branches/')
      ? Response.json({ name: 'ip-lists', commit: { sha: 'b'.repeat(40) } })
      : new Response('192.0.2.0/24\n2001:db8::/32\n');
    return fetcher(address, init);
  };
  const raw = new Map<string, Buffer>();
  const repository = env.context.repository, download = repository.download;
  repository.download = async url => {
    const bytes = await download(url);
    assert.ok(!raw.has(url), `duplicate Raw request: ${url}`);
    raw.set(url, Buffer.from(bytes));
    return bytes;
  };
  const result = await syncRules({ context: env.context });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.deepEqual(await take(), { compile: 4, decompile: 0, sourceLoad: 4, binaryLoad: 4 });
  const writes = env.writes.length;
  assert.equal(env.writes.filter(write => write.branch === 'main').length, 4);
  const retained = await repository.snapshot(), stable = await repository.snapshot('main');
  const journal = parseRulesJournal((await retained.read(RULE_STATE_PATH))!);
  const expected: string[] = [];
  for (const rule of result.results) {
    const current = rule.current!;
    const candidate = journal.candidates[current.candidateId];
    const stableCommit = await repository.lastChange(stable.head, `${candidate.definition.stablePath}/activation.json`);
    for (const file of Object.values(candidateArtifactFiles(candidate.definition))) {
      const candidatePath = `candidates/${candidate.id}/${file}`;
      const stablePath = `${candidate.definition.stablePath}/${file}`;
      const candidateUrl = immutableUrl(candidate.filesCommit!, candidatePath);
      const stableUrl = immutableUrl(stableCommit, stablePath);
      expected.push(candidateUrl, stableUrl);
      const bytes = await retained.read(candidatePath);
      assert.ok(bytes?.length);
      assert.deepEqual(raw.get(candidateUrl), bytes);
      assert.deepEqual(raw.get(stableUrl), bytes);
      assert.equal(sha256(bytes!), current.files[stablePath].sha256);
    }
  }
  assert.equal(raw.size, 16);
  assert.deepEqual([...raw.keys()].sort(), expected.sort());
  assert.deepEqual(result.readbackRequests, [...raw.keys()]);
  raw.clear();
  assert.equal(gitBodies, 1);
  gitBodies = 0;
  env.requests.length = 0;
  const unchanged = await syncRules({ context: env.context });
  assert.equal(unchanged.status, 'success', JSON.stringify(unchanged));
  assert.deepEqual(unchanged.results.map(rule => rule.current), result.results.map(rule => rule.current));
  assert.ok(unchanged.results.every(rule => rule.status === 'unchanged' && rule.verified?.includes('source-identity')));
  assert.equal(gitBodies, 0);
  assert.deepEqual(env.requests.filter(url => url.includes('/releases/assets/')), []);
  assert.equal(env.requests.filter(url => url.endsWith('/releases/latest')).length, 1);
  assert.deepEqual(await take(), noNativeValidation);
  assert.equal(env.writes.length, writes);
  assert.equal(raw.size, 0);
  assert.deepEqual(unchanged.readbackRequests, []);
});

for (const target of ['main', 'acceptance-performance']) for (const stage of [1, 2, 3, 4, 5, 6, 7]) {
  test(`${target}: 第 ${stage} 阶段提交后中断，换会话恢复原候选与已登记版本`, { skip: !binary }, async () => {
    const env = cleanupEnvironment(binary!, target);
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    const repo = env.context.repository, commit = repo.commit, snapshot = repo.snapshot;
    let interrupted = false;
    repo.snapshot = async branch => {
      if (interrupted) throw new Error('RULE_WRITE_CONFLICT: process interrupted');
      return snapshot(branch);
    };
    repo.commit = async (...args) => {
      const head = await commit(...args);
      if (env.writes.length === stage + 1) { interrupted = true; throw new Error('RULE_WRITE_CONFLICT: process interrupted'); }
      return head;
    };
    assert.notEqual((await syncRules({ context: env.context })).status, 'success');
    repo.commit = commit; repo.snapshot = snapshot;
    const before = await env.journal(), candidate = Object.values(before.candidates)[0];
    assert.deepEqual(before.rules.openai.successfulInput?.source, stage === 7 ? candidate.source : undefined);
    const retained = await snapshot();
    const bytes = new Map(await Promise.all(retained.paths.filter(path => path.startsWith(`candidates/${candidate.id}/`))
      .map(async path => [path, await retained.read(path)] as const)));
    const stableWrites = env.writes.filter(write => Object.keys(write.files).some(path => path.startsWith('stable/'))).length;
    env.clock('2026-11-19T00:00:00.000Z');
    const result = await syncRules({ context: { ...env.context } });
    assert.equal(result.status, 'success', JSON.stringify(result));
    const after = await env.journal(), recovered = after.candidates[candidate.id];
    assert.deepEqual(Object.keys(after.candidates), [candidate.id]);
    assert.equal(recovered.buildId, candidate.buildId); assert.deepEqual(recovered.source, candidate.source);
    if (candidate.versionId) {
      assert.equal(recovered.versionId, candidate.versionId); assert.equal(recovered.publishedAt, candidate.publishedAt);
    }
    for (const [path, original] of bytes) assert.deepEqual(await (await snapshot()).read(path), original, path);
    assert.equal(result.results[0].current?.candidateId, candidate.id);
    assert.equal(after.pendingDelivery, undefined);
    assert.deepEqual(after.rules.openai.successfulInput?.source, candidate.source);
    assert.equal(after.rules.openai.successfulInput?.candidateId, candidate.id);
    if (stableWrites) assert.equal(env.writes.filter(write => Object.keys(write.files).some(path => path.startsWith('stable/'))).length, stableWrites);
    const count = env.writes.length;
    assert.equal((await syncRules({ context: { ...env.context } })).status, 'success');
    assert.equal(env.writes.length, count);
  });

  test(`${target}: 第 ${stage} 阶段提交成功但响应丢失，核实原写入且不重复提交`, { skip: !binary }, async () => {
    const env = rulesEnvironment(binary!, target);
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    const repo = env.context.repository, commit = repo.commit;
    let lost = false;
    repo.commit = async (...args) => {
      const head = await commit(...args);
      if (!lost && env.writes.length === stage + 1) { lost = true; throw new PublicationWriteError(head, new Error('response lost')); }
      return head;
    };
    const result = await syncRules({ context: env.context });
    assert.equal(result.status, 'success', JSON.stringify(result)); assert.ok(lost);
    assert.equal(env.writes.length, 8);
    assert.equal((await getRulesStatus({ context: env.context })).rules?.[0].candidateCount, 1);
  });
}

test('候选合格但交付准备失败时单独保存 verified，不登记 pending 或切换 current', { skip: !binary }, async () => {
  const env = cleanupEnvironment(binary!, 'main');
  const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
  const repo = env.context.repository, snapshot = repo.snapshot;
  let failPreparation = false;
  env.beforeWrite(async files => {
    if (Object.keys(files).some(path => path.endsWith('/readback.json'))) failPreparation = true;
  });
  repo.snapshot = async branch => {
    if (branch === 'main' && failPreparation) throw new Error('delivery preparation unavailable');
    return snapshot(branch);
  };
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  repo.snapshot = snapshot; env.beforeWrite();
  const journal = await env.journal(); const candidate = Object.values(journal.candidates)[0];
  assert.equal(candidate.status, 'verified'); assert.ok(candidate.evidenceUrl);
  assert.equal(journal.pendingDelivery, undefined);
  assert.equal(env.writes.filter(write => write.branch === 'main').length, 0);
  assert.equal((await getRulesStatus({ context: env.context })).rules?.[0].candidateCount, 1);
  assert.equal((await syncRules({ context: { ...env.context } })).results[0].current?.candidateId, candidate.id);
});

for (const rival of ['sync', 'pin', 'change-source', 'delete', 'cleanup'] as const) {
  // Exercise later actual writes in the existing concurrency matrix as well:
  // metadata must retain the pin/CAS guard, evidence the configuration guard.
  const stage = rival === 'pin' ? 'manifest.json' : rival === 'change-source' ? 'readback.json' : '.srs';
  test(`候选 ${stage} 阶段与 ${rival} 并发时，迟到写入不覆盖最新状态`, { skip: !binary }, async () => {
    const env = cleanupEnvironment(binary!, 'main');
    const config = env.config(); config.ruleSets = [config.ruleSets[0]]; env.configure(config);
    const first = await syncRules({ context: env.context }); assert.equal(first.status, 'success');
    const version = first.results[0].current!.versionId!;
    env.upstream({ openai: 'domain:next.example' });
    let rivalResult: unknown; let afterRival = '';
    env.beforeWrite(async files => {
      const registering = files['pipeline/state.json'] && Object.values(parseRulesJournal(files['pipeline/state.json']!).candidates)
        .some(candidate => candidate.status === 'building');
      if (rival === 'cleanup' ? !registering : !Object.keys(files).some(path => path.endsWith(stage))) return;
      env.beforeWrite();
      const request = { context: { ...env.context } };
      if (rival === 'pin') rivalResult = await pinRuleVersion({ ...request, id: 'openai', version });
      else if (rival === 'cleanup') {
        rivalResult = await cleanupRuleHistory(request);
        assert.equal((rivalResult as { status: string }).status, 'success', JSON.stringify(rivalResult));
        assert.ok(env.refWrites.length);
      } else {
        if (rival === 'change-source') { const next = env.config(); next.ruleSets[0].list = 'other'; env.configure(next); }
        if (rival === 'delete') env.configure({ ...env.config(), ruleSets: [], sources: {} });
        rivalResult = await syncRules(request);
      }
      afterRival = env.heads.get('candidates')!;
    });
    const result = await syncRules({ context: env.context });
    assert.ok(rivalResult); assert.notEqual(result.status, 'success', JSON.stringify(result));
    assert.equal(env.heads.get('candidates'), afterRival);
    if (rival === 'pin') assert.equal((await env.journal()).rules.openai.control.mode, 'pinned');
    if (rival === 'delete') assert.equal((await env.journal()).rules.openai.lifecycle, 'deleted');
    if (rival === 'cleanup') assert.equal((await env.journal()).maintenance, 'open');
  });
}
