# A Task Run starts through one admission with no await before its claim

Status: accepted

Refines [ADR 0052](0052-active-automation-task-run-owns-run-lifecycle.md): an Automation Task Run is still claimed by one owner, and a claim is now never shared by two starts. Refines [ADR 0075](0075-a-task-run-resolves-its-plan-once.md): the runner resolves its plan from a provider and execution it was built with. Keeps the batch rules of [ADR 0082](0082-one-summary-notification-per-sync.md) and the readiness boundary of [ADR 0103](0103-one-module-runs-the-hosts-background-services.md).

## Context

The Automation runtime (`automation-runtime.ts`) wrapped the runner (`runner.ts`). Between them, the rules for starting an Automation Task Run sat in three layers:

- **Three layers of admission.** The runtime checked the desktop model: the task is enabled, not waiting for verification, and has its Sign-in Details. The runner checked shutdown, the data-deletion hold, App executor registration, `scheduledAtUtc` and the Source device lock. The desktop service and the schedulers decided which tasks to start and how to report them.
- **Two Statement Selection checks with different semantics.** The model check read the source's enabled flag from the model. The runner checked the selection again with the source forced to enabled.
- **Three already-running checks for exchange rates.** The daily scheduler asked `isTaskActive`, `runtime.runMany` asked `runner.current`, and `runner.start` looked up its claim.
- **A race that dropped the summary.** `runtime.run` awaited `runner.current` and the desktop model before it called `runner.start`. A start that claimed the task meanwhile made the runner return the existing run with `adopted: true`. `run` ignored that flag, so it reported the task as started, and the `onSettled` it had passed was never called. A single source the person started while that source was being claimed elsewhere sent no summary notification.
- **Nine pure forwards.** The runtime repeated `activeTaskIds`, `activeRun`, `hasActive`, `cancel`, `forceTerminate`, `whileStopped`, `abortAll` and `shutdown` from the runner, and `startWithoutAdmission` let the packaged browser fixture skip the model check.
- **A per-call provider.** `runner.start`, `runner.run` and `runner.shutdown` each took the persistence provider, although the App has one. Checks passed the execution seam the same way.

## Decision

**`AutomationRuntime` is the one module callers use to start and control Task Runs.** `createAutomationRuntime(provider, { credentials, settings, userDataDirectory, forceQuitAvailableAfterMs?, runExecution? })` builds the runner with the provider and the execution seam. The runner's lifecycle members are the runtime's own members. Its `claim` and `claimedRunId` stay inside the runtime.

**One entry starts tasks: `start(taskIds, { scheduledAtUtc?, onSettled? })`.** It returns one `AutomationStartResult` per distinct task: `started` with its run id, `already_running` with the run id of the start that holds it, or `error` with the refusal. A single manual run is a batch of one.

**Admission has no await between the check and the claim.** `start` awaits the desktop model once. Then, for each task, it runs these steps synchronously:

1. If a start already holds the task, the result is `already_running`.
2. The model check runs. It is the only Statement Selection check, and it uses the model's enabled flag.
3. The runner's `claim` refuses a shutdown, a data-deletion hold, an unregistered task, an invalid `scheduledAtUtc` or a busy Source device (`SourceDeviceBusyError`), and otherwise claims the task.

Nothing is adopted. Two concurrent starts of one task give one `started` and one `already_running`.

**A batch settles once.** `onSettled(results)` runs once, after every task that the start started has ended. Its results carry each started task's terminal record, or `null` when the record could not be finalized, and the batch's `already_running` and `error` results. `collectionResults` in `collection-summary.ts` is the ADR 0082 policy as a pure function: report each source the batch started, report each source it could not start as not synced, leave out a source already running, and leave out tasks without a source. A batch without a source reports nothing. The desktop service and Scheduled Collection both pass `reportCollection(onFinished)` as `onSettled`.

**Readiness and the renderer contract stay where they are.** The desktop service still awaits `ensureAutomationRuntimeReady` before a start and maps the results to the unchanged `automation:run` and `automation:runMany` IPC shapes. Electron main still starts the schedules through `startWhenReady`. The exchange-rate schedule calls `start(["exchange-rates"], { scheduledAtUtc })` with no `onSettled` and throws the refusal of an `error` result.

## Considered options

- **Keep the runner public and delete the runtime.** Rejected. IPC, the schedulers and the fixture already call the runtime. The runtime owns the runtime snapshot, recovery and the desktop model that admission needs. The runner would have had to take all of those.
- **A mutex around start.** Rejected. Removing the await between the check and the claim closes the race. A lock would serialize the desktop model reads and add a second way to wait.

## Consequences

- When the person starts one source that another start has just claimed, the result is now `already_running` with that run's id. The run belongs to the other batch, and that batch reports it. A summary is no longer lost to an adopted run. `two concurrent starts of one task start it once, and only the start that claimed it settles it` in `automation-runtime.check.ts` proves it. The check fails if an await is put back between the check and the claim.
- A held task reports `already_running` before the model check runs, as `runMany` did before. A run that is waiting for verification is therefore `already_running`, not refused.
- Statement Selection is checked once, with the source's enabled flag from the model. A disabled source is refused as disabled before its selection is read.
- `onSettled` waits for every task the batch started, including exchange rates when a batch starts them beside sources. The notification is still sent only after every source has ended.
- `startWithoutAdmission` is removed. The packaged browser fixture starts its synthetic tasks through `start`. They have no source, no Sign-in Details and no Statement Selection, so they pass the model check. `packaged-browser-worker-fixture-admission.check.ts` proves it.
- `onFinished`, the `taskRunId` adoption option, `runner.run` and `createAutomationPersistenceProvider` are removed; none had a production caller.
- The IPC result shapes are unchanged.
