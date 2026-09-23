# Registered agents and lifecycle migration

An adapter operates a native runnable coding agent; a registration names an approved adapter configuration; a task is one durable execution of that configuration. Several registrations may use Muse. Codex remains Linux implementation-only and explicitly opted in. There is no provider fallback, model router, new reasoning loop or dynamic plugin loader.

The shared-service candidate requires profile schema 3. `migrate-profile --project PATH --profile FILE --yes` explicitly reads old versions 1/2, preserves agent/permission options, removes the execution deadline, adds validated resource limits, saves original bytes and atomically publishes version 3. Reads never rewrite history. Stop/account for old connection-owned runtimes before cutover; a backup is not a downgrade guarantee for new task records. Coordinated submissions use task schema v5 and structural metadata schema v6; an older reader must refuse those records without changing their bytes. Use the [installation cutover](startup-and-installation.md) under the existing state namespace.

`configure-agent --agent-file FILE --yes` configures an installed adapter in an existing version-3 profile. Replacing an existing registration requires its exact reported fingerprint. Discover agents with `passeur_agents` or `agents`. Discovery does not run/authenticate a native runtime. Fixed service configuration requires controlled restart to change.

New tools use submit/wait/input/cancel rather than indefinite delegation. `submit-coordinated` additionally binds an exact announced or inline assignment to a durable task before native start. Old `passeur_delegate*`/`delegate_to_muse*` remain discoverable but reject new execution with `TASK_API_UPGRADE_REQUIRED`. They never return an accepted receipt masquerading as an old terminal result. Historical results remain readable in their actual source schema.

A controlled fixture profile can verify TaskStore publication, recovery and process boundaries. It is supplemental engineering evidence. The [installed acceptance run](installed-acceptance.md) uses existing named host registrations and live registered Muse/Codex accounts for the two-parent/three-worker workflow. Do not describe fixture providers as native permission, continuation, liveness or SC15 evidence. Agent discovery is lazy; missing parser artifacts must not block MCP discovery, historical results or task controls.

See [task lifecycle](task-lifecycle.md), [installation](startup-and-installation.md) and [qualification](compatibility.md).
