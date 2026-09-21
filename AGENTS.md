# Repository instructions

For development, apply MrScripty/Coding-Standards: read CORE-STANDARDS.md, then STANDARDS-ROUTER.md and applicable canonical modules. The governing plan records its adopted revision, scope and evidence; source implementation and passing partial checks do not imply acceptance.

Written-plan work requires an explicit repository-relative plan.md and operation (`start`, `continue` or `verify`). Preserve unrelated changes and ordinary hooks. This file grants no authority to install dependencies, change personal configuration, authenticate, use live accounts, publish or rewrite shared history.

For task delegation, startup diagnosis, setup, retained evidence and resource accounting, follow [the Passeur usage skill](.agents/skills/passeur-bridge/SKILL.md). Existing Muse skill entrypoints remain compatibility routes.

For registration-only changes or implementing/qualifying a new runtime adapter, follow [the adapter-authoring skill](.agents/skills/passeur-agent-adapter/SKILL.md). Preserve RepositoryRuntime's lazy preparation/lease lifecycle and the shared coordinator. New native dependencies must not become prerequisites for MCP discovery or retained-result access.

The current lifecycle authority is [the shared-service plan](docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md). The plan and invocation name the current operation; a next slice is not execution authority. Accepted tasks are service-owned; waits and human presentations cannot cancel them. Native evidence, protected input and historical versions remain with their canonical owners. See docs/task-lifecycle.md and docs/shared-service.md.
