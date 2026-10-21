# Passeur

Give coding agents durable tasks that survive a disconnected session.

Passeur is a local delegation service for Codex and Muse workers. Sessions in the same repository share a coordinator, bounded queue and task history; implementation work runs in protected Git worktrees. One unpinned Codex registration follows each new session's repository, so opening another project needs no registration change.

Accepted work stays alive until it finishes, fails or is explicitly cancelled. Disconnecting a client does not cancel its tasks.

## Build from source

Use Node.js 20 or later and the complete repository with its pinned lockfile. Authorize dependency provisioning and its install scripts before running `npm ci`:

```sh
git clone https://github.com/MrScripty/Passeur.git
cd Passeur
npm ci
npm run check
npm test
npm run build:runtime
```

Dependency installation includes native components and install scripts. Runtime builds require clean Git inputs and already provisioned dependencies; they do not install packages.

The build produces an identified runtime candidate. Follow [installation and setup](docs/startup-and-installation.md#build-and-install-a-runtime) to install that exact candidate, configure agents once and register `passeur` with Codex. Start a fresh Codex session after registration.

**Current status:** the [structural-coordination completion plan](docs/plans/structural-coordination-completion/plan.md) records acceptance of its exact source and installed build; the [claim ledger](docs/plans/structural-coordination-completion/reports/claim-status.md) owns the evidence and limits. The supported service environment is Linux on local filesystems with a matching native bundle. Complete [installed acceptance](docs/installed-acceptance.md) before relying on a new installation; see [compatibility](docs/compatibility.md) for environment constraints.

## The task loop

1. Check `passeur_status` and `passeur_agents`; use `passeur_prepare` to prepare the repository without inference.
2. Submit with `passeur_submit` or `passeur_submit_batch` and keep the durable receipt.
3. Observe with `passeur_tasks` and `passeur_wait`.
4. Answer an exact pending permission or clarification with `passeur_input`, or explicitly stop work with `passeur_cancel`.
5. Retrieve evidence with `passeur_result`, then account for retained or externally integrated work with `passeur_finalize`.

The caller chooses the task, worker, base and acceptance criteria. Passeur does not decide whether output is correct or automatically merge it.

## Read more

- [Task lifecycle](docs/task-lifecycle.md) and [shared service](docs/shared-service.md)
- [Coordination](docs/coordination.md) and [structural reports](docs/structural-reporting.md)
- [Registered agents](docs/registered-agents.md) and [adapter contract](docs/agent-adapters.md)
- [Recovery](docs/recovery.md)
- [Usage skill](.agents/skills/passeur-bridge/SKILL.md)

[MIT License](LICENSE).
