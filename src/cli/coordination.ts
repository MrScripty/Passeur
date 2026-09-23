import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";
import { decodeCoordinationRequest, type CoordinationReply, type CoordinationRequest, type CoordinationEndpoint } from "../contracts/coordination-service.js";

// Includes indentation/escaping overhead. The decoded message keeps its independent, tighter contract bound.
export const COORDINATION_REQUEST_FILE_BYTES = 65_536;

/** Capture an explicit operator file once. Replaced paths cannot change the admitted request afterward. */
export async function readCoordinationRequestFile(path: string, signal?: AbortSignal): Promise<CoordinationRequest> {
  throwIfAborted(signal);
  if (typeof path !== "string" || !path.length || Buffer.byteLength(path) > 4096 || path.includes("\0")) {
    throw new BridgeError("COORDINATION_REQUEST_FILE_INVALID", "Expected a bounded request-file path");
  }
  if (process.platform !== "linux" || !Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw new BridgeError("COORDINATION_REQUEST_PLATFORM_UNSUPPORTED", "Request-file capture requires the supported Linux native file flags");
  }
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if (nativeCode(error) === "ELOOP") throw new BridgeError("COORDINATION_REQUEST_FILE_UNSAFE", "The request file must not be a symlink", { cause: error });
    throw filesystemFailure(error, "coordination.request.open", path);
  }
  let bytes: Buffer;
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new BridgeError("COORDINATION_REQUEST_FILE_UNSAFE", "The request must be a regular file");
    if (initial.size > COORDINATION_REQUEST_FILE_BYTES) throw new BridgeError("COORDINATION_REQUEST_FILE_LIMIT", "Request file exceeds its byte bound");
    const buffer = Buffer.alloc(initial.size + 1);
    let length = 0;
    while (length < buffer.length) {
      throwIfAborted(signal);
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const observed = await handle.stat();
    if (length !== initial.size || observed.size !== initial.size || observed.mtimeMs !== initial.mtimeMs || observed.ctimeMs !== initial.ctimeMs) {
      throw new BridgeError("COORDINATION_REQUEST_FILE_CHANGED", "Request file changed during capture; inspect it before resubmitting");
    }
    bytes = buffer.subarray(0, length);
  } catch (error) { throw filesystemFailure(error, "coordination.request.read", path); }
  finally { await handle.close(); }
  throwIfAborted(signal);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (cause) { throw new BridgeError("COORDINATION_REQUEST_FILE_INVALID", "The request is not valid UTF-8 JSON", { cause }); }
  return decodeCoordinationRequest(value);
}

/** Confirmation is selected by the operator's invocation, never by fields in the JSON request. */
export function authorizeCoordinationCliRequest(value: unknown, confirmed: boolean): CoordinationRequest {
  const request = decodeCoordinationRequest(value);
  if ((request.kind === "command" || request.kind === "initialize") && confirmed !== true) {
    throw new BridgeError("MUTATION_AUTHORITY_REQUIRED", "coordinate mutations require explicit operator --yes authority");
  }
  return request;
}

/** The CLI keeps ownership of the borrowed connection and its shutdown. Validation precedes connection effects. */
export async function runCoordinationCli(path: string, confirmed: boolean, connect: () => Promise<CoordinationEndpoint>,
  signal?: AbortSignal): Promise<CoordinationReply> {
  const request = authorizeCoordinationCliRequest(await readCoordinationRequestFile(path, signal), confirmed);
  throwIfAborted(signal);
  const frontend = await connect();
  throwIfAborted(signal);
  return frontend.coordinate(request, signal);
}
