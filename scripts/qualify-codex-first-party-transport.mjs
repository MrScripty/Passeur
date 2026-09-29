#!/usr/bin/env node
/** Installed first-party route discovery with a disposable credential and local TLS only. */
import { createServer as createHttpsServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProtectedEgress } from '../dist/src/agents/codex/protected-egress.js';
import { ACCOUNT_CHECK_RESPONSE, ELF, protectedProfileToml, run } from './qualify-codex-protected-worker.mjs';
import { deniedPathStructure, generateCertificate } from './qualify-codex-subscription-transport.mjs';

const HOST = 'chatgpt.com';
const MAX_ROUTES = 8;
const CATALOG_PATH = '/backend-api/codex/models?client_version=0.157.1';
export const FIRST_PARTY_LABELS = Object.freeze({ providerLabel: 'openai',
  credentialLabel: 'synthetic_chatgpt_first_party_discovery' });

export function firstPartyProfile(workspace, canonical, admin, native) {
  if (native !== ELF) throw Error('fixture native mismatch');
  const base = protectedProfileToml(workspace, canonical, admin, 39173, true);
  const providerSection = '\n[model_providers.passeur_fixture_loopback]\n';
  const at = base.indexOf(providerSection);
  if (at < 0 || base.indexOf(providerSection, at + 1) !== -1 ||
      !base.startsWith('chatgpt_base_url = "http://127.0.0.1:39173"\n')) throw Error('profile shape changed');
  return base.slice(0, at).replace('chatgpt_base_url = "http://127.0.0.1:39173"\n', '')
    .replace('model_provider = "passeur_fixture_loopback"', 'model_provider = "openai"') +
    '\n[analytics]\nenabled = false\n';
}

export function firstPartyRoute(method, path) {
  if (method === 'GET' && path === '/backend-api/wham/accounts/check') return 'account';
  if (method === 'GET' && path === '/backend-api/wham/settings/user') return 'settings';
  if (method === 'GET' && path === CATALOG_PATH) return 'catalog';
  return 'unknown';
}

export function firstPartyResponseBody(route) {
  if (route === 'account') return JSON.stringify(ACCOUNT_CHECK_RESPONSE);
  if (route === 'settings') return '{"commit_attribution_enabled":false}';
  if (route === 'catalog') return '{"models":[]}';
  return null;
}

export function firstPartyRequestIdentity(request, token) {
  const securityHeaders = new Map();
  const raw = request.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return false;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    if (['host', 'authorization', 'content-length', 'transfer-encoding'].includes(name)) {
      securityHeaders.set(name, (securityHeaders.get(name) ?? 0) + 1);
    }
  }
  return request.socket?.servername === HOST && request.headers?.host === HOST &&
    request.headers?.authorization === `Bearer ${token}` &&
    securityHeaders.get('host') === 1 && securityHeaders.get('authorization') === 1 &&
    !securityHeaders.has('content-length') && !securityHeaders.has('transfer-encoding') &&
    request.headers?.['content-length'] == null && request.headers?.['transfer-encoding'] == null;
}

