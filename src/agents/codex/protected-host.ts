/** Out-of-guest stdio wrapper. Its status journal is never mounted in the sandbox. */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";

type Spec = Readonly<{ args: string[]; statusFile: string }>;
type GuestSpec = Readonly<{ native: string; nativeArgs: string[]; socketPath: string; port: number }>;
export function nativeAuthPresent(headers: Readonly<Record<string, unknown>>): boolean {
  return ["authorization", "proxy-authorization", "x-api-key"].some(name => headers[name] !== undefined);
}

export async function runProtectedHost(spec: Spec): Promise<number> {
  if (!Array.isArray(spec.args) || spec.args.length < 2 || spec.args.filter(value => value === "--").length !== 1 ||
      spec.args.some(value => typeof value !== "string" || value.includes("\0")) ||
      typeof spec.statusFile !== "string" || !spec.statusFile.startsWith("/")) {
    throw new Error("CODEX_PROTECTED_HOST_CONFIG_INVALID");
  }
  const separator = spec.args.indexOf("--");
  if (separator < 1 || separator + 1 >= spec.args.length || !spec.args[separator + 1]?.startsWith("/")) {
    throw new Error("CODEX_PROTECTED_HOST_CONFIG_INVALID");
  }
  const child = spawn("/usr/bin/bwrap", [...spec.args.slice(0, separator), "--json-status-fd", "3", ...spec.args.slice(separator)],
    { env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  if (!child.pid) throw new Error("CODEX_PROTECTED_HOST_START_FAILED");
  appendFileSync(spec.statusFile, `${JSON.stringify({ kind: "wrapper", pid: child.pid })}\n`);
  child.stdio[3]?.on("data", chunk => appendFileSync(spec.statusFile, chunk));
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
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
    process.stdin.unpipe(child.stdin);
    child.stdin.destroy();
    child.stdout.unpipe(process.stdout);
    child.stderr.unpipe(process.stderr);
  }
}

/** Fixture-only loopback endpoint. The host socket owner validates provider sequencing. */
export async function runProtectedGuest(spec: GuestSpec): Promise<number> {
  if (!spec.native?.startsWith("/") || !Array.isArray(spec.nativeArgs) ||
      spec.nativeArgs.some(value => typeof value !== "string") ||
      !spec.socketPath?.startsWith("/mounts/relay/") ||
      !Number.isSafeInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
    throw new Error("CODEX_PROTECTED_GUEST_CONFIG_INVALID");
  }
  let count = 0;
  const relay = createServer((incoming, outgoing) => {
    if (++count > 32 || incoming.method !== "POST" || incoming.url !== "/v1/responses") {
      outgoing.writeHead(403).end(); return;
    }
    incoming.setTimeout(5_000, () => incoming.destroy());
    const forwarded = httpRequest({ socketPath: spec.socketPath, method: "POST", path: incoming.url,
      headers: { "content-type": incoming.headers["content-type"] ?? "application/json",
        accept: incoming.headers.accept ?? "text/event-stream",
        "x-passeur-native-auth-present": nativeAuthPresent(incoming.headers) ? "1" : "0" }, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 502,
        { "content-type": response.headers["content-type"] ?? "application/json" });
      response.pipe(outgoing);
    });
    let bytes = 0;
    incoming.on("data", chunk => { bytes += chunk.length; if (bytes > 262_144) { incoming.destroy(); forwarded.destroy(); outgoing.destroy(); } });
    incoming.pipe(forwarded);
    forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); });
    outgoing.on("close", () => forwarded.destroy());
  });
  relay.on("connect", (_request, socket) => socket.destroy());
  relay.on("upgrade", (_request, socket) => socket.destroy());
  let native: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(spec.port, "127.0.0.1", resolve);
    });
    native = spawn(spec.native, spec.nativeArgs, { cwd: process.cwd(), env: process.env,
      stdio: ["pipe", "pipe", "pipe"] });
    process.stdin.pipe(native.stdin!);
    native.stdout!.pipe(process.stdout);
    native.stderr!.pipe(process.stderr);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      native!.once("error", reject);
      native!.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    return signal ? 128 : code ?? 1;
  } finally {
    if (native?.exitCode === null && native.signalCode === null) native.kill("SIGTERM");
    if (relay.listening) {
      relay.closeAllConnections();
      await new Promise<void>(resolve => relay.close(() => resolve()));
    }
  }
}

if (process.argv[1]?.endsWith("/codex/protected-host.js")) {
  try {
    const encoded = process.argv[2] === "guest" ? process.argv[3] : process.argv[2];
    if (!encoded || encoded.length > 262_144) throw new Error("CODEX_PROTECTED_HOST_CONFIG_INVALID");
    const spec = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Spec & GuestSpec;
    void (process.argv[2] === "guest" ? runProtectedGuest(spec) : runProtectedHost(spec))
      .then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
  } catch { process.exitCode = 1; }
}
