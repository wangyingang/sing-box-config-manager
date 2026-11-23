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
import { compileRecipe, renderSubscription, type RecipeCompileInput } from '../../../config-compiler/src/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { formalConfiguration } from '../fixtures/formal-configuration.js';
import { publishRecipe, readPublication } from '../../../config-compiler/src/publisher.js';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const branch = 'acceptance-issue-97-cidr';
const id = 'china-ip';
const path = 'stable/china-ip';
const ruleUrl = (ref: string, file: string) => `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${ref}/${path}/${file}`;
const format = (file: string) => ({ url: ruleUrl(branch, file), requiredCapabilities: [] });
const formats = { binary: format('ips.srs'), source: format('ips.json') };
const subscription = { schemaVersion: 2 as const, systemRuleSetId: id, targetVersion: '1.14.4' as const, sourceFormatVersion: 4 as const,
  projections: { route: { formats }, 'dns-query': { unavailable: 'empty' as const }, 'dns-response': { formats } } };
const versionInputs = ['192.0.2.0/25\n2001:db8:1::/48\n', '192.0.2.128/25\n2001:db8:2::/48\n'];

async function fixture() {
  const env = rulesEnvironment(binary!, branch);
  const configuration = formalConfiguration();
  configuration.ruleSets = configuration.ruleSets.filter(rule => rule.id === id);
  env.configure({ ...configuration, target: { ...configuration.target, branch } });
  let revision = 0;
  const requests: string[] = [];
  env.context.fetch = async url => {
    const address = String(url);
    requests.push(address);
    const commit = String(revision + 1).repeat(40);
    if (address.endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: commit } });
    if (address === `https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${commit}/china46.txt`) return new Response(versionInputs[revision]);
    throw new Error(`Unexpected upstream request: ${address}`);
  };
  return { ...env, requests, changeInput(index: number) { revision = index; } };
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

