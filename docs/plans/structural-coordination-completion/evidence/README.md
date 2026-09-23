# Final candidate evidence index

The verified product source is `3c07dc364efecf9d7ffb314eb90a2336223a9694`; its separately installed build is `4902ce2fa9bcdbdc2030792fa939fc41742bdf69cca16fd4b46be77833ae22a2` (`source_dirty:false`). The later documentation commit does not change the installed runtime. The [execution ledger](../execution-ledger.md), [claim status](../reports/claim-status.md) and [SC16 report](../reports/resource-behavior.md) explain the results and limits. Retained log copies differ from their `/tmp` originals only by removing a trailing blank line.

| Evidence | Retained file | Result |
|---|---|---|
| First full gate, including failure | [full-first-run-3c07dc3.log](full-first-run-3c07dc3.log) | 573 core and 184 native passed; public had one guarded-service startup failure, 143 passes. Cause unproven. |
| Affected-file rerun | [cli-rerun-3c07dc3.log](cli-rerun-3c07dc3.log) | 2/2 passed. |
| Full public rerun | [public-rerun-3c07dc3.log](public-rerun-3c07dc3.log) | 144 passed, six installed cases gated for separate qualification. |
| Installed tests | [structural/doctor](installed-structural-3c07dc3.log), [startup/registration](installed-startup-3c07dc3.log) | 9/9 and 6/6 passed. |
| Actual installed probe | [installed-probe-3c07dc3.json](installed-probe-3c07dc3.json), [traced repeat](installed-probe-traced-3c07dc3.json) | 30 routes, 106 public reports, 13 canonical plus 21 variant native oracles; source and host PID roots hidden, network separated, eleven forbidden absolute executable attempts denied. |
| Resource runs | [run 1](resource-3c07dc3.json), [run 2](resource-3c07dc3-repeat.json) | Exact installed monitor-off/enabled CPU, RSS, latency, overload and parent-context measurements. No coding worker launched by the benchmark. |
| Active-task control snapshot | [live-control-4ab24e0.json](live-control-4ab24e0.json) | Two real native workers remained observed live, awaiting input, under unchanged owners while structural controls ran on byte-identical executable JavaScript. No input/cancel/recovery performed. |

The full external `strace -f -e execve,execveat` output is retained locally at `/tmp/passeur-structural-exec-3c07dc3.trace` (10,057,856 bytes; SHA-256 `cb8a2393a2f25f459f1aa1983f4e6f32d0041a526e9e78a6ed092b36fad4f6ca`). The trace recorded 12,353 successful executable calls. The only successful installed child paths after namespace entry were `/node`, `/usr/bin/git` and `/usr/bin/flock`; host-side probe setup also executed npm/tsx, bwrap, library discovery and loaders. The raw trace is large and host-path-specific, so the retained traced probe JSON and digest accompany this index. This summary does not claim an absence of host setup commands.

SC10, SC12 and SC15–SC17 remain open for the protected live worker continuation, active-worker resource/lifecycle evidence, integration and resource disposition. The earlier one-command human approval applied to a different SC15 fixture and does not authorize the two current native permission prompts.
