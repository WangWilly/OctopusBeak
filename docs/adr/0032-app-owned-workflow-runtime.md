# App-owned workflow runtime

Status: accepted

The desktop App is the sole production entry point for automation. An App-owned executor runs typed workflow definitions in supervised workers and injects browser access, text decoding and integrity checks, human assistance, stage events, cancellation, and the existing Canonical Financial Commit through explicit ports. Workflows do not launch their own production commands, open the financial database, or choose a persistence transport. This keeps provider-specific page collection separate from run lifecycle and financial admission while allowing a browser failure to be isolated from the App.

Production source exports are consumed in memory and validated as a complete source before financial commit. No production workflow retains downloaded source files, generated CSV/JSON, raw network bodies, stdout logs, or Libretto session telemetry files. Bounded, sanitized stage events live in the operational database for 30 days; run outcome summaries and error codes remain available longer. Browser authentication state is the only permitted workflow file state, and an App-owned scheduled cleanup removes it after 30 days by default. The App does not execute schedules while closed. On restart, each workflow catches up at most one missed occurrence; an interrupted run is finalized as interrupted and starts again from the source beginning rather than reconnecting to an old browser process.

The App task catalog currently routes all 13 production tasks through the typed runtime: eleven browser provider definitions and the typed exchange-rate and MaiCoin workflows. Old helper code may be retired separately, but the App does not launch a provider-owned production command. New provider work starts at the same typed interface. The project-specific `workflow:dev` interface is documented separately; generic Libretto `run` commands are not the workflow development contract.

The existing Canonical Financial Commit module remains the sole financial admission authority. The executor injects a typed commit port whose worker adapter forwards to that module; this decision does not introduce a second commit policy or a workflow-owned database handle.

## Implementation status and evidence

The current operational PGlite schema is fresh baseline version 2. Runtime startup does not migrate or silently drop a version 1 store: it fails closed with a reset-required error. After closing the App, the local PGlite directory must be reset to create a fresh v2 baseline; this discards its prior contents, which are rebuilt through supported App collection and sync paths.

Repository checks exercise typed provider contracts with deterministic fixtures. Those checks do not certify a bank's current live login or export pages. For example, HNCB's checks use synthetic CP950/Big5 export bytes and a local browser/HTTP fixture; a live HNCB login and export acceptance run is separate evidence. See the [runtime contract](../specs/app-owned-workflow-runtime.md) for the 13 task IDs, port boundary, retention rules, developer procedure, and acceptance scope.
