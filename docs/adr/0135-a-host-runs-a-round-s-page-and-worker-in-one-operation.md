# A host runs a round's page and worker in one operation

Status: accepted (2026-11-12)

Refines [ADR 0129](0129-a-workflow-execution-gets-its-page-and-worker-from-one-execution-host.md) and [ADR 0134](0134-the-worker-core-takes-capability-ports-never-a-pglite-descriptor.md): the execution host still gives a round its page and its worker, now through one operation. Keeps the per-execution hosted page of [ADR 0067](0067-workflow-execution-owns-per-execution-state.md) and the worker core's start rule of ADR 0129.

## Context

`ExecutionHost` had two operations, `withPage(run, use)` and `launchWorker(launch, execution)`. The only caller, `executeSupervisedAppWorkflow`, always called `launchWorker` inside `withPage` for a browser workflow. Each host connected the two calls through a side channel:

- **The Workflow execution as a mailbox.** `chromiumThreadHost.withPage` registered `{ page, connection }` on the execution with `hostPage`. `launchWorker` then read `execution.browserConnection()` back. Nothing tied that connection to the page the same round opened, apart from the call order.
- **A map in the check host.** `inProcessCheckHost` stored the browser it built in `withPage` in a `Map` keyed by task run id, and `launchWorker` read it back from there.
- **Browser or not, decided three times.** `executeSupervisedAppWorkflow` built a page only when the runtime was not `nonbrowser`. `chromiumThreadHost.launchWorker` looked the workflow up in the registry again to decide whether to require a connection. The worker core's start rule checked it a third time.

## Decision

**`ExecutionHost` has one operation.**

```ts
type ExecutionHost = Readonly<{
  hostRound<T>(
    round: Readonly<{ page?: AppWorkflowBrowserHostInput }>,
    supervise: (startWorker: (launch: WorkerLaunch) => AppWorkflowWorkerHandle) => Promise<T>,
  ): Promise<T>;
}>;
```

`hostRound` opens the round's page when `round.page` is given and keeps it open while `supervise` runs. `supervise` receives the round's worker start. A throw from `startWorker` is a worker start failure, as a throw from `launchWorker` was. Each host wraps its start with `oneWorkerPerRound`, so a second start in the same round throws.

**The round's caller decides browser or not.** `executeSupervisedAppWorkflow` builds `round.page` only for a browser runtime, and it is the only place that decides. For a browser round it flushes the browser runtime identity inside the round before it starts the worker, as before. `runSupervisedAppWorkflow` takes the `startWorker` it is given; its option is renamed from `launchWorker`.

**`chromiumThreadHost` passes the page's connection straight to its worker.** With `round.page` it calls `withAppWorkflowHostPage(round.page, use)`, which replaces `createAppWorkflowBrowserPort`. `use` receives `{ page, connection }`, and the start puts that `connection` into `workerData` beside `pgliteRpc`. A null `connection` makes `startWorker` throw. Without `round.page` it opens no Chromium and the worker gets no `browserConnection`. The host no longer reads the workflow registry.

**The Workflow execution holds only the page.** `HostedBrowserPage` is `{ page }`, and `WorkflowExecution.browserConnection()` is removed. `page()` stays for the App page lookup of ADR 0067.

**`inProcessCheckHost` builds the browser in the round.** With `round.page` and a `browser` option it builds `browser(round.page)` and hands it to the in-process worker. The map is removed. `scriptedWorker(start, launch)` is unchanged and runs inside the round's start.

**The core's start rule stays.** A browser workflow still needs a browser and a nonbrowser workflow must not have one (ADR 0129).

## Considered options

- **Keep two operations and pass a page token to `launchWorker`.** Rejected. It removes the side channels, but callers still have to call `launchWorker` inside `withPage` with the right token. That is still a nesting protocol that the type does not enforce.
- **`launch(round) → Promise<Handle>`, closing the page when the worker exits.** Rejected. The page's lifetime would depend on worker exit, so on the supervisor's terminate and grace timing. With `hostRound`, the page closes when supervision ends.
- **Pass the `WorkerLaunch` in `round`.** Rejected. The supervisor builds the start and validates it. The launch does not exist yet when the round is hosted.
- **Remove the core's browser/nonbrowser start rule.** Rejected. That rule validates input that crosses the thread boundary. It does not decide anything, so it is not a duplicate of the caller's decision.

## Consequences

- Each host proves its own start. `the Chromium thread host refuses a browser round's worker when its page exposes no connection` and `the Chromium thread host hands a browser workflow's thread its own page's DevTools target and the PGlite descriptor` in `app-workflow-worker.check.ts` drive `chromiumThreadHost.hostRound` with a stand-in browser context. The second check also proves that one round starts one worker and that the thread dials only its own round's endpoint. `a round of the in-process check host starts one worker` in `task-run-execution.check.ts` covers the check host.
- `exchange-rate and MaiCoin dispatch through supervised workers without a browser` runs its rounds on a host that fails any round asking for a page.
- The device registration page in `electron/main.ts` uses `withAppWorkflowHostPage` and ignores the connection.
- `app-browser-host.check.ts` asserts the connection that `withAppWorkflowHostPage` hands to `use`, and the hosted page through `execution.page()`.
