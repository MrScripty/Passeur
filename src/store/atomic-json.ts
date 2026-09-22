import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type MutationAuthority = () => void;

/** Shared fsync/rename publication. Caller owns validation, ordering and recovery. */
export async function atomicJson(path: string, value: unknown, authority?: MutationAuthority): Promise<void> {
  authority?.();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  authority?.();
  const handle = await open(temporary, "wx", 0o600);
  try { authority?.(); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  authority?.();
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
