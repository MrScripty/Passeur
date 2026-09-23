import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import { canonicalProject, repositoryIdentity } from "../workspace/project.js";
import { decodeFrame } from "./transport.js";

export type PeerBinding = Readonly<{ repositoryId: string; stateRoot: string; profilePath?: string }>;
export type AuthenticatedPeer = Readonly<{
  actor: Readonly<{ owner_id: string; client_id: string }>;
  source_view: string;
}>;

/** Connection owner handles duplicate/in-flight/closed handshakes; this function proves their binding. */
export async function authenticateServicePeer(raw: unknown, binding: PeerBinding, serviceToken: string): Promise<AuthenticatedPeer> {
  const hello = decodeFrame(raw);
  if (hello.kind !== "hello") throw new BridgeError("SERVICE_HANDSHAKE_INVALID", "Expected the supported service handshake");
  if (!/^[a-f0-9]{64}$/.test(serviceToken)) throw new BridgeError("SERVICE_HANDSHAKE_INVALID", "The service credential is unavailable");
  const expected = { ...binding };
  if (!timingSafeEqual(Buffer.from(hello.token, "hex"), Buffer.from(serviceToken, "hex"))
      || hello.repository_id !== expected.repositoryId || hello.state_root !== expected.stateRoot
      || hello.profile_path !== expected.profilePath) {
    throw new BridgeError("SERVICE_BINDING_CONFLICT", "Service credentials or approved binding do not match");
  }
  const source_view = await canonicalProject(hello.source_view);
  if ((await repositoryIdentity(source_view)).id !== expected.repositoryId) {
    throw new BridgeError("SOURCE_VIEW_CONFLICT", "The client source view is not a member of the bound repository");
  }
  return Object.freeze({ source_view, actor: Object.freeze({
    client_id: randomUUID(), owner_id: createHash("sha256").update(hello.owner_token).digest("hex"),
  }) });
}
