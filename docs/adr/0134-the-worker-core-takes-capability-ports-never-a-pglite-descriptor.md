# The worker core takes capability ports, never a PGlite descriptor

Status: accepted (2026-11-12)

Refines [ADR 0129](0129-a-workflow-execution-gets-its-page-and-worker-from-one-execution-host.md): its browser decision now also applies to the PGlite child RPC of [ADR 0115](0115-a-crashed-pglite-worker-restarts-on-the-same-database.md) and [ADR 0118](0118-pglite-worker-rpcs-share-one-call-core.md). Keeps the capability ports of [ADR 0100](0100-exchange-rate-sync-is-a-capability-workflow.md).

## Context

ADR 0129 took the DevTools descriptor out of the worker core. The PGlite descriptor stayed, and the core got its capability ports from two sources, a descriptor in the start frame and injected ports:

- **A descriptor in the start frame.** `AppWorkflowWorkerStart` carried an optional `pgliteRpc`. The core parsed it and dialled the PGlite child RPC itself, and `parseAppWorkflowWorkerStart` refused a nonbrowser start without it.
- **Injected ports.** `runAppWorkflowWorker` also took `financialCommit`, `accountIdentity` and `previewWrite` from its options. Checks used them in place of the RPC.
- **A merge in the core.** The core dialled the RPC before resolving a nonbrowser definition, and again after resolving any definition whose required ports the injected ones did not cover. It then took each required port from the injected ports first and from the RPC second, with its own rule for the optional preview write port.
- **A runtime rule for the descriptor.** `workflowNeedsPgliteRpc` gave the descriptor to every nonbrowser workflow, whether or not it declared a capability. Every registered nonbrowser workflow declares one.
- **A descriptor in checks that never dial it.** Checks that injected ports still had to put a well-formed descriptor in the start, and checks that ran without one removed it with `({ pgliteRpc, ...withoutRpc }) => withoutRpc`.

## Decision

**The core opens one `CapabilitySource`.**

```ts
type CapabilitySource = Readonly<{
  open(request: {
    definition: WorkflowDefinition;
    workflowId: string;
    taskRunId: string;
    tdccSession: TdccSessionPort;
    signal: AbortSignal;
  }): Promise<{ ports: Partial<WorkflowCapabilityPorts>; close(): void }>;
}>;
```

`runAppWorkflowWorker(start, { port, browser?, capabilities, resolveDefinition?, now? })` resolves the definition, opens `capabilities` once, spreads its `ports` into the executor's ports and closes it when the run ends. The `financialCommit`, `accountIdentity` and `previewWrite` options, the core's two dial points and its merge are removed.

**Two sources.**

- `childRpcCapabilities(descriptor)` is the App's. A definition that declares no capability gets no ports, and the RPC is not dialled. A definition that declares one, with no descriptor, fails with `worker-start-failed`. Otherwise it dials the RPC, waits for it to authenticate (abortably), and serves every port from it. It closes the client if authentication fails or the run is cancelled first.
- `fixedCapabilities(ports)` is for checks. It serves the given ports.

Both return the ports the definition requires, plus the preview write port when the definition may carry it without requiring it. The TDCC port stays one object, `{ session, admittedFundAccounts }`. The source builds it from the `tdccSession` the core passes in, because only the core can serve the session through host calls.

**The start frame never carries the descriptor.** `AppWorkflowWorkerStart` has no `pgliteRpc`. `parseAppWorkflowWorkerStart` refuses a start that carries one, and no longer requires one for a nonbrowser workflow.

**The descriptor travels beside the start.** `ExecutionHost.launchWorker(launch, execution)` takes a `WorkerLaunch`:

```ts
type WorkerLaunch = Readonly<{ start: AppWorkflowWorkerStart; pgliteRpc?: PGliteWorkflowRpc }>;
```

`runSupervisedAppWorkflow` builds the launch from the start it parsed and its `pgliteRpc` option. `chromiumThreadHost` puts `pgliteRpc` into `workerData` beside `browserConnection`. `inProcessCheckHost` ignores it.

**The thread entry turns the descriptor into the source.** `runAppWorkflowWorkerThread` removes `browserConnection` and `pgliteRpc` from `workerData`. It validates each one that is present: the browser connection with `parseAppWorkflowBrowserConnection`, and the RPC with `parseAppWorkflowPgliteRpc` (an endpoint of at most 1,024 characters and a 32 to 128 character token). An invalid descriptor gets the `protocol-invalid` start refusal. The entry then calls the core with `childRpcCapabilities(pgliteRpc)`.

**A workflow needs the descriptor exactly when it declares a capability.** `workflowNeedsPgliteRpc(definition)` is `requiredWorkflowCapabilities(definition).length > 0`. It no longer takes the runtime.

**Checks name their source.** `CheckWorkerPorts`, and so `inProcessCheckHost`, take `{ capabilities?, resolveDefinition?, now? }`, with `fixedCapabilities({})` as the default. A check that needs the real RPC passes `childRpcCapabilities(descriptor)`. `scriptedWorker` receives the launch as its second argument, so a check can read the descriptor the host was given.

## Considered options

- **The core takes prebuilt ports.** Rejected. The thread would have to build the ports before calling the core, so it would parse the start frame itself to find the definition, duplicating the core's parsing and its refusals.
- **Lazy proxy ports.** Rejected. The thread could pass ports that dial the RPC on first use. A missing or rejected descriptor would then fail inside the workflow, after `run-started`, instead of at the start, and the core still could not close a client it does not know was opened.
- **Split the TDCC port so the core merges the session.** Rejected. A source would return a TDCC port without its session, and the core would add it. That needs two port types and a TDCC special case in the core. Passing `tdccSession` to `open` keeps one port type.
- **Make `pgliteRpc` optional in the plan.** Rejected. `resolveTaskRunPlan` refuses a task when the App has no PGlite transport, before the run starts. An optional descriptor would move that refusal into the worker.

## Consequences

- The descriptor is now in the plan, the supervisor's options, the host's launch and the thread's `workerData`. The core's start type and parser never name it.
- `resolveDefinition` stays as a check seam on the core. `now` also stays: the E.SUN check fails without it, because its fake page answers only the timeline dates of its fixed clock. The CTBC, LINE Bank, Post and SinoPac checks also fix the clock.
- `CHECK_PGLITE_RPC` is now only a plan value. It travels from the plan to the host's launch and is never dialled. `task-run-execution.check.ts` and `pglite-persistence.check.ts` assert that the descriptor reaches `launchWorker` and that the start does not carry it.
- A check can no longer mix injected ports with RPC ports. It uses one source.
- A declared capability without a descriptor, or an RPC that fails to authenticate, reports `workflow-failed`, as before: the thrown `worker-start-failed` is not mapped to its own code. Cancellation while the source opens still reports `cancelled`.
- A malformed descriptor is now refused by the worker thread, not by the supervisor's start parser. A worker is started before the refusal, and the run still ends `protocol-invalid`. The plan checks only that the endpoint and token are non-empty.
- `app-workflow-worker.check.ts` proves the decision: the core refuses a start with a descriptor, the thread refuses an invalid one, a declared capability without a descriptor fails in the source, the child RPC source dials only for a declared capability and hangs up when cancelled, and the Chromium thread host's thread dials the descriptor it was given.
