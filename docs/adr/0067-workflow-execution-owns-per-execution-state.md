# Each Workflow execution owns its per-execution state

Status: accepted

Extends [ADR 0052](0052-active-automation-task-run-owns-run-lifecycle.md), which gave each Active Automation Task Run one owner for its status, cancellation and outcome. Leaves the outcome precedence of [ADR 0058](0058-refused-commit-attempts-and-one-run-outcome-decision.md) unchanged.

## Context

ADR 0052 replaced eight taskId-keyed maps with one owner per run. That owner holds the run's status, its Commit attempts and its stop. Everything a single start of the provider workflow needs still lives elsewhere:

- Four module-global maps in the main process hold it:
  - `hostedPages`, keyed by run id;
  - `pendingAssistance`, keyed by run id;
  - `requestHandlers`, keyed by task id;
  - `runScopes`, keyed by run id.
  Each has its own register call and its own `finally` release in a different module.
- About nine writes during a run bypass the owner: run events, the human assistance contract and its completion, the browser runtime identity, and the solver-route signals. They go straight to the run's persistence.
- "This execution's events" is rebuilt at the end. The executor reads the stored events back, slices them at the count it saw before the worker started, and appends its in-memory copy of the worker's events. Every worker event is counted twice. The store keeps at most 200 events and prunes ones older than 30 days, so the slice can start inside an earlier execution or skip this one's first events. Host-written events, such as `solver-route-unavailable`, reach the outcome only through that slice.

A run can contain several of these starts. The CAPTCHA Retry Campaign restarts the workflow once per round ([ADR 0015](0015-bounded-captcha-retry-campaigns.md)), and each restart needs a fresh page, Collection scope version check and assistance handler.

## Decision

**A Workflow execution belongs to its Active Automation Task Run.** The run starts each one, and it ends when that start of the provider workflow finishes. A Workflow execution owns:

- its event log, worker and host events alike, each recorded once;
- its human assistance waiter and route handler;
- the Collection scope version it was launched with, which its commits are checked against;
- its hosted browser page.

All four are released together when the execution ends. Every write to the run's row still goes through the run's single serialized write chain, so ADR 0052's single-writer rule now covers events, the assistance contract and its completion, and the browser runtime identity too.

**This execution's events come from the execution.** Outcome classification, diagnostics and the failure stage read the execution's own log. Nothing reads stored events back to reconstruct it.

**Readers find state through the run.** The runner, which already holds every active run, answers `activeRun(runId)`. The PGlite child RPC's commit admission, the automation viewer and verification routing reach the current execution through that lookup. The four global maps are deleted.

**Page access is a seam with two adapters.** The automation viewer and verification routing depend only on a page lookup by run id. In the App, that lookup goes through `activeRun`. `npm run workflow:dev` has no runner, so it supplies a lookup over the one page it hosts.

**Only state that ends with the run moves.** Outside an active run's lifetime, code keeps using persistence directly: dashboard reads, startup recovery and history queries. `previewStructureReports` stays where it is, because the dashboard reads a run's preview structure report after the run has ended.

## Considered options

- **Hang the state on the run with an execution-start marker.** Rejected. Every round would have to reset the page, scope check and handler by hand, and the marker is the same stored-event index that miscounts today.
- **Pass the execution object to every reader.** Rejected. The PGlite child RPC is wired once at startup and cannot receive a new object for each run.
- **Move each global map in a separate change.** Rejected. Two ways of owning per-execution state would coexist, which is the two-owner pattern this repository keeps removing.
- **Route reads and writes outside a run through an owner too.** Rejected. No owner exists after finalization, and forcing one reintroduces a global.
- **Keep a development-only page registry for `workflow:dev`.** Rejected. It is the global map under another name. `workflow:dev` supplies its own adapter at the page-lookup seam instead.

## Consequences

- Each worker event appears once in the events that outcome classification and diagnostics read, and the store's 200-event cap and 30-day pruning no longer affect them.
- Host-written signals belong to the execution that wrote them, so `verification-configuration-failed` is still proven from `solver-route-unavailable` without reading the store.
- Checks reach this state through the run and execution interfaces against real PGlite, and through `executeTaskRunForCheck` for a whole execution.
