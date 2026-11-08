import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { compileRecipe, type RecipeCompileInput, type RuleSubscription } from '../../../config-compiler/src/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { activateRules, rollbackRules } from '../../src/activation.js';
import { checkRules, resumeRules } from '../../src/check-rules.js';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { sha256 } from '../../src/release.js';
import { updateRules } from '../../src/update.js';
import { configuredEnvironment } from './configured-activation-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const branch = 'acceptance-issue-70';
const id = 'china-ip';
const path = 'stable/china-ip';
const ruleUrl = (ref: string, file: string) => `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${ref}/${path}/${file}`;
const format = (file: string) => ({ url: ruleUrl(branch, file), requiredCapabilities: [] });
const formats = { binary: format('route.srs'), source: format('route.json') };
const subscription = { schemaVersion: 2 as const, systemRuleSetId: id, targetVersion: '1.14.4' as const, sourceFormatVersion: 4 as const,
  projections: { route: { formats }, 'dns-query': { unavailable: 'empty' as const }, 'dns-response': { formats } } };
const versionInputs = ['192.0.2.0/25\n2001:db8:1::/48\n', '192.0.2.128/25\n2001:db8:2::/48\n'];

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'china-ip-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = await configuredEnvironment(binary!, directory, branch);
  const configuration = (await readFile(new URL('../../config/china-ip.yml', import.meta.url), 'utf8'))
    .replace('branch: main', `branch: ${branch}`);
  const publication = { repository: env.repository, download: env.transport.download, commit: env.publish };
  const upstreamFetch = (index: number): typeof fetch => async url => {
    const commit = String(index + 1).repeat(40);
    if (String(url).endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: commit } });
    if (String(url) === `https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${commit}/china46.txt`) return new Response(versionInputs[index]);
    throw new Error(`Unexpected upstream request: ${String(url)}`);
  };
  const upstream = async (index: number) => {
    const result = await updateRules({ configuration, selectedIds: [id], publication, fetch: upstreamFetch(index),
      stateDirectory: join(directory, `publish-${index}`), binary: binary! });
    const [entry] = result.results;
    if (entry.status !== 'processed') assert.fail(JSON.stringify(entry));
    return entry.candidate;
  };
  const checkOptions = (fetch: typeof globalThis.fetch) => ({ configuration, publication, fetch, binary: binary!,
    stateDirectory: join(directory, 'check'), subscriptions: { [id]: subscription }, activation: env.transport });
  const status = () => readRemoteStatus({ repository: env.repository, activation: env.transport, publication });
  const options = () => ({ configuration, logicalId: id, subscription, binary: binary!, transport: env.transport, expectedHead: env.head() });
  return { ...env, directory, upstream, status, options,
    check: (index: number, fetch = upstreamFetch(index)) => checkRules(checkOptions(fetch)),
    resume: (index: number) => resumeRules({ ...checkOptions(upstreamFetch(index)), logicalId: id }),
    activate: (candidateEvidenceUrl: string) => activateRules({ ...options(), candidateEvidenceUrl }),
    rollback: (historicalActivationCommit: string) => rollbackRules({ ...options(), historicalActivationCommit }),
  };
}

test('经核验的 china-ip 候选和人工固定随同一组稳定文件提交，回滚恢复历史字节', async t => {
  const env = await fixture(t);
  const a = await env.upstream(0);
  const activeA = await env.activate(a.evidenceUrl!);
  const b = await env.upstream(1);
  const activeB = await env.activate(b.evidenceUrl!);
  const fixedB = await env.activate(b.evidenceUrl!);
  assert.notEqual(fixedB.activation.control?.revision, activeB.activation.control?.revision);
  assert.deepEqual(fixedB.activation.control, { revision: fixedB.activation.id, reason: 'manual-activation',
    pauseAutomaticActivation: true, pauseAutomaticRetry: false });
  assert.deepEqual(fixedB.activation.files, activeB.activation.files);
  assert.deepEqual(Object.keys(fixedB.activation.files).sort(), [`${path}/route.json`, `${path}/route.srs`]);
  const read = (file: string, ref = branch) => env.transport.download(ruleUrl(ref, file));
  assert.deepEqual(JSON.parse((await read('activation.json', fixedB.commit)).toString()), fixedB.activation);
  const before = await env.status();
  assert.equal(before.activeRuleVersions[id].candidate.status, 'available');
  assert.deepEqual(before.activeRuleVersions[id].control, fixedB.activation.control);
  assert.ok(before.rollbackTargets[id].some(target => target.commit === activeA.commit));
  const rolledBack = await env.rollback(activeA.commit);
  assert.equal(rolledBack.activation.candidateId, a.id);
  assert.deepEqual(rolledBack.activation.control, { revision: rolledBack.activation.id, reason: 'manual-rollback',
    pauseAutomaticActivation: true, pauseAutomaticRetry: true });
  assert.deepEqual(await read('route.json'), await read('route.json', activeA.commit));
  assert.deepEqual(await read('route.srs'), await read('route.srs', activeA.commit));
  assert.notDeepEqual(await read('route.srs'), await read('route.srs', activeB.commit));
  assert.deepEqual((await env.status()).activeRuleVersions[id].control, rolledBack.activation.control);
});

