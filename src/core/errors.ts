export class BridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BridgeError"; }
}
