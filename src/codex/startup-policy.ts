import { BridgeError } from "../core/errors.js";

/** A missing inspection field is absent evidence, not an effective false value. */
export type StartupPolicyObservation =
  | { status: "not_reported" }
  | { status: "matched"; required: boolean };

export type StartupPolicyEvidence = {
  required: boolean;
  configuration: "passed";
  inspection: StartupPolicyObservation | { status: "not_run" };
  host_attachment: "not_run";
};

/** Omission preserves the selected server's policy; new registrations remain optional. */
export function startupRequirementFromFlags(required: boolean | undefined, optional: boolean | undefined): boolean | undefined {
  if (required && optional) throw new BridgeError("ARGUMENT_INVALID", "Choose --required or --optional, not both");
  return required ? true : optional ? false : undefined;
}

export function resolveStartupRequirement(requested: boolean | undefined, previous: unknown): boolean {
  if (requested !== undefined && typeof requested !== "boolean") {
    throw new BridgeError("REGISTRATION_INVALID", "required must be a boolean when specified");
  }
  if (previous !== undefined && typeof previous !== "boolean") {
    throw new BridgeError("CODEX_CONFIG_INVALID", "The selected server's existing required setting must be a boolean");
  }
  return requested ?? previous ?? false;
}

/** Some Codex versions omit this field from `mcp get --json`; do not fabricate proof. */
export function inspectStartupRequirement(actual: unknown, expected: boolean | undefined): StartupPolicyObservation {
  if (actual === undefined) return { status: "not_reported" };
  if (typeof actual !== "boolean") {
    throw new BridgeError("CODEX_INSPECTION_UNSUPPORTED", "Codex inspection returned a non-boolean required setting");
  }
  if (actual !== (expected ?? false)) {
    throw new BridgeError("CODEX_REGISTRATION_MISMATCH", "Codex resolves a different required/optional startup policy");
  }
  return { status: "matched", required: actual };
}
