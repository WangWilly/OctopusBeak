# A Workflow execution gets its page and worker from one execution host

Status: accepted

Refines [ADR 0128](0128-a-task-run-starts-through-one-admission-with-no-await-before-its-claim.md): the runtime is still built once with its provider, and it is now also built with the host its rounds run on. Keeps the per-execution hosted page of [ADR 0067](0067-workflow-execution-owns-per-execution-state.md), the host-call contract table of [ADR 0072](0072-host-calls-go-through-one-contract-table.md) and the PGlite child RPC of [ADR 0115](0115-a-crashed-pglite-worker-restarts-on-the-same-database.md) and [ADR 0118](0118-pglite-worker-rpcs-share-one-call-core.md).

## Context

A Workflow execution needs two things from the App: a page for a browser workflow, and a worker thread to run the workflow in. Checks replaced each of them at a different depth:

- **Four injection depths.** `createAutomationRuntime` took `runExecution`. `runAutomationTaskExecution` took `AutomationTaskExecutionSeams`. `runSupervisedAppWorkflow` took `workerFactory` and `workerPath`. `runAppWorkflowWorker` took `browser`, `financialCommit`, `accountIdentity`, `previewWrite`, `now` and `resolveDefinition`.
- **Execution seams production never passes.** The runner called `runExecution` with three arguments, so the four seams were always empty in the App. One of them, `createTdccSessionHost`, was passed by no caller at all.
- **A fake descriptor.** A check that ran the real worker in process still had to hand the supervisor a DevTools descriptor, `http://127.0.0.1:43121` with a `host-page-<runId>` target. The literal was in five places. The page the host held was `{} as never`.
- **A second runner.** `executeTaskRunForCheck` resolved a plan, opened a run, built a round and finished the run, "as the runner does". Checks that used it skipped admission, the queue and the CAPTCHA Retry Campaign.
- **Two ways to get a browser in the worker core.** A Playwright `Page` cannot cross a thread boundary, so the App sends the worker a loopback descriptor and the worker attaches over CDP. Checks injected a `WorkflowBrowserPort` instead. The core parsed the descriptor from its start frame and also accepted the injected port, so it held both.

## Decision

**`ExecutionHost` in `execution-host.ts` has two operations.**

```ts
type ExecutionHost = Readonly<{
  withPage<T>(run: AppWorkflowBrowserHostInput, use: () => Promise<T>): Promise<T>;
  launchWorker(
    start: AppWorkflowWorkerStart,
    execution: Pick<WorkflowExecution, "browserConnection">,
  ): AppWorkflowWorkerHandle;
}>;
```

`withPage` keeps the round's page open while `use` runs. A nonbrowser workflow never calls it. `launchWorker` starts the round's worker and returns the handle the supervisor drives: `on` and `off` for `online`, `message`, `error` and `exit`, `postMessage` and `terminate`. A throw from `launchWorker` is a worker start failure.

**The runtime is built with its host.** `createAutomationRuntime(provider, { executionHost?, runExecution?, ... })` defaults the host to `chromiumThreadHost`. Its default `runExecution` is `createTaskRunExecution(executionHost)`, which replaces `runAutomationTaskExecution`. `runExecution` stays for runner lifecycle checks that replace whole rounds.

**`chromiumThreadHost` keeps descriptors inside the App adapter.** Its `withPage` is the App browser host: it launches Chromium, reads the loopback DevTools endpoint and the page's target id, registers the hosted page on the execution and leaves native dialogs to the worker. Its `launchWorker` creates `new Worker(app-workflow-worker.cjs, { workerData })`. For a browser workflow, `workerData` is the core start plus the execution's `browserConnection`. It drains and discards the thread's output.

**The thread entry turns the descriptor into a browser.** `runAppWorkflowWorkerThread` validates `browserConnection` with the same loopback rules as before: `http`, host `127.0.0.1`, an explicit port, no path, query or hash, and a safe target id. It converts the connection to a `WorkflowBrowserPort` and calls the core with it. An invalid descriptor gets the `protocol-invalid` start refusal. `withAppWorkflowBrowserPage` still asserts the loopback endpoint when it connects.

