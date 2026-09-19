import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProfileSchema, type Profile } from "../contracts/index.js";

export async function loadProfile(path: string): Promise<Profile> {
  const profile = ProfileSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
  if (profile.subscription.provenance === "unverified") throw new Error("Subscription provenance is unverified; run configure and confirm the credential's billing path before delegation");
  return profile;
}