test('订阅用途不兼容、候选证据不符时保留当前版本', async t => {
  const env = await fixture(t);
  const a = await env.upstream(0);
  const binaryOnly = { formats: { binary: formats.binary } };
  const missingSource: RuleSubscription = { ...subscription, projections: { ...subscription.projections,
    route: binaryOnly, 'dns-response': binaryOnly } };
  await assert.rejects(activateRules({ ...env.options(), candidateEvidenceUrl: a.evidenceUrl!, subscription: missingSource }),
    /Subscription source format is required/);
  assert.equal(env.writes(), 0);
  const activeA = await env.activate(a.evidenceUrl!);
  const b = await env.upstream(1);
  const before = env.head();
  const invalid = structuredClone(subscription);
  invalid.projections['dns-response'].formats = { ...formats, binary: format('other.srs') };
  await assert.rejects(activateRules({ ...env.options(), candidateEvidenceUrl: b.evidenceUrl!, subscription: invalid }), /stable path/);
  const split: RuleSubscription = { ...subscription, projections: { ...subscription.projections,
    'dns-response': { formats: { binary: formats.binary } } } };
  await assert.rejects(activateRules({ ...env.options(), candidateEvidenceUrl: b.evidenceUrl!, subscription: split }), /file reuse/);
  // Change the registered evidence in both the retained tree and its HTTPS address.
  // Self-consistency is insufficient: it still has to match the registered digest.
  const evidencePath = `candidates/${b.id}/readback.json`;
  const evidenceCommit = new URL(b.evidenceUrl!).pathname.split('/')[3];
  const retained = env.snapshots.get(before)!;
  const archived = env.snapshots.get(evidenceCommit)!;
  const original = archived[evidencePath];
  retained[evidencePath] = archived[evidencePath] = Buffer.concat([original, Buffer.from('\n')]);
  await assert.rejects(env.activate(b.evidenceUrl!), /differs from registered evidence/);
  retained[evidencePath] = archived[evidencePath] = original;
  const srsPath = `candidates/${b.id}/route.srs`;
  const srs = retained[srsPath];
  retained[srsPath] = Buffer.from('altered retained candidate');
  await assert.rejects(env.activate(b.evidenceUrl!), /differs from retained candidate/);
  retained[srsPath] = srs;
  assert.equal(env.head(), before);
  assert.equal((await env.status()).activeRuleVersions[id].activation.id, activeA.activation.id);
  assert.equal(env.writes(), 1);
});