**The worker core takes a browser, never a descriptor.** `runAppWorkflowWorker(start, { port, browser?, financialCommit?, accountIdentity?, previewWrite?, now?, resolveDefinition? })` parses a start frame that has no `browserConnection`. A browser workflow without `browser`, or a nonbrowser workflow with one, gets the same `protocol-invalid` start refusal as a malformed frame. `pgliteRpc` is unchanged. (Refined by [ADR 0134](0134-the-worker-core-takes-capability-ports-never-a-pglite-descriptor.md): the start no longer carries `pgliteRpc`, and the core takes its capability ports from one `CapabilitySource`.)

**The supervisor gets its worker from the host.** `runSupervisedAppWorkflow` takes `launchWorker` and keeps its cancel and terminal grace timing. `workerFactory`, `workerPath` and the `browserConnection` option are removed.

**Checks use `inProcessCheckHost`.** It lives in `task-run-check-support.ts`, outside production code. Its `withPage` opens no browser. Its `launchWorker` runs the real `runAppWorkflowWorker` over a `MessageChannel` with the check's `browser`, `financialCommit`, `accountIdentity`, `previewWrite`, `now` and `resolveDefinition`, or returns the check's `scriptedWorker`. `browser` is built from the page input the round asked for, so a check can read its start URL and profile. `runtimeForCheck` builds the real runtime with that host and writes the check's settings and credentials, and `runForCheck` starts one task and waits for it to settle.

**Deleted.** All four `AutomationTaskExecutionSeams` members, the fake descriptor, the `{} as never` host pages, `executeTaskRunForCheck`, `supervisedWithCheckWorker` and `inProcessAppWorkflowWorker`. `createTdccSessionHost` still reads the run's credentials, and it is no longer replaceable.

## Considered options

- **Delete `runExecution` too.** Rejected. Runner lifecycle checks fake whole rounds without any workflow, to test claims, queueing, cancellation and settlement. That is a real seam of the runner, not of the execution.
- **Make `browserConnection` optional in the protocol.** Rejected. The check "a browser workflow has a browser" would move from the start frame to the first page use, and the parser would have to know which test options were passed.
- **A `browserInjected` flag in the start frame.** Rejected. It keeps the descriptor in the core's protocol. Keeping descriptors inside the Chromium adapter removes them from the core.
- **Unify on descriptors.** Rejected. Every workflow check would need a real Chromium or a fake CDP endpoint.
- **Unify on a page RPC through host calls.** Rejected. Every page operation would cross the thread as a host call, which is a new protocol for each Playwright method a workflow uses.

## Consequences

- In production the loopback descriptor is still checked twice: at the thread entry and when the worker connects.
- Workflow checks built with `runtimeForCheck` go through admission, the queue and the CAPTCHA Retry Campaign. Admission refuses a task whose source is disabled or whose Sign-in Details are missing, so `runtimeForCheck` enables every source and writes the check's credentials. A Yuanta Trade check now writes a real certificate file, because admission validates the certificate path.
- Five checks need a round with an assistance route of their own, or no route: the Post sign-in CAPTCHA, cancellation during that CAPTCHA, the Post unrouted case and two `task-run-execution.check.ts` cases. The campaign routes a Verified source's requests to the App's solver, which reads a hosted page that `inProcessCheckHost` does not open. These checks also go through the runtime: `runtimeForCheck` takes an `assistanceRoute`, or `null` for none, and its `runExecution` gives every round that route in place of the campaign's.
- Scripted workers for lifecycle and protocol checks are passed as `inProcessCheckHost({ scriptedWorker })`.
- A browser workflow whose execution hosts no DevTools connection now fails in `launchWorker` as `worker-start-failed`. Before, the same throw happened inside `withPage` and was recorded as a host error.
- `the Chromium thread host hands a browser workflow's thread its DevTools descriptor` in `app-workflow-worker.check.ts` proves the adapter wiring against the bundled worker. `a browser workflow starts only with a browser and a nonbrowser workflow only without one` proves the core's start rule.
