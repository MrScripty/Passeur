import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../core/errors.js";
import type { Extraction, SourceFile } from "./model.js";
import { decodeHelperExtraction, HELPER_PROTOCOL_VERSION, MAX_HELPER_REPLY_BYTES, MAX_HELPER_REQUEST_BYTES, MAX_SOURCE_BYTES } from "./helper-protocol.js";
import type { NativeDialect } from "./native-parser.js";

const MAX_WAITING_JOBS = 4;
const ANALYSIS_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
type Job = { file: SourceFile; dialect: NativeDialect; signal?: AbortSignal;
  resolve: (value: Extraction) => void; reject: (reason: unknown) => void; abort: () => void };

/** One analysis child at a time. Its timeout/abort affects only this helper, never coding workers. */
export class NativeAnalysisHelper {
  #installedBuildId: string | undefined;
  #queue: Job[] = [];
  #child: ChildProcess | undefined;
  #active: Job | undefined;
  #settled: Promise<void> | undefined;
  #terminateActive: (() => void) | undefined;
  #closed = false;

  constructor(installedBuildId?: string) {
    if (installedBuildId !== undefined && !/^[0-9a-f]{64}$/.test(installedBuildId)) {
      throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Native helper received an invalid installed build identity");
    }
    this.#installedBuildId = installedBuildId;
  }

