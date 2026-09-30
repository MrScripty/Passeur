# Composed-design review

**Reviewer:** GPT-6.1 Sol High, read-only architecture and lifecycle review.

**Disposition:** qualified admission, subject to the implementation binding decisions below. The design keeps the current frontend → repository binding → repository service structure and does not introduce a global repository router, global lock, second election primitive, second scheduler, or profile registry.

The reviewer assigns distinct ownership to frontend candidate selection, repository binding, and the running service generation’s execution configuration. Repository ID, state namespace, authenticated source view, service generation and supported service contract remain attachment identity. A profile path is provenance. The service’s versioned effective fingerprint identifies its frozen decoded profile snapshot. Catalog and task execution share the snapshot. Snapshot loading is configuration-only, does not acquire a lease or run inference, and is retryable if loading fails before admission.

Unpinned clients join a valid live service without reading their prospective profile. Explicitly pinned clients compare effective fingerprints. Same content at different paths joins; changed content at the same path does not; materially different explicit configuration needs controlled handover. A legacy service without snapshot identity cannot be “verified” from its mutable source file. `agents()` uses a live service’s catalog or, only after observing absence, the offline candidate; it does not start execution or mask an incompatible live service.

Registration migration belongs inside the Codex config writer transaction and must finish durable profile publication before the unpinned TOML entry is published. One unique effective v3 profile group can populate a missing default; multiple groups refuse rather than choosing one repository arbitrarily. Older lifecycle semantics remain explicitly migration-gated. Originals, repository overrides, running services, active tasks and resources remain untouched.

Five conditions are binding for implementation and review:

1. Publish a profile fingerprint only for the exact immutable runtime snapshot; do not separately hash at launch and reload for execution.
2. Enforce explicit profile expectations before admitting operations while keeping the task-control credential independent.
3. Qualify any cross-build/legacy handshake against the actual supported prior service implementation. New contract compatibility is separate from build identity; unknown builds remain conflicts.
4. Make `agents()` connection mode race-safe with concurrent prepare; a live but incompatible or unreachable service must not be represented by an offline catalog.
5. Preserve config-writer authority, candidate revalidation, create-only profile durability and TOML rollback semantics; never remove or silently rewrite profiles/services/tasks during migration.

The actual old-build test, migration races, active-task process exit, two-repository host test, and independent final review remain acceptance requirements and are not implied by this admission.
