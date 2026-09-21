---
name: muse-bridge
description: Migration route for existing Passeur Muse bridge users. Use the durable-task skill for shared service setup, submit/wait/input/cancel and resource accounting.
---

# Muse bridge migration

Follow [the current usage skill](../passeur-bridge/SKILL.md). Legacy delegation tools remain discoverable but reject new execution with TASK_API_UPGRADE_REQUIRED. They do not return a task receipt as an old terminal result. Historical evidence readers remain available. Preserve named server/profile/state binding while following [setup](references/setup.md). Native Muse client identifier muse_bridge is not an MCP server name or task owner.
