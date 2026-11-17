import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { renderSubscription, type RuleSubscription } from '../../../config-compiler/src/index.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { publishRecipe, readPublication } from '../../../config-compiler/src/publisher.js';
import { rulesEnvironment } from '../fixtures/rules-environment.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const branch = 'acceptance-issue-97-domain';
const domain = 'updated.issue19.test';
const url = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/stable/openai/domains.srs`;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function freePort() {
  const server = createHttpServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function proxyRoute(port: number) {
  return new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `http://${domain}/`, method: 'GET',
      headers: { Host: domain, Connection: 'close' }, timeout: 1500 }, response => {
      let body = ''; response.on('data', b => body += b); response.on('end', () => resolve(body));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Route probe timeout'))); req.end();
  });
}
function dnsQuestion() {
  const name = Buffer.concat([...domain.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  const header = Buffer.alloc(12); header.writeUInt16BE(0x1919); header.writeUInt16BE(0x100, 2); header.writeUInt16BE(1, 4);
  return Buffer.concat([header, name, Buffer.from([0, 1, 0, 1])]);
}
async function proxyDns(port: number) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0), connected = false;
    socket.setTimeout(1500, () => socket.destroy(new Error('DNS probe timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write('CONNECT 192.0.2.1:53 HTTP/1.1\r\nHost: 192.0.2.1:53\r\n\r\n'));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (!connected) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        if (!buffer.subarray(0, end).toString().includes('200')) return socket.destroy(new Error('DNS CONNECT failed'));
        buffer = buffer.subarray(end + 4); connected = true;
        const query = dnsQuestion(), length = Buffer.alloc(2); length.writeUInt16BE(query.length);
        socket.write(Buffer.concat([length, query]));
      }
      if (buffer.length < 2 || buffer.length < buffer.readUInt16BE(0) + 2) return;
      const message = buffer.subarray(2, 2 + buffer.readUInt16BE(0));
      if (message.readUInt16BE(6) !== 1) return socket.destroy(new Error('Expected one DNS answer'));
      const address = [...message.subarray(-4)].join('.'); socket.end(); resolve(address);
    });
  });
}

