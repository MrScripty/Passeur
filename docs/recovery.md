# Recovery

Task records live under the XDG state directory, keyed by a hash of the canonical project path. The bridge writes `request.json`, `state.json`, `result.json`, bounded `events.ndjson`, and artifacts with owner-only permissions.

Inspect local state without launching Muse:

```sh
muse-bridge inspect --project /absolute/project --profile /absolute/profile.json
muse-bridge result --project /absolute/project --profile /absolute/profile.json --task TASK_UUID
muse-bridge logs --project /absolute/project --profile /absolute/profile.json --task TASK_UUID
```

An incomplete record after restart is evidence of an interrupted task. The bridge will not replay it under the same request key. Inspect Muse processes and the retained workspace, reconcile any external effects, then use a new request key for an intentional retry.

`worker_stop: unconfirmed` means host shutdown could not be proven. Do not assume commands stopped. The bridge blocks further delegation while such a record exists. Reconcile the owned process tree and workspace, then explicitly clean up that task record to acknowledge the reconciliation.

Cleanup requires an explicit `--yes` and removes task records only. Retained implementation worktrees are preserved so changes cannot disappear as a side effect of reading or cleaning a result. Remove a worktree through the ordinary Git workflow after integration or deliberate discard.