test('同一真实客户端观察 china-ip sync、pin、resume 和缓存恢复', { timeout: 70_000 }, async t => {
  const env = await fixture();
  const request = { context: env.context };
  const first = await syncRules(request);
  assert.equal(first.status, 'success', JSON.stringify(first));
  assert.equal(first.results[0].status, 'delivered');
  const activeA = first.results[0].current!;
  assert.deepEqual(activeA.subscription, { schemaVersion: 3, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats: { binary: { url: formats.binary.url }, source: { url: formats.source.url } } });

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
      res.end(mode === 'load-failure' ? Buffer.from('invalid SRS bytes') : await env.context.repository.download(stableUrl));
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
  const input = { params: { ecs: null }, dependencies: { templates: [template], nodes: [], subscriptions: [subscription] },
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
  const publicationDir = join(clientDir, 'publication');
  const publication = await publishRecipe(input, { binary, directory: publicationDir });
  assert.ok(publication.ok, JSON.stringify(publication.diagnostics));
  const retained = await readPublication(publicationDir);
  const publicationBytes = JSON.stringify(retained), recipeBytes = JSON.stringify(input.recipe);
  const rendered = await renderSubscription(retained, input.params);
  assert.ok(rendered.ok, JSON.stringify(rendered.diagnostics));
  const config = rendered.value;
  const route = config.route as { rule_set: { url: string; update_interval?: string; http_client?: string }[]; rules: Record<string, unknown>[] };
  assert.deepEqual(route.rule_set.map(set => set.url), [stableUrl]);
  const cache = join(clientDir, 'cache.db');
  // Harness only: accelerate polling and redirect the chosen outbounds to loopback.
  assert.equal(route.rule_set[0].update_interval, undefined);
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
  const observations: unknown[] = [];
  async function probe(version: number) {
    const results = await Promise.all(addresses.map(async ({ literal, bytes, version: hit }, index) => {
      const matched = version === hit;
      const [route, dns] = await Promise.all([routeProbe(routePort, literal), dnsProbe(routePort, index)]);
      assert.equal(route, matched ? 'matched' : 'fallback', literal);
      assert.deepEqual(dns, matched ? { rcode: 3, count: 0, answer: '' } : { rcode: 0, count: 1, answer: bytes }, literal);
      return { literal, route, dns };
    }));
    const observation = { version, pid: child!.pid, results, observedAt: new Date().toISOString() };
    observations.push(observation);
    return observation;
  }
  const observe = (version: number) => until(async () => { await probe(version); return true; }, `Expected CIDRs from version ${version}`);
  const pid = await start();
  await observe(0);
  env.changeInput(1);
  const automatic = await syncRules(request);
  assert.equal(automatic.status, 'success', JSON.stringify(automatic));
  assert.equal(automatic.results[0].status, 'delivered');
  await observe(1);
  const activeB = automatic.results[0].current!;
  assert.notEqual(activeB.versionId, activeA.versionId);
  const fixed = await pinRuleVersion({ ...request, id, version: activeB.versionId! });
  assert.equal(fixed.status, 'success', JSON.stringify(fixed));
  assert.equal(fixed.results[0].control?.mode, 'pinned');
  env.changeInput(0);
  const sourceReads = env.requests.length;
  const writes = env.writes.length;
  const paused = await syncRules(request);
  assert.equal(paused.status, 'success', JSON.stringify(paused));
  assert.equal(paused.results[0].status, 'pinned-skipped');
  assert.equal(paused.results[0].current?.versionId, activeB.versionId);
  assert.equal(env.requests.length, sourceReads);
  assert.equal(env.writes.length, writes);
  const beforeFixedRefresh = deliveries;
  await until(() => deliveries > beforeFixedRefresh, 'Refresh the same URL while manually pinned');
  await probe(1);
  const pinnedA = await pinRuleVersion({ ...request, id, version: activeA.versionId! });
  assert.equal(pinnedA.status, 'success', JSON.stringify(pinnedA));
  assert.equal(pinnedA.results[0].control?.mode, 'pinned');
  assert.equal(pinnedA.results[0].current?.versionId, activeA.versionId);
  assert.deepEqual(pinnedA.results[0].current?.source, activeA.source);
  await observe(0);
  env.changeInput(1);
  const readsBeforeSkipped = env.requests.length;
  const rolledBack = await syncRules(request);
  assert.equal(rolledBack.status, 'success', JSON.stringify(rolledBack));
  assert.equal(rolledBack.results[0].status, 'pinned-skipped');
  assert.equal(rolledBack.results[0].current?.versionId, activeA.versionId);
  assert.equal(env.requests.length, readsBeforeSkipped);
  const resumed = await resumeRuleUpdates({ ...request, id });
  assert.equal(resumed.status, 'success', JSON.stringify(resumed));
  assert.equal(resumed.results[0].current?.candidateId, activeB.candidateId);
  assert.equal(resumed.results[0].current?.versionId, activeB.versionId);
  assert.equal(resumed.results[0].control?.mode, 'auto');
  await observe(1);
  assert.equal(child!.pid, pid);
  const faults = [];
  for (const [fault, pattern] of [['download-failure', /fetch rule-set china-ip:.*503/],
    ['load-failure', /fetch rule-set china-ip:.*invalid sing-box rule-set file/]] as const) {
    const before = log.length;
    mode = fault;
    await until(() => pattern.test(log.slice(before)), fault);
    await probe(1);
    faults.push({ fault, log: log.slice(before), retainedVersion: 1, sameProcess: child!.pid === pid });
    assert.equal(child!.pid, pid);
  }
  await stop();
  const cacheBytes = await readFile(cache);
  assert.ok(cacheBytes.length > 0);
  for (const socket of sockets) socket.destroy();
  await close(tls);
  const offline = log.length, delivered = deliveries;
  const restartedPid = await start();
  assert.notEqual(restartedPid, pid);
  await observe(1);
  await until(() => /fetch rule-set china-ip:/.test(log.slice(offline)), 'Offline refresh must fail');
  await probe(1);
  assert.equal(deliveries, delivered);
  assert.equal(await readFile(configPath, 'utf8'), configBytes);
  assert.equal(JSON.stringify(input.recipe), recipeBytes);
  assert.equal(JSON.stringify(await readPublication(publicationDir)), publicationBytes);
  const status = await getRulesStatus(request);
  assert.equal(status.status, 'success', JSON.stringify(status));
  assert.equal(status.rules?.[0].current?.versionId, activeB.versionId);
  assert.deepEqual(status.rules?.[0].current?.subscription, activeA.subscription);
  const evidence = {
    source: 'controlled CIDR inputs and in-memory Git; real sing-box and loopback HTTPS',
    operations: { first, automatic, fixed, paused, pinnedA, rolledBack, resumed },
    stableUrl, configSha256: sha256(configBytes), recipeSha256: sha256(recipeBytes),
    publicationId: retained.id, publicationSha256: sha256(publicationBytes),
    client: { pid, restartedPid, binary, sameProcessUntilCacheRestart: true },
    srs: [activeA, activeB].map(record => ({ commit: 'commit' in record.source ? record.source.commit : undefined,
      inputSha256: record.source.inputSha256, artifact: record.files[`${path}/ips.srs`] })),
    probes: addresses.map(({ literal }) => literal),
    observed: ['A', 'sync-B', 'pin-B', 'pinned-sync-B', 'pin-A', 'pinned-sync-A', 'resume-B', 'HTTP-503-retains-B', 'invalid-SRS-retains-B', 'offline-cache-restores-B'],
    observations, faults, offlineFailureLog: log.slice(offline),
    cache: { sha256: sha256(cacheBytes), bytes: cacheBytes.length, noRuleBytesDelivered: deliveries === delivered },
  };
  console.log(JSON.stringify({ rulesCidrClient: evidence }));
  if (process.env.RULE_CIDR_CLIENT_EVIDENCE) await writeFile(process.env.RULE_CIDR_CLIENT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
});