/** Own every TLS socket, including handshakes and upgrades, through bounded retirement. */
export function trackFirstPartyTlsServer(server) {
  const sockets = new Set();
  let retiring = false, closing;
  server.on('connection', socket => {
    if (retiring) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  return { active: () => sockets.size, close: () => closing ??= (async () => {
    retiring = true;
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const drained = [...sockets].map(socket => new Promise(resolve => {
      socket.once('close', resolve); socket.destroy();
    }));
    let timer;
    try {
      await Promise.race([Promise.all(drained).then(() => closed), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('CODEX_FIRST_PARTY_TLS_RETIREMENT_UNCONFIRMED')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
    if (sockets.size !== 0) throw Error('CODEX_FIRST_PARTY_TLS_RETIREMENT_UNCONFIRMED');
  })() };
}

export async function runFirstPartyDiscovery() {
  const evidence = { routes: [], upgrades: [], firstPartyTunnels: 0,
    catalogReceipts: 0, catalogResponses: 0,
    oauthDenied: 0, unknownDenied: 0, latchedDenied: 0, deniedAuthorityCategories: [],
    startupStderr: null, brokerRetired: false, discoveryComplete: false };
  const transport = { ...FIRST_PARTY_LABELS,
    async prepare(context) {
      const certificate = generateCertificate(context.root, HOST);
      await writeFile(certificate.ext, `subjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`);
      certificate.openssl('x509', '-req', '-in', certificate.csr, '-CA', certificate.ca,
        '-CAkey', certificate.caKey, '-CAcreateserial', '-days', '1', '-extfile', certificate.ext,
        '-out', certificate.cert);
      const token = JSON.parse(context.seedBytes.toString('utf8')).tokens.access_token;
      const server = createHttpsServer({ key: await readFile(certificate.key), cert: await readFile(certificate.cert) });
      const terminal = new AbortController();
      const stopDiscovery = () => terminal.abort(new Error('CODEX_FIRST_PARTY_DISCOVERY_STOP'));
      let broker;
      const tlsOwner = trackFirstPartyTlsServer(server);
      const record = (method, path, upgrade) => {
        if (evidence.routes.length + evidence.upgrades.length >= MAX_ROUTES) return false;
        const target = upgrade ? evidence.upgrades : evidence.routes;
        const route = firstPartyRoute(method, path);
        target.push({ method, route, path: route === 'unknown' ? deniedPathStructure(path) : route });
        return true;
      };
      server.on('request', (request, response) => {
        const route = firstPartyRoute(request.method, request.url);
        if (route === 'catalog') evidence.catalogReceipts++;
        if (!record(request.method, request.url, false) || !firstPartyRequestIdentity(request, token)) {
          context.state.failure ??= 'first_party_request_invalid';
          response.once('finish', stopDiscovery); response.writeHead(403).end(); return;
        }
        if (route === 'account') {
          context.state.accountChecks++;
        }
        const body = firstPartyResponseBody(route);
        if (body === null) {
          context.state.failure ??= 'first_party_route_unknown';
          response.once('finish', stopDiscovery); response.writeHead(404).end();
        } else {
          if (route === 'catalog') response.once('finish', () => { evidence.catalogResponses++; });
          response.writeHead(200, { 'content-type': 'application/json' }).end(body);
        }
      });
      server.on('upgrade', (request, socket) => {
        record(request.method, request.url, true);
        context.state.failure ??= 'first_party_upgrade_unqualified';
        socket.end(firstPartyRequestIdentity(request, token) ?
          'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n' :
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.once('close', stopDiscovery);
      });
      return { provider: {
        async listen() {
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          broker = await startProtectedEgress({ socketPath: context.socketPath, accountHost: HOST,
            inferenceHost: HOST, accountPort: server.address().port, inferencePort: server.address().port,
            firstParty: true, onDeniedAuthority: denied => {
              if (evidence.deniedAuthorityCategories.length < 4) evidence.deniedAuthorityCategories.push(denied);
            } });
        },
        async close() {
          if (broker) {
            await broker.close(); evidence.brokerRetired = broker.active() === 0;
            evidence.firstPartyTunnels = broker.counts.first_party;
            evidence.oauthDenied = broker.counts.oauth_denied;
            evidence.unknownDenied = broker.counts.unknown_denied;
            evidence.latchedDenied = broker.counts.latched_denied;
          }
          await tlsOwner.close();
        },
      }, syntheticProvider: 'openai', terminalAuthSignal: terminal.signal,
      relay: { socketPath: context.socketPath, port: context.relayPort,
        tlsProxy: { caFile: certificate.ca, accountHost: HOST, inferenceHost: HOST, firstParty: true },
        startupDiagnostic: diagnostic => { evidence.startupStderr = diagnostic; } },
      config: firstPartyProfile(context.workspace, context.canonical, context.admin, ELF),
      beforeReturn: async () => false };
    },
  };
  const report = await run('seeded-home', transport);
  evidence.discoveryComplete = evidence.routes.some(value => value.route === 'unknown') || evidence.upgrades.length > 0;
  await writeFile(join(report.root, 'bounded-first-party-discovery.json'), `${JSON.stringify({
    fixture: 'codex-first-party-route-discovery/1', root: report.root, status: 'incomplete',
    workerStop: report.workerStop, nativeResultCode: report.nativeResultCode, evidence }, null, 2)}\n`, { mode: 0o600 });
  return { root: report.root, status: 'incomplete', workerStop: report.workerStop, evidence };
}

if (process.argv[1]?.endsWith('/qualify-codex-first-party-transport.mjs')) {
  const result = await runFirstPartyDiscovery();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}
