/** Synthetic-only CONNECT transport. The host never dials a requested name. */
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createConnection, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";

export type EgressRoute = "account" | "inference" | "first_party" | "oauth_denied" | "unknown_denied" | "latched_denied";
export type EgressLatchReason = "refresh_denied" | "upstream_unauthorized" | "tls_refused";
export type DeniedAuthorityCategory = "oauth" | "api_openai" | "chatgpt_invalid_connect" | "other_valid" | "malformed";
const AUTHORITY = /^[a-z0-9][a-z0-9.-]{0,252}:443$/;
function deniedAuthorityCategory(authority: string): DeniedAuthorityCategory {
  if (authority === "auth.openai.com:443") return "oauth";
  if (authority === "api.openai.com:443") return "api_openai";
  if (authority === "chatgpt.com:443") return "chatgpt_invalid_connect";
  return AUTHORITY.test(authority) && !authority.includes("..") ? "other_valid" : "malformed";
}
export function classifyAuthority(authority: string, accountHost: string, inferenceHost: string): EgressRoute {
  if (!AUTHORITY.test(authority) || authority.includes("..")) return "unknown_denied";
  if (authority === "auth.openai.com:443") return "oauth_denied";
  if (authority === `${accountHost}:443`) return "account";
  if (authority === `${inferenceHost}:443`) return "inference";
  return "unknown_denied";
}

export type EgressBroker = Readonly<{ socketPath: string; counts: Readonly<Record<EgressRoute, number>>;
  active: () => number; accepted: () => number; authDenied: () => boolean;
  latchReason: () => EgressLatchReason | null; denyUnauthorizedUpstream: () => EgressLatchReason;
  denyTlsRefusal: () => EgressLatchReason;
  close: () => Promise<void> }>;