for (const operation of ['activate', 'rollback'] as const) {
  test(`china-ip ${operation} 在提交中断后从远端确认实际结果`, async t => {
    const env = await fixture(t);
    const a = await env.upstream(0), activeA = await env.activate(a.evidenceUrl!);
    const b = await env.upstream(1), activeB = await env.activate(b.evidenceUrl!);
    const run = operation === 'activate' ? () => env.activate(a.evidenceUrl!) : () => env.rollback(activeA.commit);
    const read = async () => {
      const status = await env.status();
      const entry = status.manualOperations.at(-1)!;
      assert.equal(entry.kind, operation);
      return { entry, current: status.activeRuleVersions[id].activation };
    };
    // No local receipt is supplied by the activation or status calls.
    env.fail('not-applied');
    await assert.rejects(run(), /ACTIVATION_UNKNOWN/);
    let state = await read();
    assert.equal(state.current.id, activeB.activation.id);
    assert.equal(state.entry.status, 'pending');
    const pending = state.entry.id;

    env.fail('rejected');
    await assert.rejects(run(), /ACTIVATION_NOT_APPLIED/);
    state = await read();
    assert.equal(state.current.id, activeB.activation.id);
    assert.equal(state.entry.status, 'not-committed');
    assert.equal((await env.status()).manualOperations.find(entry => entry.id === pending)?.status, 'not-committed');

    env.fail('unknown');
    await assert.rejects(run(), /ACTIVATION_UNKNOWN/);
    env.fail('');
    state = await read();
    assert.equal(state.entry.status, 'committed');
    assert.equal(state.entry.commit, env.head());
    assert.equal(state.current.id, state.entry.id);
    assert.equal(state.current.candidateId, a.id);
    const committed = state.entry.id;

    env.fail('applied');
    const confirmed = await run();
    assert.equal((await read()).entry.commit, confirmed.commit);
    assert.equal((await env.status()).manualOperations.find(entry => entry.id === committed)?.status, 'superseded');

    env.fail('readback');
    await assert.rejects(run(), /ACTIVATION_APPLIED_READBACK_PENDING/);
    state = await read();
    assert.equal(state.current.id, state.entry.id);
    assert.equal(state.entry.status, 'pending');
    assert.equal(state.entry.commit, env.head());
    const before = env.writes();
    env.fail('');
    assert.equal((await read()).entry.status, 'committed');
    assert.equal(env.writes(), before);
  });
}

const addresses = [
  { literal: '192.0.2.10', bytes: 'c000020a', version: 0, qtype: 1 },
  { literal: '192.0.2.138', bytes: 'c000028a', version: 1, qtype: 1 },
  { literal: '[2001:db8:1::a]', bytes: '20010db800010000000000000000000a', version: 0, qtype: 28 },
  { literal: '[2001:db8:2::a]', bytes: '20010db800020000000000000000000a', version: 1, qtype: 28 },
];

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

function routeProbe(port: number, literal: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `http://${literal}/`, agent: false,
      headers: { Host: literal }, timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve(body)).on('error', reject);
    });
    req.on('error', reject).on('timeout', () => req.destroy(new Error('Route probe timed out'))).end();
  });
}

function dnsQuestion(index: number, qtype: number) {
  return Buffer.concat([Buffer.from('007001000001000000000000', 'hex'),
    Buffer.from([1, 48 + index, 4]), Buffer.from('test'), Buffer.from([0, 0, qtype, 0, 1])]);
}

function dnsProbe(port: number, index: number) {
  return new Promise<{ rcode: number; count: number; answer: string }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = Buffer.alloc(0), tunnel = false;
    const qtype = addresses[index].qtype;
    socket.setTimeout(1500, () => socket.destroy(new Error('DNS probe timed out')));
    socket.on('error', reject).on('close', () => reject(new Error('DNS probe closed before a response')));
    socket.on('connect', () => socket.write('CONNECT 192.0.2.1:53 HTTP/1.1\r\nHost: 192.0.2.1:53\r\n\r\n'));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk as Buffer]);
      if (!tunnel) {
        const end = received.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.[01] 200 /.test(received.subarray(0, end).toString())) {
          socket.destroy(new Error('DNS probe CONNECT failed')); return;
        }
        received = received.subarray(end + 4);
        tunnel = true;
        const query = dnsQuestion(index, qtype), length = Buffer.alloc(2);
        length.writeUInt16BE(query.length);
        socket.write(Buffer.concat([length, query]));
      }
      if (received.length < 2 || received.length < 2 + received.readUInt16BE(0)) return;
      const bytes = received.subarray(2, 2 + received.readUInt16BE(0));
      if (bytes.length < 12) { socket.destroy(new Error('DNS response too short')); return; }
      const rcode = bytes.readUInt16BE(2) & 0xf, count = bytes.readUInt16BE(6);
      resolve({ rcode, count, answer: count === 1 ? bytes.subarray(-(qtype === 1 ? 4 : 16)).toString('hex') : '' });
      socket.destroy();
    });
  });
}

