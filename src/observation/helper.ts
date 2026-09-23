import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../core/errors.js";
import type { Extraction, SourceFile } from "./model.js";
import { decodeHelperExtraction, HELPER_PROTOCOL_VERSION, MAX_HELPER_REPLY_BYTES, MAX_HELPER_REQUEST_BYTES, MAX_SOURCE_BYTES } from "./helper-protocol.js";
import { nativeParserIdentity, type NativeDialect } from "./native-parser.js";
import { sourceReference } from "./source.js";
import { nativeExtractorIdentity } from "./extractor-identity.js";

const MAX_WAITING_JOBS = 4;
const ANALYSIS_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
// Linux VmRSS includes the native Tree-sitter grammar and engine allocations that V8's heap cap omits.
const MAX_ANALYSIS_CHILD_RSS_KIB = 512 * 1024;
const RSS_SAMPLE_INTERVAL_MS = 100;
const MAX_PROC_STATUS_BYTES = 64 * 1024;
const MAX_EXTRACTION_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTION_CACHE_ENTRIES = 16;
type Job = { file: SourceFile; dialect: NativeDialect; cacheKey: string; signal?: AbortSignal;
  resolve: (value: Extraction) => void; reject: (reason: unknown) => void; abort: () => void };

/** One analysis child at a time. Its timeout/abort affects only this helper, never coding workers. */
export class NativeAnalysisHelper {
  #installedBuildId: string | undefined;
  #rssLimitKib: number;
  #queue: Job[] = [];
  #child: ChildProcess | undefined;
  #active: Job | undefined;
  #settled: Promise<void> | undefined;
  #terminateActive: (() => void) | undefined;
  #closed = false;
  #extractions = new Map<string, string>();
  #extractionBytes = 0;

  constructor(installedBuildId?: string, rssLimitKib = MAX_ANALYSIS_CHILD_RSS_KIB) {
    if (installedBuildId !== undefined && !/^[0-9a-f]{64}$/.test(installedBuildId)) {
      throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Native helper received an invalid installed build identity");
    }
    if (!Number.isSafeInteger(rssLimitKib) || rssLimitKib < 1 || rssLimitKib > MAX_ANALYSIS_CHILD_RSS_KIB) {
      throw new BridgeError("STRUCTURAL_ANALYSIS_RESOURCE_LIMIT_INVALID", "Native helper RSS limit is outside the supported range");
    }
    this.#installedBuildId = installedBuildId;
    this.#rssLimitKib = rssLimitKib;
  }

