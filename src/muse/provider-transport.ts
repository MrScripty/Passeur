/** Task-owned, fixed-origin Meta HTTP relay. It never accepts guest routing or credentials. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Socket } from "node:net";

const MAX_REQUESTS = 32;
const MAX_ACTIVE = 4;
const MAX_REQUEST_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

export type ProviderBearer = Readonly<{ value: string; expiresAt?: number }>;
export type ProviderTransportOptions = Readonly<{
  socketPath: string;
  getBearer: () => Promise<ProviderBearer>;
  signal?: AbortSignal;
  /** Controlled TLS peer injection for offline qualification; never derived from a guest request. */
  testPeer?: Readonly<{ port: number; lookup: RequestOptions["lookup"]; ca: string | Buffer }>;
}>;

export type ProviderTransport = Readonly<{ close: () => Promise<void> }>;

function writableReady(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      stream.off("drain", drained);
      stream.off("close", closed);
      stream.off("error", failed);
      if (error) reject(error); else resolve();
    };
    const drained = () => done();
    const closed = () => done(new Error("PROVIDER_STREAM_CLOSED"));
    const failed = () => done(new Error("PROVIDER_STREAM_FAILED"));
    stream.once("drain", drained);
    stream.once("close", closed);
    stream.once("error", failed);
  });
}

function fail(response: ServerResponse, status: number): void {
  if (!response.destroyed && !response.headersSent) response.writeHead(status).end();
  else response.destroy();
}

function admitted(request: IncomingMessage): boolean {
  if (!((request.method === "GET" && request.url === "/v1/models") ||
      (request.method === "POST" && request.url === "/v1/responses"))) return false;
  // The existing protected guest relay supplies this fixed local Host value.
  if (request.headers.host !== "api.meta.ai" && request.headers.host !== "127.0.0.1:1") return false;
  if (request.headers.upgrade || request.headers["transfer-encoding"] && request.headers["content-length"]) return false;
  if (request.headers["x-forwarded-host"] || request.headers.forwarded ||
      request.headers["x-original-url"] || request.headers["x-rewrite-url"] ||
      request.headers["proxy-authorization"]) return false;
  if (request.method === "POST" && request.headers["content-type"] !== "application/json") return false;
  const length = request.headers["content-length"];
  if (request.method === "GET" && length !== undefined && length !== "0") return false;
  return length === undefined || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= MAX_REQUEST_BYTES);
}

export async function startProviderTransport(options: ProviderTransportOptions): Promise<ProviderTransport> {
  if (!options.socketPath.startsWith("/") || typeof options.getBearer !== "function" ||
      options.signal?.aborted) throw new Error("PROVIDER_TRANSPORT_INVALID");
  let total = 0;
  let active = 0;
  let closing = false;
  const sockets = new Set<Socket>();
  const upstreams = new Set<ReturnType<typeof httpsRequest>>();
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (guest, response) => {
    if (closing || options.signal?.aborted) { fail(response, 503); return; }
    if (++total > MAX_REQUESTS || active >= MAX_ACTIVE) { fail(response, 429); return; }
    if (!admitted(guest)) { fail(response, 400); return; }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once("close", release);
    void (async () => {
      let upstream: ReturnType<typeof httpsRequest> | undefined;
      try {
        const bearer = await options.getBearer();
        if (closing || options.signal?.aborted || response.destroyed) return;
        if (!bearer || typeof bearer.value !== "string" ||
            !/^[\x21-\x7e]+$/.test(bearer.value) ||
            bearer.expiresAt !== undefined && (!Number.isFinite(bearer.expiresAt) || bearer.expiresAt <= Date.now())) {
          fail(response, 503); return;
        }
        const headers: Record<string, string> = { host: "api.meta.ai", authorization: `Bearer ${bearer.value}` };
        if (guest.method === "POST") headers["content-type"] = "application/json";
        if (guest.headers.accept === "text/event-stream") headers.accept = "text/event-stream";
        upstream = httpsRequest({ protocol: "https:", hostname: "api.meta.ai", servername: "api.meta.ai",
          port: options.testPeer?.port ?? 443, lookup: options.testPeer?.lookup,
          ca: options.testPeer?.ca, rejectUnauthorized: true, method: guest.method,
          path: guest.url, headers, agent: false, maxHeaderSize: MAX_HEADER_BYTES }, remote => {
          // Redirects are not followed or exposed as a usable provider response.
          if (remote.statusCode && remote.statusCode >= 300 && remote.statusCode < 400) {
            remote.destroy(); fail(response, 502); return;
          }
          const declared = remote.headers["content-length"];
          if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) ||
              Number(declared) > MAX_RESPONSE_BYTES)) { remote.destroy(); fail(response, 502); return; }
          const contentType = remote.headers["content-type"];
          response.writeHead(remote.statusCode ?? 502,
            typeof contentType === "string" && /^[\x20-\x7e]{1,128}$/.test(contentType)
              ? { "content-type": contentType } : {});
          void (async () => {
            let bytes = 0;
            try {
              for await (const chunk of remote) {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) throw new Error("PROVIDER_RESPONSE_LIMIT");
                if (!response.write(chunk)) await writableReady(response);
              }
              if (!remote.complete) throw new Error("PROVIDER_RESPONSE_INCOMPLETE");
              response.end();
            } catch { remote.destroy(); response.destroy(); }
          })();
        });
        const owned = upstream;
        upstreams.add(owned);
        owned.once("close", () => upstreams.delete(owned));
        owned.on("error", () => fail(response, 502));
        response.once("close", () => owned.destroy());
        let bytes = 0;
        for await (const chunk of guest) {
          bytes += chunk.length;
          if (bytes > MAX_REQUEST_BYTES) throw new Error("PROVIDER_REQUEST_LIMIT");
          if (!owned.write(chunk)) await writableReady(owned);
        }
        if (!guest.complete) throw new Error("PROVIDER_REQUEST_INCOMPLETE");
        owned.end();
      } catch {
        upstream?.destroy();
        fail(response, 502);
      } finally {
        if (!upstream) release();
      }
    })();
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  let closePromise: Promise<void> | undefined;
  let onAbort: () => void;
  const started = new Promise<void>((resolve, reject) => {
    const failed = () => { server.off("error", failed); reject(new Error("PROVIDER_TRANSPORT_LISTEN_FAILED")); };
    server.once("error", failed);
    server.listen(options.socketPath, () => {
      server.off("error", failed);
      if (closing || options.signal?.aborted) reject(new Error("PROVIDER_TRANSPORT_LISTEN_FAILED"));
      else resolve();
    });
  });
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    try { await started; } catch { /* A failed or aborted startup still owns cleanup. */ }
    for (const upstream of upstreams) upstream.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    options.signal?.removeEventListener("abort", onAbort);
  })();
  onAbort = () => { void close(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await started;
  } catch {
    await close();
    throw new Error("PROVIDER_TRANSPORT_LISTEN_FAILED");
  }
  return { close };
}
