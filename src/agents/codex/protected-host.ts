/** Out-of-guest stdio wrapper. Its status journal is never mounted in the sandbox. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";

type Spec = Readonly<{ args: string[]; statusFile: string; seedFile?: string; tlsSeedAdmission?: true }>;
type GuestSpec = Readonly<{ native: string; nativeArgs: string[]; socketPath: string; port: number;
  seededProbe?: true; lateExposure?: true; tlsProxy?: true }>;
export function nativeAuthPresent(headers: Readonly<Record<string, unknown>>): boolean {
  return ["authorization", "proxy-authorization", "x-api-key"].some(name => headers[name] !== undefined);
}

export function syntheticAccessTokenFresh(jwt: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (typeof jwt !== "string" || jwt.length > 65_536 || !Number.isSafeInteger(nowSeconds)) return false;
  const segments = jwt.split(".");
  if (segments.length !== 3 || segments[2] !== "synthetic" ||
      !/^[A-Za-z0-9_-]+$/.test(segments[0] ?? "") || !/^[A-Za-z0-9_-]+$/.test(segments[1] ?? "")) return false;
  try {
    const header = JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
    return header?.alg === "none" && header?.typ === "JWT" &&
      payload?.email === "passeur-synthetic@example.invalid" &&
      payload?.["https://api.openai.com/auth"]?.chatgpt_account_id === "synthetic-account" &&
      Number.isSafeInteger(payload.exp) && payload.exp > nowSeconds + 300;
  } catch { return false; }
}

/** The unlinked descriptor is the only seed byte source passed to Bubblewrap. */
export function snapshotCheckedSeed(raw: Buffer, parent: string): number {
  const anonymousPath = join(parent, `.seed-snapshot-${randomUUID()}`);
  const fd = openSync(anonymousPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < raw.length;) {
      const written = writeSync(fd, raw, offset, raw.length - offset, offset);
      if (written < 1) throw new Error("CODEX_PROTECTED_SEED_INVALID");
      offset += written;
    }
    if (fstatSync(fd).size !== raw.length) throw new Error("CODEX_PROTECTED_SEED_INVALID");
    unlinkSync(anonymousPath);
    return fd;
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(anonymousPath); } catch { /* The path may already be retired. */ }
    throw error;
  }
}

