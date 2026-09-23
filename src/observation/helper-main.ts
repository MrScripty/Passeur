import { diagnosticInfo } from "../core/errors.js";
import { extractNativeFunctions } from "./native-extraction.js";
import { decodeHelperRequest, HELPER_PROTOCOL_VERSION, MAX_HELPER_REPLY_BYTES } from "./helper-protocol.js";

let admitted = false;
function send(reply: Record<string, unknown>): void {
  const frame = `${JSON.stringify(reply)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_REPLY_BYTES) throw new Error("analysis reply exceeds framed output limit");
  process.stdout.write(frame, () => process.disconnect());
}
process.on("message", (raw: unknown) => {
  if (admitted) { process.exitCode = 1; process.disconnect(); return; }
  admitted = true;
  void (async () => {
    const candidateId = raw && typeof raw === "object" && "job_id" in raw ? raw.job_id : undefined;
    let jobId = typeof candidateId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(candidateId)
      ? candidateId : "invalid";
    try {
      const request = decodeHelperRequest(raw);
      jobId = request.job_id;
      const extraction = await extractNativeFunctions(request.file, request.dialect);
      send({ version: HELPER_PROTOCOL_VERSION, kind: "result", job_id: jobId, extraction });
    } catch (error) {
      const code = diagnosticInfo(error).code;
      send({ version: HELPER_PROTOCOL_VERSION, kind: "failure", job_id: jobId, code });
    }
  })();
});
process.on("disconnect", () => { process.exitCode = 0; });
