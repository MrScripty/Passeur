import { ProfileSchema } from "../contracts/index.js";
import { BridgeError } from "../core/errors.js";
import type { AdapterDefinition } from "../agents/types.js";
export const MuseOptionsSchema = ProfileSchema.pick({ muse_bin: true, model: true, review: true, subscription: true })
  .extend({ muse_bin: ProfileSchema.shape.muse_bin.refine((value) => !value.includes("\0"), "NUL is not a path character"), implementation: ProfileSchema.shape.implementation.pick({ sandbox_network: true }) });
export type MuseOptions = import("zod").output<typeof MuseOptionsSchema>;
export const museDefinition: AdapterDefinition = {
  configure(input) {
    const options = MuseOptionsSchema.parse(input);
    if (options.subscription.provenance === "unverified") throw new BridgeError("AGENT_UNAVAILABLE", "Muse subscription provenance requires operator confirmation");
    return { contract: "muse-sdk/1.3", modes: ["review", "implement"], requested_model: options.model,
      configuration: { executable: options.muse_bin, model: options.model, review_network: options.review.sandbox_network,
        implementation_network: options.implementation.sandbox_network, credential_provenance: options.subscription.provenance },
      worker: { async run(run) {
        let create: typeof import("./adapter.js");
        try { create = await import("./adapter.js"); }
        catch { return { status: "blocked", worker_stop: "not_started", worker_assessment: "unknown", summary: "The installed adapter dependency could not be loaded",
          error: { code: "AGENT_RUNTIME_UNAVAILABLE", message: "Install the complete runtime dependency closure before retrying a new task" }, blockers: [], questions: [], checks: [] }; }
        return new create.MuseSdkAdapter(options).run(run);
      } },
    };
  },
};
