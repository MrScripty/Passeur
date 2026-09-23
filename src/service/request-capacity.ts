import { BridgeError } from "../core/errors.js";
import { coordinationRequestLane, decodeCoordinationRequest } from "../contracts/coordination-service.js";

export type RequestLane = "ordinary" | "control";
// Connection-level ceilings leave room below transport callback capacity for cancellation frames.
export const CONNECTION_ORDINARY_REQUESTS = 32;
export const CONNECTION_CONTROL_REQUESTS = 4;

/** Called after operation decoding. A control lane changes capacity, never permission. */
export function serviceRequestLane(operation: string, args: unknown): RequestLane {
  if (operation === "coordination") return coordinationRequestLane(decodeCoordinationRequest(args));
  return operation === "cancel" || operation === "input_claim" || operation === "input_answer"
    || operation === "input_dismiss" || operation === "attach" || operation === "stop"
    || operation === "withdraw_announcement" || operation === "announcement"
    || operation === "structural_notice_pull" || operation === "structural_notice_ack" ? "control" : "ordinary";
}

/** The existing pending-request map is the sole reservation owner. */
export function assertRequestCapacity(pending: Iterable<{ lane: RequestLane }>, lane: RequestLane): void {
  let count = 0;
  for (const item of pending) if (item.lane === lane) count++;
  const bound = lane === "ordinary" ? CONNECTION_ORDINARY_REQUESTS : CONNECTION_CONTROL_REQUESTS;
  if (count >= bound) throw new BridgeError("SERVICE_REQUEST_LIMIT", `The ${lane} connection request capacity is full; no request was admitted`);
}