  extract(file: SourceFile, dialect: NativeDialect, signal?: AbortSignal): Promise<Extraction> {
    if (this.#closed) return Promise.reject(new BridgeError("STRUCTURAL_HELPER_CLOSED", "Native analysis admission is closed"));
    if (file.status !== "present") return Promise.reject(new BridgeError("STRUCTURAL_SOURCE_UNAVAILABLE", "Native analysis requires captured source bytes"));
    if (dialect !== "rust" && dialect !== "typescript" && dialect !== "tsx") {
      return Promise.reject(new BridgeError("STRUCTURAL_DIALECT_UNSUPPORTED", "Function extraction is not qualified for this dialect"));
    }
    if (file.byte_length > MAX_SOURCE_BYTES || file.byte_length < 0 || !Number.isSafeInteger(file.byte_length) ||
        file.text.length > MAX_SOURCE_BYTES || Buffer.byteLength(file.text, "utf8") !== file.byte_length) {
      return Promise.reject(new BridgeError("SOURCE_TOO_LARGE", "Source exceeds the analysis byte limit"));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length >= MAX_WAITING_JOBS) return Promise.reject(new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native analysis queue is full"));
    return new Promise<Extraction>((resolve, reject) => {
      const job: Job = { file, dialect, ...(signal ? { signal } : {}), resolve, reject, abort: () => {
        if (this.#active === job) this.#terminateActive?.();
        else {
          const index = this.#queue.indexOf(job);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(signal?.reason ?? new BridgeError("STRUCTURAL_ANALYSIS_CANCELLED", "Analysis was cancelled"));
        }
      } };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.#queue.push(job);
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#closed || this.#active || !this.#queue.length) return;
    const job = this.#queue.shift()!;
    this.#active = job;
    const jobId = randomUUID();
    const request = { version: HELPER_PROTOCOL_VERSION, kind: "extract", job_id: jobId, dialect: job.dialect, file: job.file };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_HELPER_REQUEST_BYTES) {
      this.#finish(job, new BridgeError("STRUCTURAL_HELPER_REQUEST_TOO_LARGE", "Analysis request exceeds IPC limit"));
      return;
    }
    let child: ChildProcess;
    try {
      const entry = fileURLToPath(new URL("./helper-main.js", import.meta.url));
      child = fork(entry, [], { cwd: dirname(entry), execArgv: ["--max-old-space-size=256"],
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "production",
          ...(this.#installedBuildId ? { PASSEUR_NATIVE_BUILD_ID: this.#installedBuildId } : {}) },
        stdio: ["ignore", "pipe", "ignore", "ipc"] });
    } catch (cause) {
      this.#finish(job, new BridgeError("STRUCTURAL_HELPER_UNAVAILABLE", "Native analysis child could not start", { cause }));
      return;
    }
    this.#child = child;
    let reply: unknown, failure: unknown;
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settle!: () => void;
    this.#settled = new Promise<void>(resolve => { settle = resolve; });
    let terminal = false;
    let terminationWatchdog: NodeJS.Timeout | undefined;
    const finish = (exitCode?: number | null, exitSignal?: NodeJS.Signals | null) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      if (terminationWatchdog) clearTimeout(terminationWatchdog);
      this.#child = undefined;
      this.#terminateActive = undefined;
      if (job.signal?.aborted) failure = job.signal.reason ?? new BridgeError("STRUCTURAL_ANALYSIS_CANCELLED", "Analysis was cancelled");
      if (!failure && (exitCode !== undefined || exitSignal !== undefined) && (exitCode !== 0 || exitSignal)) {
        failure = new BridgeError("STRUCTURAL_ANALYSIS_INCOMPLETE", "Native analysis child exited before completing its job");
      }
      if (!failure) {
        try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { failure = new BridgeError("STRUCTURAL_HELPER_REPLY_INVALID", "Native helper returned malformed framed output"); }
      }
      if (!failure) {
        const frame = reply as Record<string, unknown> | undefined;
        if (!frame || frame.version !== HELPER_PROTOCOL_VERSION || frame.job_id !== jobId ||
            (frame.kind !== "result" && frame.kind !== "failure")) {
          failure = new BridgeError("STRUCTURAL_HELPER_REPLY_INVALID", "Native helper exited without a matching reply");
        } else if (frame.kind === "failure") {
          failure = typeof frame.code === "string" && /^[A-Z0-9_]{1,80}$/.test(frame.code)
            ? new BridgeError("STRUCTURAL_ANALYSIS_INCOMPLETE", `Native analysis failed: ${frame.code}`)
            : new BridgeError("STRUCTURAL_HELPER_REPLY_INVALID", "Native helper returned a malformed failure code");
        } else {
          try { reply = decodeHelperExtraction(frame.extraction, job.file, job.dialect); }
          catch (cause) { failure = cause; }
        }
      }
      this.#finish(job, failure, reply as Extraction);
      settle();
    };
    const terminate = () => {
      if (terminal) return;
      let signalled = false;
      try { signalled = child.kill("SIGKILL"); } catch { /* The watchdog closes admission if the child remains live. */ }
      if (!signalled && (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)) {
        finish();
        return;
      }
      terminationWatchdog ??= setTimeout(() => {
        // A missing close event cannot release this slot to another native child.
        this.#closed = true;
        this.#rejectWaiting(new BridgeError("STRUCTURAL_HELPER_UNAVAILABLE", "Native analysis child did not close after termination"));
        failure ??= new BridgeError("STRUCTURAL_HELPER_UNAVAILABLE", "Native analysis child did not close after termination");
        finish();
      }, TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(() => {
      failure = new BridgeError("STRUCTURAL_ANALYSIS_TIMEOUT", "Native analysis exceeded its job timeout");
      terminate();
    }, ANALYSIS_TIMEOUT_MS);
    timeout.unref();
    this.#terminateActive = terminate;
    child.stdout?.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_HELPER_REPLY_BYTES) {
        failure = new BridgeError("STRUCTURAL_HELPER_REPLY_TOO_LARGE", "Native helper reply exceeded the framed output limit");
        terminate();
      } else chunks.push(chunk);
    });
    child.on("error", cause => {
      failure = new BridgeError("STRUCTURAL_HELPER_UNAVAILABLE", "Native analysis child failed", { cause });
      terminate();
    });
    child.on("close", finish);
    try {
      child.send(request, error => {
        if (error && !terminal) {
          failure = new BridgeError("STRUCTURAL_HELPER_UNAVAILABLE", "Native analysis request could not be delivered", { cause: error });
          terminate();
        }
      });
    } catch (cause) {
      failure = new BridgeError("STRUCTURAL_HELPER_UNAVAILABLE", "Native analysis request could not be delivered", { cause });
      terminate();
    }
  }

  #finish(job: Job, failure: unknown, value?: Extraction): void {
    job.signal?.removeEventListener("abort", job.abort);
    this.#active = undefined;
    if (failure) job.reject(failure); else job.resolve(value!);
    this.#pump();
  }

  #rejectWaiting(reason: BridgeError): void {
    for (const job of this.#queue.splice(0)) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(reason);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#rejectWaiting(new BridgeError("STRUCTURAL_HELPER_CLOSED", "Native analysis admission is closed"));
    if (this.#child) {
      this.#terminateActive?.();
      await this.#settled;
    }
  }
}
