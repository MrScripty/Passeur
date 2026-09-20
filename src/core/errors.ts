export class BridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BridgeError"; }
}
export function errorInfo(error: unknown): { code: string; message: string } {
  return error instanceof BridgeError
    ? { code: error.code, message: error.message }
    : { code: "BRIDGE_ERROR", message: error instanceof Error ? error.message : String(error) };
}
