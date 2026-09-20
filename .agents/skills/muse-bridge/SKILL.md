---
name: muse-bridge
description: Compatibility route for existing Passeur Muse delegation and setup users. Follow the passeur-bridge skill for current neutral tools, migration, diagnosis and resource accounting.
---

# Muse bridge compatibility

Read [the current Passeur usage skill](../passeur-bridge/SKILL.md). The existing v2 tools `delegate_to_muse`, `delegate_to_muse_batch`, `muse_result` and `muse_finalize` remain supported entrypoints for agent `muse`. They share the neutral execution path, task store and resource owner.

Use [setup](references/setup.md) for the installed-runtime migration route. For a new agent runtime implementation, use [the adapter-authoring skill](../passeur-agent-adapter/SKILL.md), not this compatibility entrypoint.
