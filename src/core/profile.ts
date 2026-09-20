import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProfileSchema, type Profile } from "../contracts/index.js";
import { BridgeError, filesystemFailure } from "./errors.js";

export async function loadProfile(path: string, requireVerified = true): Promise<Profile> {
  const absolute = resolve(path);
  let contents: string;
  try { contents = await readFile(absolute, "utf8"); }
  catch (error) { throw filesystemFailure(error, "profile.read", absolute); }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (cause) { throw new BridgeError("PROFILE_INVALID", "Profile contains malformed JSON", { cause, stage: "profile.decode", path: absolute }); }
  if (typeof value === "object" && value !== null && "schema_version" in value
    && typeof value.schema_version === "number" && Number.isInteger(value.schema_version) && value.schema_version !== 1) {
    throw new BridgeError("PROFILE_VERSION_UNSUPPORTED", "Profile version is not supported by this runtime", { stage: "profile.decode", path: absolute });
  }
  const parsed = ProfileSchema.safeParse(value);
  if (!parsed.success) throw new BridgeError("PROFILE_INVALID", `Profile validation failed at ${parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "profile").join(", ")}`, { stage: "profile.decode", path: absolute });
  const profile = parsed.data;
  if (requireVerified && profile.subscription.provenance === "unverified") throw new BridgeError("SUBSCRIPTION_UNVERIFIED", "Confirm the credential billing path before delegation", {
    stage: "profile.subscription", path: absolute, next_action: "Verify the intended account and deliberately update the profile; diagnosis and offline recovery do not require inference credentials.",
  });
  return profile;
}
