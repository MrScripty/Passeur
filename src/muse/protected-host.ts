/** Process entry point for a task-owned protected Muse host. No provider policy lives here. */
import { spawn } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";

type HostSpec = Readonly<{ bwrapArgs: string[]; statusFile: string }>;
type GuestSpec = Readonly<{ museBin: string; museArgs: string[]; relaySocket: string; home: string;
  relayHeaders: Record<string, string> }>;

function boundedSpec<T>(encoded: string | undefined): T {
  if (!encoded || encoded.length > 262_144) throw new Error("PROTECTED_HOST_CONFIG_INVALID");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

export function prepareProtectedSessions(home: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("PROTECTED_SESSIONS_INVALID");
  let path = home;
  for (const part of [".local", "share", "muse", "sessions"]) {
    path = `${path}/${part}`;
    mkdirSync(path, { mode: 0o700 });
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.uid !== uid ||
        (entry.mode & 0o7777) !== 0o700) throw new Error("PROTECTED_SESSIONS_INVALID");
  }
  if (readdirSync(path).length !== 0) throw new Error("PROTECTED_SESSIONS_INVALID");
}

export async function runProtectedHost(spec: HostSpec,
  spawnHost: typeof spawn = spawn,
  streams: Readonly<{ stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream }> = process): Promise<number> {
  if (!Array.isArray(spec.bwrapArgs) || spec.bwrapArgs.length === 0 ||
      spec.bwrapArgs.some(value => typeof value !== "string") ||
      typeof spec.statusFile !== "string") throw new Error("PROTECTED_HOST_CONFIG_INVALID");
  const separator = spec.bwrapArgs.indexOf("--");
  if (separator < 0) throw new Error("PROTECTED_HOST_CONFIG_INVALID");
  const child = spawnHost("bwrap", [...spec.bwrapArgs.slice(0, separator), "--json-status-fd", "3",
    ...spec.bwrapArgs.slice(separator)], { env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  child.stdio[3]?.on("data", chunk => appendFileSync(spec.statusFile, chunk));
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  try {
    appendFileSync(spec.statusFile, `${JSON.stringify({ kind: "wrapper", pid: child.pid })}\n`);
    streams.stdin.pipe(child.stdin);
    child.stdout.pipe(streams.stdout);
    child.stderr.pipe(streams.stderr);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    appendFileSync(spec.statusFile, `${JSON.stringify({ kind: "wrapper-exit", code, signal })}\n`);
    return signal ? 128 : code ?? 1;
  } finally {
    stop();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    streams.stdin.unpipe(child.stdin);
    child.stdin.destroy();
    child.stdout.unpipe(streams.stdout);
    child.stderr.unpipe(streams.stderr);
  }
}

export async function runProtectedGuest(spec: GuestSpec,
  makeRelay: typeof createServer = createServer,
  spawnNative: typeof spawn = spawn): Promise<number> {
  if (typeof spec.museBin !== "string" || !spec.museBin.startsWith("/") ||
      !Array.isArray(spec.museArgs) || spec.museArgs.some(value => typeof value !== "string") ||
      typeof spec.relaySocket !== "string" || !spec.relaySocket.startsWith("/") ||
      typeof spec.home !== "string" || !spec.home.startsWith("/") ||
      !spec.relayHeaders || Object.entries(spec.relayHeaders).some(([key, value]) =>
        !/^x-[a-z0-9-]{1,62}$/.test(key) || typeof value !== "string" || value.length > 256)) {
    throw new Error("PROTECTED_GUEST_CONFIG_INVALID");
  }
  let requestCount = 0, active = 0;
  const relay = makeRelay((incoming, outgoing) => {
    if (++requestCount > 32 || active >= 4) { outgoing.writeHead(429).end(); return; }
    active++;
    outgoing.once("close", () => { active--; });
    incoming.setTimeout(5_000, () => incoming.destroy());
    // Request intake is bounded; provider inference after a complete request is task-owned.
    incoming.once("end", () => incoming.setTimeout(0));
    const headers = { host: "127.0.0.1:1", authorization: incoming.headers.authorization,
      accept: "application/json, text/event-stream",
      ...(incoming.headers["content-type"] ? { "content-type": incoming.headers["content-type"] } : {}),
      ...(incoming.headers["content-length"] ? { "content-length": incoming.headers["content-length"] } : {}),
      ...spec.relayHeaders };
    const forwarding = httpRequest({ socketPath: spec.relaySocket, method: incoming.method,
      path: incoming.url, headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 502,
        { "content-type": response.headers["content-type"] ?? "application/json" });
      response.once("error", () => outgoing.destroy());
      response.once("close", () => { if (!response.complete) outgoing.destroy(); });
      response.pipe(outgoing);
    });
    forwarding.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end();
      else outgoing.destroy(); });
    outgoing.on("close", () => forwarding.destroy());
    let bytes = 0;
    incoming.on("data", chunk => { bytes += chunk.length;
      if (bytes > 262_144) { incoming.destroy(); forwarding.destroy(); outgoing.destroy(); } });
    incoming.pipe(forwarding);
  });
  relay.on("connect", (_request, socket) => socket.destroy());
  relay.on("upgrade", (_request, socket) => socket.destroy());
  relay.requestTimeout = 5_000;
  relay.headersTimeout = 5_000;
  let native: ReturnType<typeof spawn> | undefined;
  try {
    const address = await new Promise<number>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", () => {
        const value = relay.address();
        if (!value || typeof value === "string") reject(new Error("PROTECTED_RELAY_INVALID"));
        else resolve(value.port);
      });
    });
    prepareProtectedSessions(spec.home);
    const settings = `${spec.home}/.config/muse`;
    mkdirSync(settings, { recursive: true, mode: 0o700 });
    writeFileSync(`${settings}/settings.json`, `${JSON.stringify({ schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${address}`, auth: "bearer" } })}\n`,
    { mode: 0o600 });
    const env = { HOME: spec.home, TMPDIR: "/tmp", PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
      XDG_CONFIG_HOME: `${spec.home}/.config`, XDG_DATA_HOME: `${spec.home}/.local/share`,
      XDG_CACHE_HOME: `${spec.home}/.cache`, XDG_STATE_HOME: `${spec.home}/.local/state` };
    // The generic host supplies a loopback relay, not credentials or provider decisions.
    native = spawnNative(spec.museBin, spec.museArgs,
      { env, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    process.stdin.pipe(native.stdin!);
    native.stdout!.pipe(process.stdout);
    native.stderr!.pipe(process.stderr);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      native!.once("error", reject);
      native!.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    return signal ? 128 : code ?? 1;
  } finally {
    if (native) {
      if (native.exitCode === null && native.signalCode === null) native.kill("SIGTERM");
      process.stdin.unpipe(native.stdin!);
      native.stdin?.destroy();
      native.stdout?.unpipe(process.stdout);
      native.stderr?.unpipe(process.stderr);
    }
    if (relay.listening) {
      relay.closeAllConnections();
      await new Promise<void>(resolve => relay.close(() => resolve()));
    }
  }
}

if (process.argv[1]?.endsWith("/protected-host.js")) {
  const mode = process.argv[2];
  const spec = boundedSpec<HostSpec & GuestSpec>(process.argv[3]);
  void (mode === "host" ? runProtectedHost(spec).then(code => { process.exitCode = code; }) :
    mode === "guest" ? runProtectedGuest(spec).then(code => { process.exitCode = code; }) :
    Promise.reject(new Error("PROTECTED_HOST_MODE_INVALID")))
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "PROTECTED_HOST_FAILED"}\n`); process.exitCode = 1; });
}
