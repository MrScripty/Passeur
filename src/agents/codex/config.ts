import { z } from "zod";
import { isAbsolute } from "node:path";
import { BridgeError } from "../../core/errors.js";
import type { AdapterDefinition } from "../types.js";
export const CodexOptionsSchema = z.object({
  codex_bin: z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "NUL is not a path character"), codex_home: z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "NUL is not a path character").refine(isAbsolute, "codex_home must be absolute"),
  model: z.string().min(1).max(256), network_access: z.boolean().default(false),
  allow_command_escalation: z.boolean().default(false),
  subscription_confirmed: z.literal(true), experimental_opt_in: z.literal(true),
}).strict();
export type CodexOptions = z.output<typeof CodexOptionsSchema>;
export const codexDefinition: AdapterDefinition = {
  configure(raw) {
    const options = CodexOptionsSchema.parse(raw);
    if (process.platform !== "linux") throw new BridgeError("AGENT_UNAVAILABLE", "Codex process supervision is implemented for Linux");
    return { contract: "codex-app-server-v2-projection/1", modes: ["implement"], requested_model: options.model,
      configuration: { executable: options.codex_bin, codex_home: options.codex_home, model: options.model,
        network_access: options.network_access, allow_command_escalation: options.allow_command_escalation, authentication: "chatgpt", experimental_opt_in: true },
      worker: { async run(input) {
        let create: typeof import("./adapter.js");
        try { create = await import("./adapter.js"); }
        catch { return { status: "blocked", worker_stop: "not_started", worker_assessment: "unknown", summary: "The installed adapter dependency could not be loaded",
          error: { code: "AGENT_RUNTIME_UNAVAILABLE", message: "Install the complete runtime dependency closure before retrying a new task" }, blockers: [], questions: [], checks: [] }; }
        return new create.CodexAdapter(options).run(input);
      } },
    };
  },
};
