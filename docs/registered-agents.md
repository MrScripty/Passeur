# Configure and use registered agents

Use the existing [startup/install procedure](startup-and-installation.md) for an identifiable installed runtime and an explicitly named caller registration. Registering an agent inside Passeur does not create another MCP server or another repository coordinator.

## Public tools

| Tool | Contract |
| --- | --- |
| `passeur_status` | Existing status v1; observation, not repository authority or provider qualification. |
| `passeur_prepare` | Existing preparation v1; acquire/recover repository coordination without inference. |
| `passeur_agents` | Catalog v1; read pages with `offset` and `limit` (maximum four). No provider startup. |
| `passeur_delegate` | Assignment v3, including explicit `agent_id`; wait in the original call. |
| `passeur_delegate_batch` | Batch v3; one to eight independent assignments, each with its own `agent_id`. |
| `passeur_result` | Existing bounded result-read contract; no live agent prerequisite. |
| `passeur_finalize` | Existing disposition request v2; no integration or inference. |

`delegate_to_muse`, `delegate_to_muse_batch`, `muse_result` and `muse_finalize` remain bounded compatibility entrypoints. The old execution tools accept v2, select the fixed `muse` registration and project representable v2 responses. Neutral and legacy new work share the same coordinator and canonical v3 identity. Already-persisted v1/v2 request keys retain explicit historical handling rather than being reused as fresh work.

## Profile migration

Reads accept the existing profile v1 and project it into one Muse registration without writing. The existing Muse setup/configure shortcut now writes v2. For explicit migration, using the existing project/state binding:

```sh
./passeur migrate-profile /absolute/project --profile /absolute/profile.json --yes
```

Migration preserves exact original bytes in a unique backup, validates the candidate before atomic publication, and does not reload a running coordinator. Configuration editors must remain quiescent during the short operator edit. Do not run old binaries against a store containing v3 tasks; retaining a profile backup does not make the whole task store downgrade-compatible.

A profile v2 contains independently owned execution policy and named registrations. New installations may use the Muse setup shortcut and then configure additional registrations; non-Muse-only installations may explicitly author a validated v2 profile with an `execution` policy and empty `agents` array before adding agents. Passeur does not silently create a missing profile or guess policy during a read.

## Add or inspect an agent

Put one registration in an operator-selected JSON file. For example, to reuse the existing Muse adapter, copy the migrated Muse registration, choose a different `agent_id` and an exact installed model ID, and retain its approved permission/credential settings. No adapter source change is needed.

```sh
./passeur configure-agent /absolute/project --profile /absolute/profile.json \
  --agent-file /absolute/new-agent.json --yes
./passeur agents /absolute/project --profile /absolute/profile.json --offset 0 --limit 4
```

Changing an existing registration requires the exact current fingerprint reported by the refused first attempt, supplied as `--replace-agent FINGERPRINT`. A replacement cannot silently overwrite changed operator intent. Restart the existing installed server through the controlled host lifecycle; starting a second server does not transfer its repository lease.

The catalog reports configuration, not login, supported installed version, billing, or process-tree qualification. Disabled and unavailable entries remain visible for diagnosis. Task input can select an approved agent ID but cannot supply an executable, runtime options or credentials.

## Delegate and account for results

Use v3 and `agent_id` on each neutral assignment. Implementation requires the exact full base commit and full local target ref. Workers read repository instructions, check their scoped outcome and create ordinary commits. The caller decides broader testing, integration and acceptance. Passeur identifies Git delivery independently of the worker's report.

Same-key retries return the originally admitted execution. To run the objective under changed configuration, use a new key. A removed agent never prevents retained-result reads. Integration happens outside Passeur; afterwards retain, acknowledge integrated ancestry, or explicitly archive using the existing disposition contract.

## Verification status

This is a source candidate, not an accepted multi-agent release. Consult [the implementation evidence](plans/registered-agents/reports/implementation-evidence.md) for executed versus blocked checks. Opt-in installed-runtime system probes use `PASSEUR_LIVE_AGENTS=1` and `scripts/probe-agents.ts`; they require an explicit disposable repository, named agents, exact installed CLI and state/profile paths. They decline all human approvals and do not merge or clean resources. Actual host attachment, human decisions and native guarantees require separate operator qualification.
