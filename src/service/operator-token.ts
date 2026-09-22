import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { BridgeError, nativeCode } from "../core/errors.js";
import { privateDirectory, privateFile } from "./process.js";

/** Explicit operator CLI invocations share a private reconnect identity; MCP front ends do not use this file. */
export async function operatorToken(binding: Readonly<{ storeRoot: string }>, create = false): Promise<string | undefined> {
  try { await privateDirectory(binding.storeRoot, create); }
  catch (error) { if (!create && nativeCode(error) === "ENOENT") return undefined; throw error; }
  const path = join(binding.storeRoot, "operator-control.token");
  if (create) try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(randomBytes(32).toString("hex")); await handle.sync(); } finally { await handle.close(); }
  } catch (error) { if (nativeCode(error) !== "EEXIST") throw error; }
  try { await privateFile(path); }
  catch (error) { if (!create && nativeCode(error) === "ENOENT") return undefined; throw error; }
  // The same opened private file supplies the size/type proof and bounded bytes.
  // A replaced path or growing file cannot turn this read into an unbounded readFile.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new BridgeError("SERVICE_PATH_UNSAFE", "The opened operator credential is not a private user-owned regular file");
    }
    if (info.size !== 64) throw new BridgeError("CONTROL_CREDENTIAL_INVALID", "Private operator credential has an invalid size");
    const bytes = Buffer.alloc(65);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const token = bytes.subarray(0, length).toString("utf8");
    if (length !== 64 || !/^[a-f0-9]{64}$/.test(token)) throw new BridgeError("CONTROL_CREDENTIAL_INVALID", "Private operator credential is invalid or changed during reading");
    return token;
  } finally { await handle.close(); }
}