test('同一真实客户端观察 china-ip 自动更新、固定、回滚、恢复和缓存恢复', { timeout: 70_000 }, async t => {
  const env = await fixture(t);
  const first = await env.check(0);
  assert.equal(first.results[0].status, 'activated', JSON.stringify(first));
  const firstCommit = first.results[0].current?.commit;
  assert.ok(firstCommit);
  const activeA = (await env.status()).activeRuleVersions[id];

  const clientDir = await mkdtemp(join(tmpdir(), 'china-ip-client-'));
  const servers: Server[] = [], sockets = new Set<Duplex>();
  const upstream = createSocket('udp4');
  let child: ChildProcess | undefined, log = '', bound = false;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const process = child;
    const exited = once(process, 'exit');
    const kill = setTimeout(() => process.kill('SIGKILL'), 3000);
    process.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(kill); }
  };
  const close = (server: Server) => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  t.after(async () => {
    try {
      await stop();
      for (const socket of sockets) socket.destroy();
      await Promise.all([...servers.filter(server => server.listening).map(close),
        ...(bound ? [new Promise<void>(resolve => upstream.close(resolve))] : [])]);
    } finally { await rm(clientDir, { recursive: true, force: true }); }
  });

  const exec = promisify(execFile);
  const cert = join(clientDir, 'cert.pem'), key = join(clientDir, 'key.pem');
  const openssl = join(clientDir, 'openssl.cnf');
  await writeFile(openssl, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=raw.githubusercontent.com\n[ext]\nsubjectAltName=DNS:raw.githubusercontent.com\nbasicConstraints=critical,CA:TRUE\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', openssl, '-keyout', key, '-out', cert]);
  let mode: 'stable' | 'download-failure' | 'load-failure' = 'stable';
  let deliveries = 0;
  const stableUrl = subscription.projections.route.formats.binary.url;
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    if (req.url !== new URL(stableUrl).pathname) { res.writeHead(404).end(); return; }
    deliveries++;
    if (mode === 'download-failure') { res.writeHead(503).end(); return; }
    try {
      res.end(mode === 'load-failure' ? Buffer.from('invalid SRS bytes') : await env.transport.download(stableUrl));
    } catch { res.writeHead(500).end(); }
  });
  servers.push(tls);
  const tlsPort = await listen(tls);
  const tunnel = createServer((_req, res) => res.writeHead(404).end());
  servers.push(tunnel);
  tunnel.on('connect', (req, client, initial) => {
    if (req.url !== 'raw.githubusercontent.com:443') { client.destroy(); return; }
    const peer = connect(tlsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      peer.write(initial); client.pipe(peer); peer.pipe(client);
    });
    sockets.add(client); sockets.add(peer);
    for (const [socket, other] of [[client, peer], [peer, client]] as const) {
      socket.on('error', () => socket.destroy()).once('close', () => { sockets.delete(socket); other.destroy(); });
    }
  });
  const tunnelPort = await listen(tunnel);
  const match = createServer((_req, res) => res.end('matched'));
  const miss = createServer((_req, res) => res.end('fallback'));
  servers.push(match, miss);
  const [matchedPort, fallbackPort] = await Promise.all([listen(match), listen(miss)]);

  const placeholder = createServer();
  const routePort = await listen(placeholder);
  await close(placeholder);
  upstream.bind(0, '127.0.0.1');
  await once(upstream, 'listening');
  bound = true;
  const dnsPort = upstream.address().port;
  upstream.on('message', (query, remote) => {
    const target = addresses[query[13] - 48];
    if (!target) return;
    const answer = Buffer.from(target.bytes, 'hex'), packet = Buffer.from(query);
    packet.writeUInt16BE(0x8180, 2); packet.writeUInt16BE(1, 6);
    // sing-box may append EDNS metadata. Preserve only the question.
    packet.writeUInt16BE(0, 10);
    const record = Buffer.from([0xc0, 0x0c, 0, target.qtype, 0, 1, 0, 0, 0, 0, 0, answer.length]);
    upstream.send(Buffer.concat([packet.subarray(0, dnsQuestion(0, target.qtype).length), record, answer]), remote.port, remote.address);
  });

  const template = { schemaVersion: 2, id: 'china-ip-client', revision: '1', targetVersion: '1.14.4',
    defaults: { log: { level: 'debug' }, dns: { final: 'loopback' }, route: { final: 'direct' } },
    resources: {
      inbounds: [{ type: 'mixed', tag: 'route-probe', listen: '127.0.0.1', listen_port: routePort }],
      outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'direct', tag: 'matched' }, { type: 'direct', tag: 'fallback' }],
      dnsServers: [{ type: 'udp', tag: 'loopback', server: '127.0.0.1', server_port: dnsPort }],
    }, platformDnsServers: {}, routePresets: {}, dnsPresets: {}, ecsResponseTags: [],
  } satisfies RecipeCompileInput['dependencies']['templates'][number];
  const input = { params: { ecs: null }, dependencies: { templates: [template], nodes: [], subscriptions: [activeA.activation.subscription] },
    recipe: { schemaVersion: 2, id: template.id, revision: '1', profile: 'macos-standalone', templateRef: { id: template.id, revision: '1' },
      resources: { ruleSets: [{ kind: 'subscription', tag: 'china-ip', subscriptionRef: { systemRuleSetId: id, usages: ['route', 'dns-response'] } }] },
      routeSteps: [
        { id: 'dns', rule: { port: 53, action: 'hijack-dns' } },
        { id: 'match', rule: { rule_set: id, action: 'route', outbound: 'matched' } },
        { id: 'fallback', rule: { inbound: 'route-probe', action: 'route', outbound: 'fallback' } },
      ],
      dnsSteps: [
        { id: 'evaluate', rule: { action: 'evaluate', server: 'loopback', tag: 'answer' } },
        { id: 'match', rule: { match_response: 'answer', rule_set: id, action: 'predefined', rcode: 'NXDOMAIN' } },
        { id: 'respond', rule: { match_response: 'answer', action: 'respond' } },
      ],
    },
  } satisfies RecipeCompileInput;
  const [binding] = input.recipe.resources.ruleSets;
  const invalid = compileRecipe({ ...input, recipe: { ...input.recipe, resources: {
    ruleSets: [{ ...binding, subscriptionRef: { systemRuleSetId: id, usages: ['route', 'dns-response', 'dns-query'] } }],
  } } });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.code === 'ARTIFACT_PROJECTION_EMPTY'), JSON.stringify(invalid.diagnostics));
  const compiled = compileRecipe(input);
  assert.ok(compiled.ok, JSON.stringify(compiled.diagnostics));
  const config = compiled.value.config;
  const route = config.route as { rule_set: { url: string; update_interval?: string; http_client?: string }[]; rules: Record<string, unknown>[] };
  assert.deepEqual(route.rule_set.map(set => set.url), [stableUrl]);
  const cache = join(clientDir, 'cache.db');
  // Harness only: accelerate polling and redirect the chosen outbounds to loopback.
  route.rule_set[0].update_interval = '1s';
  route.rule_set[0].http_client = 'rules';
  (config.dns as Record<string, unknown>).disable_cache = true;
  (config.outbounds as Record<string, unknown>[]).push({ type: 'http', tag: 'loopback-tunnel', server: '127.0.0.1', server_port: tunnelPort });
  config.http_clients = [{ tag: 'rules', version: 1, detour: 'loopback-tunnel' }];
  for (const rule of route.rules) {
    if (rule.outbound !== 'matched' && rule.outbound !== 'fallback') continue;
    rule.override_address = '127.0.0.1';
    rule.override_port = rule.outbound === 'matched' ? matchedPort : fallbackPort;
  }
  config.certificate = { store: 'none', certificate_path: [cert] };
  config.experimental = { cache_file: { enabled: true, path: cache } };
  const configPath = join(clientDir, 'config.json'), configBytes = JSON.stringify(config);
  await writeFile(configPath, configBytes);
  await exec(binary, ['check', '-c', configPath]);
  const start = async () => {
    child = spawn(binary, ['run', '-c', configPath], { cwd: clientDir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => log += chunk);
    child.stderr!.on('data', chunk => log += chunk);
    await once(child, 'spawn');
    return child.pid;
  };
  async function until(observe: () => unknown | Promise<unknown>, description: string) {
    const deadline = Date.now() + 12_000;
    let latest: unknown;
    while (Date.now() < deadline) {
      assert.ok(child?.exitCode === null && child.signalCode === null, log);
      try { if (await observe()) return; }
      catch (error) { latest = error; }
      await delay(150);
    }
    assert.fail(`${description}: ${String(latest)}\n${log.slice(-6000)}`);
  }
  async function probe(version: number) {
    await Promise.all(addresses.map(async ({ literal, bytes, version: hit }, index) => {
      const matched = version === hit;
      const [route, dns] = await Promise.all([routeProbe(routePort, literal), dnsProbe(routePort, index)]);
      assert.equal(route, matched ? 'matched' : 'fallback', literal);
      assert.deepEqual(dns, matched ? { rcode: 3, count: 0, answer: '' } : { rcode: 0, count: 1, answer: bytes }, literal);
    }));
  }
  const observe = (version: number) => until(async () => { await probe(version); return true; }, `Expected CIDRs from version ${version}`);
  const pid = await start();
  await observe(0);
  const automatic = await env.check(1);
  assert.equal(automatic.results[0].status, 'activated', JSON.stringify(automatic));
  await observe(1);
  const activeB = (await env.status()).activeRuleVersions[id].activation;
  await env.activate(activeB.candidateEvidenceUrl);
  const fixed = (await env.status()).activeRuleVersions[id];
  assert.equal(fixed.control?.reason, 'manual-activation');
  const paused = await env.check(0);
  assert.equal(paused.results[0].status, 'paused', JSON.stringify(paused));
  assert.equal(paused.results[0].current?.id, fixed.activation.id);
  const beforeFixedRefresh = deliveries;
  await until(() => deliveries > beforeFixedRefresh, 'Refresh the same URL while manually pinned');
  await probe(1);
  const rollback = await env.rollback(firstCommit);
  await observe(0);
  let sourceRead = false;
  const rolledBack = await env.check(1, async () => { sourceRead = true; throw new Error('Unexpected source access'); });
  assert.equal(rolledBack.results[0].status, 'paused', JSON.stringify(rolledBack));
  assert.equal(rolledBack.results[0].current?.id, rollback.activation.id);
  assert.equal(sourceRead, false);
  const resumed = await env.resume(1);
  assert.equal(resumed.results[0].status, 'activated', JSON.stringify(resumed));
  assert.equal(resumed.results[0].current?.candidateId, activeB.candidateId);
  assert.equal(resumed.results[0].control?.reason, 'manual-resume');
  await observe(1);
  assert.equal(child!.pid, pid);
  for (const [fault, pattern] of [['download-failure', /fetch rule-set china-ip:.*503/],
    ['load-failure', /fetch rule-set china-ip:.*invalid sing-box rule-set file/]] as const) {
    const before = log.length;
    mode = fault;
    await until(() => pattern.test(log.slice(before)), fault);
    await probe(1);
    assert.equal(child!.pid, pid);
  }
  await stop();
  const cacheBytes = await readFile(cache);
  assert.ok(cacheBytes.length > 0);
  for (const socket of sockets) socket.destroy();
  await close(tls);
  const offline = log.length, delivered = deliveries;
  await start();
  await observe(1);
  await until(() => /fetch rule-set china-ip:/.test(log.slice(offline)), 'Offline refresh must fail');
  await probe(1);
  assert.equal(deliveries, delivered);
  assert.equal(await readFile(configPath, 'utf8'), configBytes);
  console.log(JSON.stringify({ chinaIpClient: {
    source: 'controlled CIDR inputs and loopback delivery', stableUrl, configSha256: sha256(configBytes),
    srs: [activeA.activation, fixed.activation].map(record => ({ commit: record.source.commit,
      inputSha256: record.source.inputSha256, artifact: record.files[`${path}/route.srs`] })),
    probes: addresses.map(({ literal }) => literal),
    observed: ['A', 'auto-B', 'fixed-B', 'rollback-A', 'resume-B', 'HTTP-503-retains-B', 'invalid-SRS-retains-B', 'offline-cache-restores-B'],
    cache: { sha256: sha256(cacheBytes), bytes: cacheBytes.length },
  } }));
});

test('仅创建 Git 对象但未切换稳定分支的版本不能作为 china-ip 回滚目标', async t => {
  const env = await fixture(t);
  const a = await env.upstream(0), activeA = await env.activate(a.evidenceUrl!);
  const b = await env.upstream(1);
  env.fail('not-applied');
  let attempted: string | undefined;
  await assert.rejects(env.activate(b.evidenceUrl!), (error: Error) => {
    attempted = /attempted ([a-f0-9]{40})/.exec(error.message)?.[1];
    return Boolean(attempted);
  });
  env.fail('');
  const before = env.head();
  await assert.rejects(env.rollback(attempted!), /ROLLBACK_UNAVAILABLE/);
  assert.equal(env.head(), before);
  assert.equal((await env.status()).activeRuleVersions[id].activation.id, activeA.activation.id);
  assert.equal((await env.rollback(activeA.commit)).activation.candidateId, a.id);
});