/** Stream bytes until only a possible prefix of a secret remains held back. */
export function credentialHoldback(secrets: readonly Buffer[], exposure: () => void): Transform {
  let pending = Buffer.alloc(0), failed = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (failed) { callback(); return; }
      const bytes = Buffer.concat([pending, chunk]);
      if (secrets.some(secret => bytes.includes(secret))) {
        failed = true; pending = Buffer.alloc(0); exposure(); callback(); return;
      }
      let held = 0;
      for (const secret of secrets) {
        for (let length = Math.min(secret.length - 1, bytes.length); length > held; length--) {
          if (bytes.subarray(bytes.length - length).equals(secret.subarray(0, length))) {
            held = length; break;
          }
        }
      }
      this.push(bytes.subarray(0, bytes.length - held));
      pending = Buffer.from(bytes.subarray(bytes.length - held));
      callback();
    },
    flush(callback) { if (!failed) this.push(pending); callback(); },
  });
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
  let sourceFd: number | undefined, launchFd: number | undefined;
  let seedSecrets: Buffer[] = [];
  if (spec.tlsSeedAdmission !== undefined && (spec.tlsSeedAdmission !== true || !spec.seedFile ||
      !spec.args.some((value, index) => value === "--setenv" && spec.args[index + 1] === "CODEX_CA_CERTIFICATE"))) {
    throw new Error("CODEX_PROTECTED_HOST_CONFIG_INVALID");
  }
  if (spec.seedFile !== undefined) {
    if (typeof spec.seedFile !== "string" || !/^\/tmp\/[A-Za-z0-9._-]+\/seed-auth\.json$/.test(spec.seedFile) ||
        !spec.args.some((value, index) => value === "--file" && spec.args[index + 1] === "4" &&
          spec.args[index + 2] === "/mounts/home/auth.json")) throw new Error("CODEX_PROTECTED_HOST_CONFIG_INVALID");
    let stale = false;
    try {
      const parent = dirname(spec.seedFile), parentStat = lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.uid !== process.getuid?.() ||
          (parentStat.mode & 0o7777) !== 0o700 || realpathSync(parent) !== parent) {
        throw new Error("CODEX_PROTECTED_SEED_INVALID");
      }
      sourceFd = openSync(spec.seedFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(sourceFd), named = lstatSync(spec.seedFile);
      if (!opened.isFile() || opened.uid !== process.getuid?.() || (opened.mode & 0o7777) !== 0o600 ||
          opened.nlink !== 1 || opened.size < 1 || opened.size > 65_536 ||
          opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("CODEX_PROTECTED_SEED_INVALID");
      // Reopen our held inode through proc so the descriptor copied by bwrap stays at offset zero.
      const raw = readFileSync(`/proc/self/fd/${sourceFd}`);
      if (raw.length !== opened.size) throw new Error("CODEX_PROTECTED_SEED_INVALID");
      const auth = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const tokens = auth.tokens as Record<string, unknown> | undefined;
      const jwt = tokens?.id_token;
      if (auth.auth_mode !== "chatgpt" || auth.OPENAI_API_KEY !== null ||
          typeof jwt !== "string" || !jwt.endsWith(".synthetic") ||
          tokens?.access_token !== jwt || tokens?.account_id !== "synthetic-account" ||
          typeof tokens?.refresh_token !== "string" || !tokens.refresh_token.startsWith("synthetic-") ||
          JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")).email !==
            "passeur-synthetic@example.invalid") throw new Error("CODEX_PROTECTED_SEED_INVALID");
      if (spec.tlsSeedAdmission && !syntheticAccessTokenFresh(jwt)) {
        stale = true; throw new Error("CODEX_PROTECTED_AUTH_STALE");
      }
      seedSecrets = [Buffer.from(jwt), Buffer.from(tokens.refresh_token)];
      launchFd = snapshotCheckedSeed(raw, parent);
      closeSync(sourceFd); sourceFd = undefined;
    } catch {
      if (sourceFd !== undefined) closeSync(sourceFd);
      if (launchFd !== undefined) closeSync(launchFd);
      if (stale) {
        appendFileSync(spec.statusFile, '{"kind":"admission","code":"CODEX_PROTECTED_AUTH_STALE"}\n', { mode: 0o600 });
        throw new Error("CODEX_PROTECTED_AUTH_STALE");
      }
      throw new Error("CODEX_PROTECTED_SEED_INVALID");
    }
  } else if (spec.args.includes("/mounts/home/auth.json")) throw new Error("CODEX_PROTECTED_HOST_CONFIG_INVALID");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("/usr/bin/bwrap", [...spec.args.slice(0, separator), "--json-status-fd", "3", ...spec.args.slice(separator)],
      { env: {}, stdio: ["pipe", "pipe", "pipe", "pipe", ...(launchFd === undefined ? [] : [launchFd])] });
  } finally { if (launchFd !== undefined) closeSync(launchFd); }
  if (!child.pid) throw new Error("CODEX_PROTECTED_HOST_START_FAILED");
  appendFileSync(spec.statusFile, `${JSON.stringify({ kind: "wrapper", pid: child.pid })}\n`);
  child.stdio[3]?.on("data", chunk => appendFileSync(spec.statusFile, chunk));
  process.stdin.pipe(child.stdin!);
  let exposed = false;
  const exposure = () => {
    if (exposed) return;
    exposed = true;
    appendFileSync(`${spec.statusFile}.exposure`, "seed-output-exposure\n", { flag: "wx", mode: 0o600 });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const stdoutGuard = seedSecrets.length ? credentialHoldback(seedSecrets, exposure) : undefined;
  const stderrGuard = seedSecrets.length ? credentialHoldback(seedSecrets, exposure) : undefined;
  child.stdout!.pipe(stdoutGuard ?? process.stdout);
  child.stderr!.pipe(stderrGuard ?? process.stderr);
  stdoutGuard?.pipe(process.stdout);
  stderrGuard?.pipe(process.stderr);
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    appendFileSync(spec.statusFile, `${JSON.stringify({ kind: "wrapper-exit", code, signal })}\n`);
    // The marker is the failure authority; preserve bwrap's numeric exit for the
    // independent namespace observer instead of forging a different wrapper exit.
    return signal === "SIGTERM" ? 143 : signal ? 128 : code ?? 1;
  } finally {
    stop();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.stdin.unpipe(child.stdin!);
    child.stdin!.destroy();
    child.stdout!.unpipe(stdoutGuard ?? process.stdout);
    child.stderr!.unpipe(stderrGuard ?? process.stderr);
    stdoutGuard?.unpipe(process.stdout);
    stderrGuard?.unpipe(process.stderr);
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
  const egress = spec.tlsProxy ? await import("./protected-egress.js") : undefined;
  const relay = egress ? egress.createGuestConnectProxy(spec.socketPath, () => {
    const violation = httpRequest({ socketPath: spec.socketPath, method: "CONNECT",
      path: "tool-probe.invalid:443", headers: { host: "tool-probe.invalid:443" }, agent: false });
    violation.on("connect", (_response, socket) => socket.destroy());
    violation.on("error", () => {}); violation.end();
  }) : createServer((incoming, outgoing) => {
    const accountCheck = spec.seededProbe && incoming.method === "GET" &&
      incoming.url === "/api/codex/accounts/check";
    const modelRequest = incoming.method === "POST" && incoming.url === "/v1/responses";
    if (++count > 32 || incoming.headers.host !== `127.0.0.1:${spec.port}` ||
        !accountCheck && !modelRequest || accountCheck &&
        (incoming.headers["content-length"] !== undefined || incoming.headers["transfer-encoding"] !== undefined)) {
      outgoing.writeHead(403).end(); return;
    }
    incoming.setTimeout(5_000, () => incoming.destroy());
    const forwarded = httpRequest({ socketPath: spec.socketPath, method: incoming.method, path: incoming.url,
      headers: { ...(modelRequest ? { "content-type": incoming.headers["content-type"] ?? "application/json",
        accept: incoming.headers.accept ?? "text/event-stream" } : {}),
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
  if (!spec.tlsProxy) relay.on("connect", (_request, socket) => socket.destroy());
  relay.on("upgrade", (_request, socket) => socket.destroy());
  if (spec.lateExposure && !spec.seededProbe || spec.tlsProxy && !spec.seededProbe) throw new Error("CODEX_PROTECTED_GUEST_CONFIG_INVALID");
  let native: ReturnType<typeof spawn> | undefined;
  let lateSecret: string | undefined;
  try {
    if (spec.seededProbe) {
      const original = readFileSync("/mounts/home/auth.json");
      if (original.length < 1 || original.length > 65_536) throw new Error("CODEX_PROTECTED_GUEST_SEED_INVALID");
      if (spec.lateExposure) {
        const auth = JSON.parse(original.toString("utf8")) as { tokens?: { access_token?: unknown } };
        if (typeof auth.tokens?.access_token !== "string") throw new Error("CODEX_PROTECTED_GUEST_SEED_INVALID");
        lateSecret = auth.tokens.access_token;
      }
      try {
        writeFileSync("/mounts/home/auth.json", "guest-replacement", { flag: "w", mode: 0o600 });
        if (!readFileSync("/mounts/home/auth.json").equals(Buffer.from("guest-replacement"))) {
          throw new Error("CODEX_PROTECTED_GUEST_REPLACEMENT_INVALID");
        }
      } finally { writeFileSync("/mounts/home/auth.json", original, { flag: "w", mode: 0o600 }); }
      if (!readFileSync("/mounts/home/auth.json").equals(original)) throw new Error("CODEX_PROTECTED_GUEST_RESTORE_INVALID");
    }
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(spec.port, "127.0.0.1", resolve);
    });
    if (spec.tlsProxy) {
      const authority = "accounts.fixture.invalid:443";
      await new Promise<void>((resolve, reject) => {
        const control = httpRequest({ hostname: "127.0.0.1", port: spec.port, method: "CONNECT",
          path: authority, headers: { host: authority }, agent: false });
        control.once("connect", (response, socket) => {
          socket.destroy();
          if (response.statusCode === 200) resolve();
          else reject(new Error("CODEX_PROTECTED_GUEST_PROXY_CONTROL_FAILED"));
        });
        control.once("error", reject);
        control.end();
      });
    }
    native = spawn(spec.native, spec.nativeArgs, { cwd: process.cwd(), env: process.env,
      stdio: ["pipe", "pipe", "pipe"] });
    process.stdin.pipe(native.stdin!);
    native.stdout!.pipe(process.stdout);
    native.stderr!.pipe(process.stderr);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      native!.once("error", reject);
      native!.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    if (lateSecret) process.stderr.write(`${lateSecret}\n`);
    return signal ? 128 : code ?? 1;
  } finally {
    if (native?.exitCode === null && native.signalCode === null) native.kill("SIGTERM");
    if (relay.listening) {
      egress?.retireGuestConnectProxy(relay);
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
