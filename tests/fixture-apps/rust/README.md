# L01 Rust quote fixture

Qualified locally with `rustc 1.92.0 (ded5c06cf 2025-12-08)` and `cargo 1.92.0 (344c4567c 2025-10-21)` on Linux. No external crates or network access are required.

From the repository root, create a fresh temporary directory outside this fixture and replace `<target-dir>` in these exact commands:

```
cargo test --offline --manifest-path tests/fixture-apps/rust/Cargo.toml --target-dir <target-dir>
cargo run --offline --quiet --manifest-path tests/fixture-apps/rust/Cargo.toml --target-dir <target-dir> -- 1250 3 1000
```

The sample emits `subtotal_cents=3750`, `discount_cents=375`, and `total_cents=3375` on separate lines. CLI arguments are `unit_cents quantity discount_bps`; each is an unsigned decimal integer. Maximums are 1,000,000 cents, 1,000 units, and 10,000 basis points. Discount uses integer floor division. Invalid input writes an error to stderr and exits 2. The public `calculate_quote` function applies the same limits to direct callers and returns `Result<Quote, &'static str>`; out-of-range inputs return `Err("integer out of range")`. It uses checked arithmetic and returns an error if an intermediate computation cannot be represented. Tests cover normal, zero quantity, invalid, maximum valid input, and direct-call rejection of unsafe values. Build products belong in `<target-dir>`, never in the pristine fixture.