  extract(file: SourceFile, dialect: NativeDialect, signal?: AbortSignal): Promise<Extraction> {
    if (this.#closed) return Promise.reject(new BridgeError("STRUCTURAL_HELPER_CLOSED", "Native analysis admission is closed"));
    if (file.status !== "present") return Promise.reject(new BridgeError("STRUCTURAL_SOURCE_UNAVAILABLE", "Native analysis requires captured source bytes"));
    if (file.byte_length > MAX_SOURCE_BYTES || file.byte_length < 0 || !Number.isSafeInteger(file.byte_length) ||
        file.text.length > MAX_SOURCE_BYTES || Buffer.byteLength(file.text, "utf8") !== file.byte_length) {
      return Promise.reject(new BridgeError("SOURCE_TOO_LARGE", "Source exceeds the analysis byte limit"));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    const actualDigest = createHash("sha256").update(file.text).digest("hex");
    if (actualDigest !== file.content_sha256) {
      return Promise.reject(new BridgeError("STRUCTURAL_HELPER_REQUEST_INVALID", "Captured source digest does not match its bytes"));
    }
    const cacheKey = `${actualDigest}:${dialect}:${nativeParserIdentity(dialect)}:${nativeExtractorIdentity(dialect)}:${this.#installedBuildId ?? "development"}`;
    let reused: Extraction | undefined;
    try { reused = this.#reuse(cacheKey, file, dialect); }
    catch (cause) { return Promise.reject(cause); }
    if (reused) return Promise.resolve(reused);
    if (this.#queue.length >= MAX_WAITING_JOBS) return Promise.reject(new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native analysis queue is full"));
    return new Promise<Extraction>((resolve, reject) => {
      const job: Job = { file, dialect, cacheKey, ...(signal ? { signal } : {}), resolve, reject, abort: () => {
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
    if (job.signal?.aborted) {
      job.signal.removeEventListener("abort", job.abort);
      job.reject(job.signal.reason);
      this.#pump();
      return;
    }
    let reused: Extraction | undefined;
    try { reused = this.#reuse(job.cacheKey, job.file, job.dialect); }
    catch (cause) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(cause);
      this.#pump();
      return;
    }
    if (reused) {
      job.signal?.removeEventListener("abort", job.abort);
      job.resolve(reused);
      this.#pump();
      return;
    }
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
    let rssTimer: NodeJS.Timeout | undefined;
    let samplingRss = false;
    let missingRssSamples = 0;
    const finish = (exitCode?: number | null, exitSignal?: NodeJS.Signals | null) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      if (rssTimer) clearInterval(rssTimer);
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
      if (!failure) this.#retain(job.cacheKey, reply as Extraction);
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
    if (process.platform === "linux") {
      // The guard observes only this owned analysis child; it never signals coding workers.
      const sampleRss = async () => {
        if (terminal || samplingRss || child.pid === undefined) return;
        samplingRss = true;
        try {
          const status = await readFile(`/proc/${child.pid}/status`);
          if (terminal) return;
          if (status.byteLength > MAX_PROC_STATUS_BYTES) throw new Error("oversized proc status");
          const match = /^VmRSS:\s+(\d+) kB$/m.exec(status.toString("utf8"));
          // A newly forked child or a zombie can briefly have no memory map.
          if (!match) {
            if (++missingRssSamples > 10) throw new Error("missing VmRSS for one second");
            return;
          }
          missingRssSamples = 0;
          const rssKib = Number(match[1]);
          if (!Number.isSafeInteger(rssKib)) throw new Error("invalid VmRSS");
          if (rssKib > this.#rssLimitKib) {
            failure = new BridgeError("STRUCTURAL_ANALYSIS_RESOURCE_LIMIT", "Native analysis child exceeded its RSS limit");
            terminate();
          }
        } catch (cause) {
          if (!terminal && child.exitCode === null && child.signalCode === null) {
            failure = new BridgeError("STRUCTURAL_ANALYSIS_RESOURCE_UNAVAILABLE", "Native analysis child memory could not be observed", { cause });
            terminate();
          }
        } finally { samplingRss = false; }
      };
      rssTimer = setInterval(() => { void sampleRss(); }, RSS_SAMPLE_INTERVAL_MS);
      rssTimer.unref();
      void sampleRss();
    }
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

  #reuse(key: string, file: SourceFile, dialect: NativeDialect): Extraction | undefined {
    const retained = this.#extractions.get(key);
    if (!retained) return undefined;
    // The parsed syntax is content-owned; every public result keeps the requesting capture identity.
    const extraction = decodeHelperExtraction({ ...JSON.parse(retained) as Extraction, source: sourceReference(file) }, file, dialect);
    this.#extractions.delete(key);
    this.#extractions.set(key, retained);
    return extraction;
  }

  #retain(key: string, extraction: Extraction): void {
    const retained = JSON.stringify(extraction);
    const bytes = Buffer.byteLength(retained, "utf8");
    if (bytes > MAX_EXTRACTION_CACHE_BYTES) return;
    while (this.#extractions.size >= MAX_EXTRACTION_CACHE_ENTRIES || this.#extractionBytes + bytes > MAX_EXTRACTION_CACHE_BYTES) {
      const oldest = this.#extractions.keys().next().value;
      if (oldest === undefined) break;
      const previous = this.#extractions.get(oldest)!;
      this.#extractions.delete(oldest);
      this.#extractionBytes -= Buffer.byteLength(previous, "utf8");
    }
    this.#extractions.set(key, retained);
    this.#extractionBytes += bytes;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#extractions.clear();
    this.#extractionBytes = 0;
    this.#rejectWaiting(new BridgeError("STRUCTURAL_HELPER_CLOSED", "Native analysis admission is closed"));
    if (this.#child) {
      this.#terminateActive?.();
      await this.#settled;
    }
  }
}
