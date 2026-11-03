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
import { compile, type CompileInput, type RuleSubscription } from '../../../config-compiler/src/index.js';
import { buildNative } from '../../src/native.js';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const branch = 'acceptance-issue-21';
const domain = 'updated.issue21.test';
const otherDomain = 'other.issue21.test';
const url = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/stable/domains.srs`;
const subscription: RuleSubscription = { schemaVersion: 1, systemRuleSetId: 'v2fly:domain-list-community:category-ai-!cn',
  targetVersion: '1.14.4', sourceFormatVersion: 4, projections: {
    route: { formats: { binary: { url, requiredCapabilities: [] } } },
    'dns-query': { formats: { binary: { url, requiredCapabilities: [] } } }, 'dns-response': { unavailable: 'empty' },
  } };

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
async function proxyRoute(port: number, queryDomain: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `http://${queryDomain}/`, method: 'GET',
      headers: { Host: queryDomain, Connection: 'close' }, timeout: 1500 }, response => {
      let body = ''; response.on('data', b => body += b); response.on('end', () => resolve(body));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Route probe timeout'))); req.end();
  });
}
function dnsQuestion(queryDomain: string) {
  const name = Buffer.concat([...queryDomain.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  const header = Buffer.alloc(12); header.writeUInt16BE(0x2121); header.writeUInt16BE(0x100, 2); header.writeUInt16BE(1, 4);
  return Buffer.concat([header, name, Buffer.from([0, 1, 0, 1])]);
}
async function proxyDns(port: number, queryDomain: string) {
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
        const query = dnsQuestion(queryDomain), length = Buffer.alloc(2); length.writeUInt16BE(query.length);
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
test('更新故障保留 A、恢复更新 B，并从持久缓存断网重启恢复 B', { timeout: 150_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'client-failure-issue-21-'));
  const servers: Server[] = [], sockets = new Set<Duplex>();
  const dns = createSocket('udp4');
  let child: ChildProcess | undefined, log = '', failed = false, dnsBound = false;
  type Mode = 'A' | 'B' | 'network' | 'http' | 'truncated' | 'bad-rules';
  let mode: Mode = 'A';
  const deliveries: { mode: Mode; at: string }[] = [];
  const cachePath = join(directory, 'rules.db');
  const failurePatterns = { network: /: EOF/, http: /unexpected status: 503/,
    truncated: /unexpected EOF/, 'bad-rules': /invalid sing-box rule-set file/ };
  const faults: unknown[] = [];
  try {
    const a = await buildNative([{ type: 'domain', value: domain }], binary);
    const b = await buildNative([{ type: 'domain', value: otherDomain }], binary);
    const bytesA = a.artifacts.find(artifact => artifact.format === 'binary')!.content;
    const bytesB = b.artifacts.find(artifact => artifact.format === 'binary')!.content;
    await writeFile(join(directory, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=raw.githubusercontent.com\n[ext]\nsubjectAltName=DNS:raw.githubusercontent.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(directory, 'openssl.cnf'),
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
    const tlsServer = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => {
      if (req.url !== new URL(url).pathname) { res.writeHead(404); res.end(); return; }
      deliveries.push({ mode, at: new Date().toISOString() });
      // A transport failure has no HTTP response. A truncated SRS is delivered
      // with a complete HTTP body so the native rule loader must reject it.
      if (mode === 'network') { req.socket.destroy(); return; }
      if (mode === 'http') { res.writeHead(503); res.end('injected HTTP failure'); return; }
      const bytes = mode === 'A' ? bytesA : mode === 'B' ? bytesB
        : mode === 'truncated' ? bytesB.subarray(0, Math.floor(bytesB.length / 2))
        : Buffer.from('not an SRS rule set');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
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
    const matched = createHttpServer((_req, res) => res.end('route-matched'));
    const fallback = createHttpServer((_req, res) => res.end('route-fallback'));
    servers.push(matched, fallback);
    const matchedPort = await listen(matched), fallbackPort = await listen(fallback), mixedPort = await freePort();
    dns.on('message', (query, remote) => {
      const response = Buffer.from(query); response.writeUInt16BE(0x8180, 2); response.writeUInt16BE(1, 6);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 192, 0, 2, 10]);
      dns.send(Buffer.concat([response, answer]), remote.port, remote.address);
    });
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', () => { dnsBound = true; resolve(); }));
    const dnsPort = (dns.address() as { port: number }).port;
    const input: CompileInput = {
      profile: 'macos-standalone', params: { ecs: null }, artifacts: [], subscriptions: [subscription],
      template: { id: 'synthetic-issue-21', revision: '1', targetVersion: '1.14.4',
        defaults: { log: { level: 'debug' }, dns: { final: 'fallback', disable_cache: true }, route: { final: 'direct' },
          certificate: { store: 'none', certificate_path: [join(directory, 'cert.pem')] } },
        resources: { inbounds: [{ type: 'mixed', tag: 'probe', listen: '127.0.0.1', listen_port: mixedPort }],
          outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'http', tag: 'fixture', server: '127.0.0.1', server_port: tunnelPort }],
          httpClients: [{ tag: 'rules', version: 1, detour: 'fixture' }],
          dnsServers: [{ type: 'udp', tag: 'fallback', server: '127.0.0.1', server_port: dnsPort }] },
        platformDnsServers: {}, routePresets: {}, dnsPresets: {}, ecsResponseTags: [] },
      recipe: { id: 'synthetic-issue-21', revision: '1', resources: { ruleSets: [
        { kind: 'subscription', tag: 'live', systemRuleSetId: subscription.systemRuleSetId, usages: ['route', 'dns-query'], httpClient: 'rules' } ] },
        routeSteps: [{ rule: { port: 53, action: 'hijack-dns' } },
          { rule: { rule_set: 'live', action: 'route', outbound: 'direct', override_address: '127.0.0.1', override_port: matchedPort } },
          { rule: { domain: [domain, otherDomain], action: 'route', outbound: 'direct', override_address: '127.0.0.1', override_port: fallbackPort } }],
        dnsSteps: [domain, otherDomain].map((name): CompileInput['recipe']['dnsSteps'][number] => ({ rule: { type: 'logical', mode: 'and', rules: [{ rule_set: 'live' }, { domain: name }], action: 'predefined', answer: [`${name}. 0 IN A 192.0.2.20`] } })) },
    };
    const compiled = compile(input); assert.ok(compiled.ok, JSON.stringify(compiled.diagnostics));
    const config: any = compiled.value.config;
    // Test harness only: Compiler deliberately leaves real-client timing alone.
    assert.equal(config.route.rule_set[0].update_interval, undefined);
    config.route.rule_set[0].update_interval = '1s';
    config.experimental = { cache_file: { enabled: true, path: cachePath } };
    const configBytes = Buffer.from(JSON.stringify(config));
    const configPath = join(directory, 'config.json'); await writeFile(configPath, configBytes);
    await exec(binary, ['check', '-c', configPath]);
    const pids: number[] = [];
    async function startClient() {
      child = spawn(binary!, ['run', '-c', configPath], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.on('data', b => log += b); child.stderr!.on('data', b => log += b);
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
      assert.ok(child.pid); pids.push(child.pid);
    }
    async function stopClient() {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error('Client shutdown timeout')); }, 5000);
          child!.once('exit', () => { clearTimeout(timer); resolve(); }); child!.kill('SIGTERM');
        });
      }
    }
    async function until(predicate: () => boolean, description: string) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        assert.ok(child && child.exitCode === null && child.signalCode === null, `client exited: ${log}`);
        if (predicate()) return;
        await pause(100);
      }
      assert.fail(`${description} timed out\n${log}`);
    }
    await startClient();
    const pid = child!.pid;
    async function observe(version: 'A' | 'B') {
      const deadline = Date.now() + 20_000; let latest: unknown;
      while (Date.now() < deadline) {
        assert.equal(child!.exitCode, null, `client exited: ${log}`);
        try {
          const results = [];
          for (const name of [domain, otherDomain]) {
            results.push({ domain: name, route: await proxyRoute(mixedPort, name), dns: await proxyDns(mixedPort, name) });
          }
          latest = results;
          if (results.every(result => {
            const matches = result.domain === (version === 'A' ? domain : otherDomain);
            return result.route === (matches ? 'route-matched' : 'route-fallback')
              && result.dns === (matches ? '192.0.2.20' : '192.0.2.10');
          })) return { version, results, observedAt: new Date().toISOString() };
        } catch (error) { latest = String(error); }
        await pause(200);
      }
      assert.fail(`No expected new-request behavior: ${JSON.stringify(latest)}\n${log}`);
    }
    const before = await observe('A');
    for (const fault of ['network', 'http', 'truncated', 'bad-rules'] as const) {
      mode = 'A';
      const loadedA = await observe('A');
      const requestStart = deliveries.length, logStart = log.length;
      mode = fault;
      await until(() => deliveries.slice(requestStart).some(delivery => delivery.mode === fault)
        && /fetch rule-set live:/.test(log.slice(logStart)), `${fault} must reach native update failure`);
      const failureLog = log.slice(logStart).split('\n').filter(line => /fetch rule-set live:/.test(line));
      assert.match(failureLog.join('\n'), failurePatterns[fault], `${fault} must fail for the injected reason`);
      const retained = await observe('A');
      mode = 'B';
      const recovered = await observe('B');
      assert.equal(child!.pid, pid); assert.equal(child!.exitCode, null); assert.equal(child!.signalCode, null);
      faults.push({ fault, loadedA, failureLog, retained, recovered,
        requests: deliveries.slice(requestStart), sameProcess: true });
    }
    assert.deepEqual(await readFile(configPath), configBytes);
    // Graceful stop flushes the native cache. Offline restart proving B (which
    // differs from the initially loaded A) is the persistence verification.
    await stopClient();
    const cacheBytes = await readFile(cachePath); assert.ok(cacheBytes.length > 0);
    for (const socket of sockets) socket.destroy();
    tlsServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => tlsServer.close(error => error ? reject(error) : resolve()));
    const offlineLogStart = log.length, requestsBeforeRestart = deliveries.length;
    await startClient();
    assert.notEqual(child!.pid, pid);
    const offline = await observe('B');
    await until(() => /fetch rule-set live:/.test(log.slice(offlineLogStart)), 'offline update must actually fail');
    const afterOfflineFailure = await observe('B');
    assert.equal(deliveries.length, requestsBeforeRestart, 'offline service must deliver no bytes');
    assert.deepEqual(await readFile(configPath), configBytes);
    await stopClient();
    const evidence = {
      source: 'synthetic issue-21 loopback fixture; no remote branch writes or official Release claim',
      tool: a.tool,
      rules: { A: { sha256: sha256(bytesA), byteLength: bytesA.length, domain },
        B: { sha256: sha256(bytesB), byteLength: bytesB.length, domain: otherDomain } },
      client: { pids, configSha256: sha256(configBytes), sameConfig: true, updateInterval: '1s',
        cacheEnabled: true, dnsCacheDisabled: true },
      subscription, config, before, faults,
      persistence: { cacheByteLength: cacheBytes.length, cacheSha256: sha256(cacheBytes),
        serviceClosedBeforeRestart: true, noRuleBytesDelivered: true, offline, afterOfflineFailure,
        failureLog: log.slice(offlineLogStart).split('\n').filter(line => /fetch rule-set live:/.test(line)) },
    };
    console.log(JSON.stringify({ clientFailureRecovery: evidence }));
    if (process.env.RULE_CLIENT_FAILURE_EVIDENCE) await writeFile(process.env.RULE_CLIENT_FAILURE_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A build/setup failure can occur before any listener binds. Close only live
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
