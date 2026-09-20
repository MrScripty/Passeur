/** Domain failures retain their cause; public projections contain only bounded, redacted context. */
export type FailureContext = {
  cause?: unknown;
  stage?: string;
  path?: string;
  native_code?: string;
  next_action?: string;
};
export type ErrorInfo = { code: string; message: string } & Omit<FailureContext, "cause">;

export class BridgeError extends Error {
  readonly context: Omit<FailureContext, "cause">;
  constructor(readonly code: string, message: string, context: FailureContext = {}) {
    super(message, { cause: context.cause });
    this.name = "BridgeError";
    const { cause: _cause, ...details } = context;
    this.context = details;
  }
}

export function nativeCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function safeText(value: string, limit = 2048): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
    .slice(0, limit);
}

export function diagnosticInfo(error: unknown): ErrorInfo {
  const code = error instanceof BridgeError ? error.code : "BRIDGE_ERROR";
  const message = safeText(error instanceof Error ? error.message : String(error));
  const context = error instanceof BridgeError ? error.context : {};
  const native = context.native_code ?? (error instanceof BridgeError ? undefined : nativeCode(error));
  return {
    code: safeText(code, 128), message,
    ...(context.stage ? { stage: safeText(context.stage, 128) } : {}),
    ...(context.path ? { path: safeText(context.path, 4096) } : {}),
    ...(native ? { native_code: safeText(native, 64) } : {}),
    ...(context.next_action ? { next_action: safeText(context.next_action, 1024) } : {}),
  };
}

/** Classify filesystem failure where its operation and authority are known. */
export function filesystemFailure(error: unknown, stage: string, path: string): BridgeError {
  if (error instanceof BridgeError) return error;
  const native = nativeCode(error);
  const code = native === "EACCES" || native === "EPERM" ? "PERMISSION_DENIED"
    : native === "EROFS" ? "STORAGE_READ_ONLY"
    : native === "ENOSPC" || native === "EDQUOT" ? "STORAGE_FULL"
    : native === "ENOENT" ? "PATH_NOT_FOUND" : "STORAGE_UNAVAILABLE";
  return new BridgeError(code, `Filesystem operation failed: ${stage}`, {
    cause: error, stage, path, ...(native ? { native_code: native } : {}),
    next_action: "Check the configured path and its access; preserve the existing state namespace.",
  });
}

/** Existing task/result error representation; diagnostics have a separate versioned projection. */
export function errorInfo(error: unknown): { code: string; message: string } {
  const { code, message } = diagnosticInfo(error);
  return { code, message };
}
