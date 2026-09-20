import type { AgentCatalog, AgentProfile, Assignment, ExecutionPolicy, ExecutionSnapshot } from "../contracts/agents.js";
import { canonicalHash } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import type { AdapterDefinition, ConfiguredAdapter, WorkerAdapter } from "./types.js";

type Entry = { description: AgentCatalog["agents"][number]; adapter?: ConfiguredAdapter };
export type SelectedAgent = { worker: WorkerAdapter; snapshot: ExecutionSnapshot };
/** An immutable local resolver. Factories decode configuration only; they never start/probe a runtime. */
export class AgentRegistry {
  readonly #entries = new Map<string, Entry>();
  constructor(profile: AgentProfile, definitions: Readonly<Record<string, AdapterDefinition>>) {
    for (const registration of profile.agents) {
      const description: Entry["description"] = { agent_id: registration.agent_id, adapter_id: registration.adapter_id,
        description: registration.description, modes: [], state: "configured", runtime_readiness: "not_checked" };
      const entry: Entry = { description };
      this.#entries.set(registration.agent_id, entry);
      if (!registration.enabled) { description.state = "disabled"; continue; }
      const definition = Object.hasOwn(definitions, registration.adapter_id) ? definitions[registration.adapter_id] : undefined;
      if (!definition) { description.state = "unsupported"; description.limitation = "No installed adapter defines this runtime."; continue; }
      if (registration.agent_id === "muse" && registration.adapter_id !== "muse") {
        description.state = "invalid"; description.limitation = "The muse ID is reserved for the legacy Muse entrypoints."; continue;
      }
      try {
        const configured = definition.configure(registration.options);
        const modes = registration.modes ?? [...configured.modes];
        if (modes.some((mode) => !configured.modes.includes(mode))) throw new BridgeError("AGENT_MODE_UNSUPPORTED", "Registration requests a mode the adapter cannot enforce");
        entry.adapter = { ...configured, configuration: Object.freeze(structuredClone(configured.configuration)) };
        description.modes = [...modes];
      } catch (error) {
        description.state = error instanceof BridgeError && error.code === "AGENT_UNAVAILABLE" ? "unavailable"
          : error instanceof BridgeError && error.code === "AGENT_MODE_UNSUPPORTED" ? "unsupported" : "invalid";
        // Configuration can contain credentials. Never project decoder/native input into discovery.
        description.limitation = error instanceof BridgeError ? error.code : "Adapter configuration is invalid.";
      }
    }
  }
  catalog(fixed: boolean, offset = 0, limit = 4): AgentCatalog {
    if (!Number.isInteger(offset) || offset < 0 || offset > 32 || !Number.isInteger(limit) || limit < 1 || limit > 4) throw new BridgeError("INVALID_RANGE", "Agent discovery requires offset 0..32 and limit 1..4");
    const all = [...this.#entries.values()];
    if (offset > all.length) throw new BridgeError("INVALID_RANGE", "Agent offset is beyond the observed catalog");
    return structuredClone({ schema_version: 1, checked_at: new Date().toISOString(),
      configuration: fixed ? "fixed_for_runtime" : "observed", total: all.length, offset, next_offset: offset + limit < all.length ? offset + limit : null, agents: all.slice(offset, offset + limit).map((e) => e.description) });
  }
  select(request: Assignment, policy: ExecutionPolicy): SelectedAgent {
    const entry = this.#entries.get(request.agent_id);
    if (!entry) throw new BridgeError("AGENT_NOT_FOUND", "The selected agent is not registered");
    if (!entry.adapter || entry.description.state !== "configured") throw new BridgeError(`AGENT_${entry.description.state.toUpperCase()}`, entry.description.limitation ?? "The selected agent cannot execute");
    if (!entry.description.modes.includes(request.mode)) throw new BridgeError("AGENT_MODE_UNSUPPORTED", "The selected agent does not provide this assignment mode");
    const adapter = entry.adapter;
    const configuration = structuredClone(adapter.configuration);
    const snapshot: ExecutionSnapshot = { schema_version: 1, agent_id: request.agent_id,
      adapter_id: entry.description.adapter_id, adapter_contract: adapter.contract,
      configuration, configuration_fingerprint: canonicalHash(configuration), policy: structuredClone(policy),
      ...(adapter.requested_model ? { requested_model: adapter.requested_model } : {}) };
    Object.freeze(snapshot.configuration); Object.freeze(snapshot.policy.implementation); Object.freeze(snapshot.policy); Object.freeze(snapshot);
    return { worker: adapter.worker, snapshot };
  }
}
