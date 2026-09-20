import { MuseClient } from "@muse-code/sdk";

if (process.env.MUSE_BRIDGE_LIVE !== "1") throw new Error("Set MUSE_BRIDGE_LIVE=1 only in a disposable workspace after confirming subscription billing");
const workspace = process.argv[2]; const model = process.argv[3] ?? "muse-spark-1.3";
if (!workspace) throw new Error("Usage: npm run probe:muse -- /absolute/disposable/project [model]");
const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const client = await MuseClient.spawn({ museBin: "muse", args: ["serve", "--disable-write", "--disable-shell", "--sandbox-network", "restricted"], env, clientInfo: { name: "muse_bridge_probe", version: "0.1.0" }, onStderr: (chunk) => process.stderr.write(chunk) });
try {
  const session = await client.startSession({ workspaceRoot: workspace, modelId: model, approvalMode: "denyUnmatched" });
  const turn = await session.sendUserTurn({ input: [{ type: "text", text: "Report the repository root name. Do not use tools and do not modify anything." }] });
  for await (const item of turn.items()) if (item.kind === "agentMessage" && item.text) process.stdout.write(`${item.text}\n`);
  console.log(JSON.stringify({ requested_model: model, reported_model: session.opening?.result.session.modelId, outcome: await turn.completed }, null, 2));
} finally { await client.close(); }
