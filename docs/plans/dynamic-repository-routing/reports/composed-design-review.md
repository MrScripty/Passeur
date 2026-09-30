# Composed-design review — dynamic repository routing

**Applicability:** applicable. The change moves repository selection across the Codex registration/process seam and changes default profile identity. Review baseline: Passeur `46f5e8651240eb84e752940885073f6f338b9145`; Coding-Standards `39d55dc330d44ecf940364ceada9d2527f7c7ea0`.

## Artifact probe

1. **Independent concerns and dimensions.** Codex registration owns persisted host launch/catalog policy; the frontend launch owns one process invocation; workspace Git owns canonical project/repository/main-worktree facts; repository binding owns profile/state selection from those facts; service election/runtime own one repository's lifecycle and authority. They change for different reasons and remain separate.
2. **State/identity/value/time/policy/mechanism interleaving.** Registration contains stable runtime/state policy but no repository identity in dynamic mode. Repository identity is resolved at frontend process use-time from its inherited cwd. Durable repository state remains keyed only after canonical resolution. Profile identity follows repository identity. No caller-supplied repository value is cached globally.
3. **Knowledge at callers/composition.** Codex needs only one registration plus its ordinary session cwd. `src/cli.ts` knows whether binding is dynamic or explicitly pinned. `resolveRepositoryBinding` knows Git/common-dir/profile/state representation. `RepositoryRuntime`, scheduler, workers and MCP tool handlers learn no new routing rule.
4. **Representative changes/locality.**
   - Codex changes how an unset stdio cwd is represented: registration inspection/probe owner changes; repository runtime does not.
   - Repository/main-worktree identity changes: workspace Git and repository-binding tests change; registration shape does not need Git semantics.
   - Profile migration changes: repository binding/profile tests change; task scheduler/IPC do not.
   - Lease/service mechanics change: existing service/runtime owners change; global registration remains a caller.
   The implemented propagation matches these owners.
5. **Stable interfaces versus hidden knowledge.** The seam carries existing `LaunchIntent`/resolved binding values and Codex's documented stdio configuration representation. Git common-dir paths, service socket names, lock paths and profile fallback mechanics stay hidden behind repository binding/service owners.
6. **Independent evolution/failure/replacement.** Dynamic registration can fail inspection before repository preparation. Repository binding can reject project/profile/state facts without changing Codex config. Repository services for unrelated repos fail/upgrade independently. Explicit pinned registration remains a replacement path when a host cannot supply dynamic cwd context.
7. **Deletion result.** No new permanent module, service, registry, adapter, validator, generator or version was introduced. Deleting dynamic-registration support removes only the optional registration shape/CLI path and returns to explicit pinned registrations; repository runtime/lease complexity remains because it is inherent to Passeur.
8. **Necessary complexity and cumulative machinery.** Necessary new complexity is limited to distinguishing dynamic versus pinned registration, repository-stable profile fallback, and state-root collision semantics. It is contained in existing registration/binding owners. No duplicate scheduler, daemon, state authority, runtime registry, routing table or tool parameter is retained.

## Result

The composition preserves one deep repository binding/runtime owner and moves only the point at which its input is selected. The source review found no reason to add another routing service or registry. Final acceptance still depends on the executable claims in the plan; this review does not substitute for them.
