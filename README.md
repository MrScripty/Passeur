# Passeur

A local coding-agent delegation service. Several Codex sessions can attach to one repository coordinator; registered Muse/Codex workers share its bounded queue, task store and protected Git worktrees.

Accepted tasks outlive client connections and individual tool calls. There is no execution, queue, approval or inactivity timeout that kills an assignment. Explicit task cancellation, native terminal evidence and real failures govern lifetime. The service distinguishes waiting for input/known tools from completed work and unknown runtime state.

**This source candidate is not yet production-accepted.** Full pinned checks, installed multi-client flows, actual native permissions/continuation/descendants, independent review and fresh-session skill evidence remain outstanding. See [compatibility](docs/compatibility.md).

## Build and migrate

Use the complete repository and unchanged pinned dependencies:

```sh
npm ci
npm run check
npm test
npm run build:runtime
```

Follow [installation and cutover](docs/startup-and-installation.md). Profile3 migration is explicit and backed up. Existing named server/state bindings remain. Old delegation tools reject new execution; use the new task API instead. No live configuration, account or task mutation is implied by reading this repository.

## Task workflow

`passeur_status` and `passeur_agents` diagnose. `passeur_prepare` attaches/prepares without inference. `passeur_submit`/`passeur_submit_batch` return durable receipts. `passeur_tasks`/`passeur_wait` observe. `passeur_input` handles the exact pending human permission or clarification; `passeur_cancel` explicitly stops a task; `passeur_attach` human-confirms recovery of control. `passeur_result` retrieves retained evidence; `passeur_finalize` accounts for externally integrated, retained or archived work.

The caller chooses tasks, agent, bases, integration and acceptance. Workers read applicable instructions, run scoped checks and commit ordinarily. Passeur does not select tests, repair, merge, create PRs or certify output correctness.

Read [shared service](docs/shared-service.md), [task lifecycle](docs/task-lifecycle.md), [agent registrations](docs/registered-agents.md), [adapter contract](docs/agent-adapters.md), [usage skill](.agents/skills/passeur-bridge/SKILL.md), and [authoring skill](.agents/skills/passeur-agent-adapter/SKILL.md).