// All network redirection, trust material and accelerated timing belong only to
// this isolated process. No hosts, production endpoint or actual client is changed.
test('只发布一次 v2 Recipe，同一进程通过原 URL 观察 sync、pin、resume 后的 DNS 和 Route', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rules-domain-client-'));
  const servers: Server[] = [], sockets = new Set<Duplex>();
  const dns = createSocket('udp4');
  let child: ChildProcess | undefined, log = '', failed = false, dnsBound = false;
  const downloads: { url: string; sha256: string; observedAt: string }[] = [];
  try {
    const env = rulesEnvironment(binary, branch);
    env.configure({ ...env.config(), ruleSets: [env.config().ruleSets[0]] });
    env.upstream({ openai: 'domain:old.issue19.test' });
    const request = { context: env.context };
    const first = await syncRules(request);
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.equal(first.results[0].status, 'delivered');
    const activeA = first.results[0].current!;
    const subscription = activeA.subscription as RuleSubscription;
    const inputBytesA = await env.context.repository.download(url);
    await writeFile(join(directory, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=raw.githubusercontent.com\n[ext]\nsubjectAltName=DNS:raw.githubusercontent.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(directory, 'openssl.cnf'),
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
    const tlsServer = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, async (req, res) => {
      const prefix = `/${ARTIFACT_REPOSITORY}/${branch}/`;
      const address = `https://raw.githubusercontent.com${req.url}`;
      const bytes = req.url?.startsWith(prefix) ? await env.context.repository.download(address).catch(() => undefined) : undefined;
      if (bytes) downloads.push({ url: `https://raw.githubusercontent.com${req.url}`, sha256: sha256(bytes), observedAt: new Date().toISOString() });
      res.writeHead(bytes ? 200 : 404, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
    });
    servers.push(tlsServer);
    const tlsPort = await listen(tlsServer);
    const tunnel = createHttpServer(); servers.push(tunnel);
    tunnel.on('connect', (req, client, initial) => {
      if (req.url !== 'raw.githubusercontent.com:443') return client.destroy();
      const upstream = connect(tlsPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (initial.length) upstream.write(initial); client.pipe(upstream); upstream.pipe(client); });
      sockets.add(client); sockets.add(upstream);
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    });
    const tunnelPort = await listen(tunnel);
    const matched = createHttpServer((_req, res) => res.end('route-matched-B'));
    const fallback = createHttpServer((_req, res) => res.end('route-fallback-A'));
    servers.push(matched, fallback);
    const matchedPort = await listen(matched), fallbackPort = await listen(fallback), mixedPort = await freePort();
    dns.on('message', (query, remote) => {
      const response = Buffer.from(query); response.writeUInt16BE(0x8180, 2); response.writeUInt16BE(1, 6);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 192, 0, 2, 10]);
      dns.send(Buffer.concat([response, answer]), remote.port, remote.address);
    });
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', () => { dnsBound = true; resolve(); }));
    const dnsPort = (dns.address() as { port: number }).port;
    const template = { schemaVersion: 2, id: 'synthetic-issue-40', revision: '1', targetVersion: '1.14.4',
        defaults: { log: { level: 'debug' }, dns: { final: 'fallback' }, route: { final: 'direct' } },
        resources: { inbounds: [{ type: 'mixed', tag: 'probe', listen: '127.0.0.1', listen_port: mixedPort }],
          outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'direct', tag: 'matched' }, { type: 'direct', tag: 'fallback' }],
          dnsServers: [{ type: 'udp', tag: 'fallback', server: '127.0.0.1', server_port: dnsPort }] },
        platformDnsServers: {}, routePresets: {}, dnsPresets: {}, ecsResponseTags: [] };
    const input = { params: { ecs: null }, dependencies: { templates: [template], nodes: [], subscriptions: [subscription] },
      recipe: { schemaVersion: 2, id: 'synthetic-issue-40', revision: '1', profile: 'macos-standalone', templateRef: { id: template.id, revision: '1' }, resources: { ruleSets: [
        { kind: 'subscription', tag: 'live', subscriptionRef: { systemRuleSetId: subscription.systemRuleSetId, usages: ['route', 'dns-query'] } } ] },
        routeSteps: [{ id: 'hijack', rule: { port: 53, action: 'hijack-dns' } },
          { id: 'matched', rule: { rule_set: 'live', action: 'route', outbound: 'matched' } },
          { id: 'fallback', rule: { domain, action: 'route', outbound: 'fallback' } }],
        dnsSteps: [{ id: 'dns-matched', rule: { rule_set: 'live', action: 'predefined', answer: [`${domain}. 0 IN A 192.0.2.20`] } }] },
    };
    const recipeBytes = JSON.stringify(input.recipe);
    const publication = await publishRecipe(input, { binary, directory: join(directory, 'publication') });
    assert.ok(publication.ok, JSON.stringify(publication.diagnostics));
    const retained = await readPublication(join(directory, 'publication'));
    assert.equal(retained.id, publication.value.id);
    const delivered = await renderSubscription(retained, input.params);
    assert.ok(delivered.ok, JSON.stringify(delivered.diagnostics));
    const config: any = delivered.value;
    assert.equal(config.route.rule_set[0].url, url);
    assert.equal(publication.value.body.recipeSource?.subscriptions?.[0].systemRuleSetId, subscription.systemRuleSetId);
    const publicationBytes = JSON.stringify(publication.value);
    // Process-local harness: accelerate polling, disable DNS cache and redirect
    // network destinations to loopback. Recipe match conditions and actions stay fixed.
    assert.equal(config.route.rule_set[0].update_interval, undefined);
    config.route.rule_set[0].update_interval = '1s';
    config.dns.disable_cache = true;
    config.outbounds.push({ type: 'http', tag: 'fixture', server: '127.0.0.1', server_port: tunnelPort });
    config.http_clients = [{ tag: 'rules', version: 1, detour: 'fixture' }];
    config.route.rule_set[0].http_client = 'rules';
    for (const rule of config.route.rules) {
      if (rule.outbound === 'matched' || rule.outbound === 'fallback') {
        rule.override_address = '127.0.0.1';
        rule.override_port = rule.outbound === 'matched' ? matchedPort : fallbackPort;
      }
    }
    config.certificate = { store: 'none', certificate_path: [join(directory, 'cert.pem')] };
    const configBytes = Buffer.from(JSON.stringify(config));
    const configPath = join(directory, 'config.json'); await writeFile(configPath, configBytes);
    await exec(binary, ['check', '-c', configPath]);
    child = spawn(binary, ['run', '-c', configPath], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', b => log += b); child.stderr!.on('data', b => log += b);
    const pid = child.pid; assert.ok(pid);
    async function observe(expectedRoute: string, expectedDns: string) {
      const deadline = Date.now() + 20_000; let latest: unknown;
      while (Date.now() < deadline) {
        assert.equal(child!.exitCode, null, `client exited: ${log}`);
        try {
          const route = await proxyRoute(mixedPort), dns = await proxyDns(mixedPort); latest = { route, dns };
          if (route === expectedRoute && dns === expectedDns) return { route, dns, observedAt: new Date().toISOString() };
        } catch (error) { latest = String(error); }
        await pause(200);
      }
      assert.fail(`No expected new-request behavior: ${JSON.stringify(latest)}\n${log}`);
    }
    const before = await observe('route-fallback-A', '192.0.2.10');
    env.upstream({ openai: `domain:${domain}` });
    const automatic = await syncRules(request);
    assert.equal(automatic.status, 'success', JSON.stringify(automatic));
    assert.equal(automatic.results[0].status, 'delivered');
    const activeB = automatic.results[0].current!;
    assert.notEqual(activeB.versionId, activeA.versionId);
    assert.notDeepEqual(activeB.source, activeA.source);
    const after = await observe('route-matched-B', '192.0.2.20');
    const pinned = await pinRuleVersion({ ...request, id: 'openai', version: activeA.versionId! });
    assert.equal(pinned.status, 'success', JSON.stringify(pinned));
    assert.equal(pinned.results[0].control?.mode, 'pinned');
    assert.equal(pinned.results[0].current?.versionId, activeA.versionId);
    assert.deepEqual(pinned.results[0].current?.source, activeA.source);
    const restored = await observe('route-fallback-A', '192.0.2.10');
    const requests = env.requests.length;
    const writes = env.writes.length;
    const paused = await syncRules(request);
    assert.equal(paused.status, 'success', JSON.stringify(paused));
    assert.equal(paused.results[0].status, 'pinned-skipped');
    assert.equal(env.requests.length, requests);
    assert.equal(env.writes.length, writes);
    // Prove that pinned bytes are still fetched from the same URL.
    const downloadsBefore = downloads.length;
    const deadline = Date.now() + 10_000;
    while (downloads.length === downloadsBefore && Date.now() < deadline) await pause(100);
    assert.ok(downloads.length > downloadsBefore, 'Pinned client must refresh the stable URL');
    const stillPinned = await observe('route-fallback-A', '192.0.2.10');
    const resumed = await resumeRuleUpdates({ ...request, id: 'openai' });
    assert.equal(resumed.status, 'success', JSON.stringify(resumed));
    assert.equal(resumed.results[0].control?.mode, 'auto');
    assert.equal(resumed.results[0].current?.versionId, activeB.versionId);
    assert.equal(resumed.results[0].current?.candidateId, activeB.candidateId);
    const following = await observe('route-matched-B', '192.0.2.20');
    assert.equal(child.pid, pid); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.deepEqual(await readFile(configPath), configBytes);
    assert.equal(JSON.stringify(publication.value), publicationBytes);
    assert.equal(JSON.stringify(input.recipe), recipeBytes);
    assert.deepEqual(await readPublication(join(directory, 'publication')), retained);
    assert.equal(config.route.rule_set[0].url, url);
    const status = await getRulesStatus(request);
    assert.equal(status.status, 'success', JSON.stringify(status));
    assert.equal(status.rules?.[0].current?.versionId, activeB.versionId);
    assert.deepEqual(status.rules?.[0].current?.subscription, subscription);
    assert.ok(downloads.every(entry => entry.url === url));
    const deliveredHashes = downloads.map(entry => entry.sha256).filter((hash, i, all) => i === 0 || hash !== all[i - 1]);
    const binaryPath = 'stable/openai/domains.srs';
    assert.equal(sha256(inputBytesA), activeA.files[binaryPath].sha256);
    assert.notEqual(activeA.files[binaryPath].sha256, activeB.files[binaryPath].sha256);
    assert.deepEqual(deliveredHashes, [activeA, activeB, activeA, activeB].map(record => record.files[binaryPath].sha256));
    const evidence = { source: 'controlled Release input and in-memory Git; real sing-box and loopback HTTPS',
      operations: { first, automatic, pinned, paused, resumed },
      publicationId: publication.value.id, publicationSha256: sha256(publicationBytes),
      recipeSha256: sha256(recipeBytes), logicalId: subscription.systemRuleSetId, stableUrl: url,
      client: { pid, binary, configSha256: sha256(configBytes), sameProcess: true, sameConfig: true, updateInterval: '1s' },
      before, after, restored, stillPinned, following, downloads };
    console.log(JSON.stringify({ rulesDomainClient: evidence }));
    if (process.env.RULE_DOMAIN_CLIENT_EVIDENCE) await writeFile(process.env.RULE_DOMAIN_CLIENT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A build/gate failure can occur before any listener binds. Close only live
    // resources and preserve that original failure if cleanup also fails.
    const cleanup = await Promise.allSettled([
      (async () => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>(resolve => { child!.once('exit', () => resolve()); child!.kill('SIGTERM'); });
        }
      })(),
      (async () => { if (dnsBound) await new Promise<void>(resolve => dns.close(resolve)); })(),
      (async () => {
        for (const socket of sockets) socket.destroy();
        await Promise.all(servers.filter(server => server.listening).map(server => {
          server.closeAllConnections();
          return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }));
      })(),
    ]);
    const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
    const cleanupFailure = [...cleanup, ...removed].find(result => result.status === 'rejected');
    if (!failed && cleanupFailure?.status === 'rejected') throw cleanupFailure.reason;
  }
});