export async function startProtectedEgress(spec: Readonly<{ socketPath: string; accountHost: string;
  inferenceHost: string; accountPort: number; inferencePort: number; signal?: AbortSignal;
  firstParty?: true;
  onDeniedAuthority?: (category: DeniedAuthorityCategory) => void;
  onTerminalDenial?: (reason: EgressLatchReason) => void }>): Promise<EgressBroker> {
  if (!spec.socketPath.startsWith("/tmp/") ||
      (spec.firstParty ? spec.accountHost !== "chatgpt.com" || spec.inferenceHost !== "chatgpt.com" ||
        spec.accountPort !== spec.inferencePort :
        spec.accountHost !== "accounts.fixture.invalid" || spec.inferenceHost !== "inference.fixture.invalid") ||
      [spec.accountHost, spec.inferenceHost].some(host => isIP(host) !== 0) ||
      ![spec.accountPort, spec.inferencePort].every(port => Number.isSafeInteger(port) && port > 0 && port < 65536)) {
    throw new Error("CODEX_EGRESS_CONFIG_INVALID");
  }
  const counts: Record<EgressRoute, number> = { account: 0, inference: 0, first_party: 0, oauth_denied: 0,
    unknown_denied: 0, latched_denied: 0 };
  const sockets = new Set<Duplex>();
  const clients = new Set<Duplex>(), routed = new Set<Duplex>(), earlyDenied = new Set<Duplex>();
  let latchedReason: EgressLatchReason | null = null;
  let accepted = 0;
  const latch = (reason: EgressLatchReason, exempt?: Duplex): EgressLatchReason => {
    if (latchedReason) return latchedReason;
    latchedReason = reason;
    for (const socket of sockets) if (socket !== exempt) {
      if (clients.has(socket) && !routed.has(socket)) { earlyDenied.add(socket); counts.latched_denied++; }
      socket.destroy();
    }
    try { spec.onTerminalDenial?.(reason); } catch { /* The latch remains terminal. */ }
    return reason;
  };
  const server = createHttpServer((_request, response) => response.writeHead(403).end());
  server.on("connection", socket => {
    accepted++; sockets.add(socket); clients.add(socket);
    socket.once("close", () => { sockets.delete(socket); clients.delete(socket); routed.delete(socket); earlyDenied.delete(socket); });
    if (latchedReason) { earlyDenied.add(socket); counts.latched_denied++; socket.destroy(); }
  });
  server.on("connect", (request, guest, head) => {
    if (latchedReason) { routed.add(guest); if (!earlyDenied.has(guest)) counts.latched_denied++;
      guest.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    routed.add(guest);
    const route = spec.firstParty && request.url === "chatgpt.com:443" ? "first_party" :
      classifyAuthority(request.url ?? "", spec.accountHost, spec.inferenceHost);
    if (route === "oauth_denied") {
      counts.oauth_denied++; latch("refresh_denied", guest);
      try { spec.onDeniedAuthority?.("oauth"); } catch { /* Diagnostics cannot alter denial. */ }
      guest.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    if (head.length || route === "unknown_denied" ||
        request.headers.host !== request.url) {
      counts[route === "account" || route === "inference" || route === "first_party" ? "unknown_denied" : route]++;
      try { spec.onDeniedAuthority?.(deniedAuthorityCategory(request.url ?? "")); }
      catch { /* Diagnostics cannot alter denial. */ }
      guest.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    counts[route]++;
    const upstream = createConnection({ host: "127.0.0.1", port: route === "account" ? spec.accountPort : spec.inferencePort });
    sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.once("connect", () => { guest.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      guest.pipe(upstream); upstream.pipe(guest); });
    upstream.once("error", () => { if (!guest.destroyed) guest.destroy(); });
    guest.once("error", () => upstream.destroy());
    guest.once("close", () => upstream.destroy());
    upstream.once("close", () => guest.destroy());
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(spec.socketPath, resolve);
  });
  chmodSync(spec.socketPath, 0o600);
  const identity = lstatSync(spec.socketPath);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => {
    const retired = [...sockets].map(socket => new Promise<void>(done => {
      socket.once("close", () => done()); socket.destroy();
    }));
    server.closeAllConnections();
    server.close(() => { void Promise.all(retired).then(() => {
      try { const current = lstatSync(spec.socketPath);
        if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(spec.socketPath); }
      catch { /* An absent socket is already retired. */ }
      resolve();
    }); });
  });
  spec.signal?.addEventListener("abort", () => { void close(); }, { once: true });
  if (spec.signal?.aborted) await close();
  return { socketPath: spec.socketPath, counts, active: () => sockets.size,
    accepted: () => accepted, authDenied: () => latchedReason !== null,
    latchReason: () => latchedReason, denyUnauthorizedUpstream: () => latch("upstream_unauthorized"),
    denyTlsRefusal: () => latch("tls_refused"), close };
}

/** Guest loopback proxy only forwards CONNECT; broker independently validates authority. */
export function createGuestConnectProxy(socketPath: string, unexpected?: () => void): HttpServer {
  const server = createHttpServer((_request, response) => { unexpected?.(); response.writeHead(403).end(); });
  const pending = new Set<Duplex>();
  server.on("connection", socket => { pending.add(socket); socket.once("close", () => pending.delete(socket)); });
  server.on("connect", (request, native, head) => {
    const authority = request.url ?? "";
    if (head.length || !AUTHORITY.test(authority) || authority.includes("..") ||
        request.headers.host !== authority) { native.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const broker = httpRequest({ socketPath, method: "CONNECT", path: authority,
      headers: { host: authority }, agent: false });
    broker.on("connect", (response, tunnel, initial) => {
      pending.add(tunnel); tunnel.once("close", () => pending.delete(tunnel));
      if (response.statusCode !== 200 || initial.length) { tunnel.destroy(); native.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      native.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      native.pipe(tunnel); tunnel.pipe(native);
      native.once("close", () => tunnel.destroy()); tunnel.once("close", () => native.destroy());
    });
    broker.once("error", () => native.destroy());
    native.once("close", () => broker.destroy());
    broker.end();
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.once("close", () => { for (const socket of pending) socket.destroy(); });
  guestConnections.set(server, pending);
  return server;
}

const guestConnections = new WeakMap<HttpServer, Set<Duplex>>();
export function retireGuestConnectProxy(server: HttpServer): void {
  for (const socket of guestConnections.get(server) ?? []) socket.destroy();
}
