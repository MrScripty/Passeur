import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "../fixtures/bridge.js";
it("separates ordinary reads from lease-owned quarantine mutation", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  try {
    await mkdir(f.store.taskDir(id)); await expect(f.store.list()).rejects.toBeDefined();
    expect(await readdir(join(f.state, "tasks"))).toContain(id);
    expect(await f.store.quarantineIncomplete()).toHaveLength(1);
    expect(await f.store.list()).toEqual([]); expect(await f.store.frozenReason()).toBeDefined();
  } finally { await f.dispose(); }
});
