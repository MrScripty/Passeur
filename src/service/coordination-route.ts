import { decodeCoordinationReply, decodeCoordinationRequest, type CoordinationReply } from "../contracts/coordination-service.js";
import type { AuthenticatedPeer } from "./peer-auth.js";

/** The runtime owns execution/authorization; the authenticated peer supplies identity out-of-band. */
export interface CoordinationRuntime {
  coordinate(raw: unknown, actor: { owner_id: string; client_id: string }, source: string, signal?: AbortSignal): Promise<CoordinationReply>;
}
export async function routeCoordination(runtime: CoordinationRuntime, peer: AuthenticatedPeer,
  repositoryId: string, raw: unknown, signal?: AbortSignal): Promise<CoordinationReply> {
  const request = decodeCoordinationRequest(raw);
  const value = await runtime.coordinate(request, peer.actor, peer.source_view, signal);
  return decodeCoordinationReply(request, peer.actor.owner_id, repositoryId, value);
}
