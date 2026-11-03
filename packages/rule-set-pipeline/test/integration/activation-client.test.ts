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
import { activateRules, rollbackRules } from '../../src/activation.js';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { syntheticCandidate } from './activation-client-fixture.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const exec = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const branch = 'acceptance-issue-19';
const domain = 'updated.issue19.test';
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
test('正式激活 A/B 并回滚 A 后同一 Compiler 配置及运行实例恢复 Route 与 DNS 新请求行为', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activation-client-'));
  const servers: Server[] = [], sockets = new Set<Duplex>();
  const dns = createSocket('udp4');
  let child: ChildProcess | undefined, log = '', failed = false, dnsBound = false;
  const immutable = new Map<string, Buffer>(), stable = new Map<string, Buffer>();
  let count = 0, head = 'a'.repeat(40);
  const published: { path: string; sha256: string; commit: string }[] = [];
  const transport = {
    branch,
    async head() { return head; },
    async download(address: string) {
      const path = new URL(address).pathname.split('/').slice(3).join('/');
      const content = immutable.get(path) ?? (path.startsWith(`${branch}/`) ? stable.get(path.slice(branch.length + 1)) : undefined);
      if (!content) throw new Error(`Readback HTTP 404: ${address}`);
      return content;
    },
    async commit(expectedHead: string, files: Record<string, Buffer>, _message: string) {
      assert.equal(expectedHead, head, 'CAS must reject stale activations');
      head = (++count).toString(16).padStart(40, '0');
      for (const [path, content] of Object.entries(files)) {
        stable.set(path, content); immutable.set(`${head}/${path}`, content);
        published.push({ path, sha256: sha256(content), commit: head });
      }
      return head;
    },
  };
  const publish = async (files: Record<string, Buffer>) => {
    const commit = (++count).toString(16).padStart(40, '0');
    for (const [path, content] of Object.entries(files)) immutable.set(`${commit}/${path}`, content);
    return commit;
  };
  try {
    const a = await syntheticCandidate(binary, 'A', 'old.issue19.test', publish);
    const b = await syntheticCandidate(binary, 'B', domain, publish);
    const activeA = await activateRules({ candidateEvidenceUrl: a.candidateEvidenceUrl, subscription, binary, expectedHead: head, transport });
    await writeFile(join(directory, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=raw.githubusercontent.com\n[ext]\nsubjectAltName=DNS:raw.githubusercontent.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(directory, 'openssl.cnf'),
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
    const tlsServer = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => {
      const prefix = `/${ARTIFACT_REPOSITORY}/${branch}/`;
      const bytes = req.url?.startsWith(prefix) ? stable.get(req.url.slice(prefix.length)) : undefined;
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
    const input: CompileInput = {
      profile: 'macos-standalone', params: { ecs: null }, artifacts: [], subscriptions: [subscription],
      template: { id: 'synthetic-issue-19', revision: '1', targetVersion: '1.14.4',
        defaults: { log: { level: 'debug' }, dns: { final: 'fallback', disable_cache: true }, route: { final: 'direct' },
          certificate: { store: 'none', certificate_path: [join(directory, 'cert.pem')] } },
        resources: { inbounds: [{ type: 'mixed', tag: 'probe', listen: '127.0.0.1', listen_port: mixedPort }],
          outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'http', tag: 'fixture', server: '127.0.0.1', server_port: tunnelPort }],
          httpClients: [{ tag: 'rules', version: 1, detour: 'fixture' }],
          dnsServers: [{ type: 'udp', tag: 'fallback', server: '127.0.0.1', server_port: dnsPort }] },
        platformDnsServers: {}, routePresets: {}, dnsPresets: {}, ecsResponseTags: [] },
      recipe: { id: 'synthetic-issue-19', revision: '1', resources: { ruleSets: [
        { kind: 'subscription', tag: 'live', systemRuleSetId: subscription.systemRuleSetId, usages: ['route', 'dns-query'], httpClient: 'rules' } ] },
        routeSteps: [{ rule: { port: 53, action: 'hijack-dns' } },
          { rule: { rule_set: 'live', action: 'route', outbound: 'direct', override_address: '127.0.0.1', override_port: matchedPort } },
          { rule: { domain, action: 'route', outbound: 'direct', override_address: '127.0.0.1', override_port: fallbackPort } }],
        dnsSteps: [{ rule: { rule_set: 'live', action: 'predefined', answer: [`${domain}. 0 IN A 192.0.2.20`] } }] },
    };
    const compiled = compile(input); assert.ok(compiled.ok, JSON.stringify(compiled.diagnostics));
    const config: any = compiled.value.config;
    // Test harness only: Compiler deliberately leaves real-client timing alone.
    assert.equal(config.route.rule_set[0].update_interval, undefined);
    config.route.rule_set[0].update_interval = '1s';
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
    const activeB = await activateRules({ candidateEvidenceUrl: b.candidateEvidenceUrl, subscription, binary, expectedHead: head, transport });
    const after = await observe('route-matched-B', '192.0.2.20');
    const rolledBack = await rollbackRules({ historicalActivationCommit: activeA.commit, subscription, binary, expectedHead: head, transport });
    const restored = await observe('route-fallback-A', '192.0.2.10');
    assert.equal(rolledBack.activation.candidateId, a.id);
    assert.equal(rolledBack.activation.historicalActivationCommit, activeA.commit);
    assert.equal(child.pid, pid); assert.equal(child.exitCode, null);
    assert.deepEqual(await readFile(configPath), configBytes);
    const evidence = { source: 'synthetic controlled fixture, not an official Release', a, b, activeA, activeB, rolledBack,
      client: { pid, binary, configSha256: sha256(configBytes), sameProcess: true, sameConfig: true, updateInterval: '1s' }, before, after, restored, published };
    console.log(JSON.stringify({ activationClient: evidence }));
    if (process.env.RULE_ACTIVATION_CLIENT_EVIDENCE) await writeFile(process.env.RULE_ACTIVATION_CLIENT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
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
