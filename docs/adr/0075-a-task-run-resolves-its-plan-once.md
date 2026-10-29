# A task run resolves its plan once

Status: accepted

Refines [ADR 0074](0074-captcha-retry-campaign-owns-the-round.md). Applies [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md) and [ADR 0067](0067-workflow-execution-owns-per-execution-state.md).

A run passed its task id and workflow id down from the runner to the CAPTCHA Retry Campaign, the round adapter and the Workflow execution. Each layer looked up what it needed again. About 17 lookups read the task, the workflow definition, its input, its runtime, the source's verification facts and the source's cooldown, some of them once per round and one once per assistance request.

The lookups did not agree on what an unknown id meant. `workflowRuntimeForTask` treated an unregistered workflow as a browser workflow, and the worker protocol accepted its start. The execution returned a proven `workflow-failed` for a missing definition. The round adapter threw for a task that did not match the App catalog. The PGlite RPC was checked in the runner and checked again in the execution, once for a nonbrowser workflow and once for a workflow whose capabilities need it. The runner read the App settings twice after admission: once for the launch configuration and once for the verification settings.

**The runner resolves one Task run plan per run and passes it down.**

- **`resolveTaskRunPlan(task, dependencies)` in `task-run-plan.ts` returns a readonly `TaskRunPlan`.** The plan holds the task, its workflow id, its registration (definition, runtime and input builder), the source's verification facts, the launch configuration, the launch verification settings and the PGlite RPC. The verification facts are `null` for a task without a Verified source: exchange rates, preview sources and fixtures. `dependencies` supplies the RPC and lets a check override the configuration and the settings.
- **The plan is resolved after queue admission.** It is resolved at the point where the runner read the configuration before, so settings edited while the run was queued still apply. The settings file is read once for both the configuration and the verification settings. The early rejections at start time (an unknown task, an invalid Statement Selection) stay where they are.
- **Resolution fails closed once.** An unknown workflow id, a missing registration or a missing PGlite RPC throws, and the run ends `workflow-failed` the same way any other runner failure does. Every task requires the RPC. The worker protocol and the worker runtime also refuse an unregistered workflow id, and the registry no longer defaults an unknown workflow to a browser runtime.
- **The plan, the round and the seams are separate.** `runAutomationTaskExecution(plan, run, round, seams?)` takes the plan for the run, the round for this execution (attempt, maximum attempts, whether it retries, execution id and assistance route), and test-only seams. The browser port is one seam whose default is the App browser host. The campaign reads the cooldown from the plan, and the round adapter reads its routing facts and the task from it. `routeWaitingRunVerification` receives the task from the plan instead of looking it up for each assistance request.
- **The registry has one lookup.** `appWorkflowRegistration(workflowId)` returns the definition, runtime and input builder. The plan and the worker both use it. `sourceVerificationFacts(taskId)` returns the four verification facts in one scan of the Verified sources.
- **The worker still resolves its own definition.** A definition holds closures, and closures cannot cross the worker boundary, so the worker looks up the registration by the workflow id in its start frame.

## Considered options

- **Resolve the plan when the run starts.** Rejected. A run can wait in the queue, and settings edited during that wait would no longer apply to it.
- **Keep the lookups and memoize them.** Rejected. The lookups would stay scattered across four layers, each with its own rule for an unknown id, and a reader would still have to trace every layer to learn what a run executes with.

## Consequences

- An id the App cannot run now fails in one place. Production never reaches that state, because the runner rejects an unknown task at start time and every App task has a registered workflow.
- The plan carries the input builder, not the built input. The Workflow execution builds the input from the plan's launch configuration inside its failure handling, so an input that cannot be built (a Statement Selection cleared while the run queued) is classified, recorded and reported like any other execution failure, as before.
- The commit-time Collection scope check still reads the live settings (`collection-scope.ts`). It compares them with the launch configuration in the plan, so it is not part of the plan.
- Checks build their plan through the same resolver, with `planForCheck` and `routingPlanForCheck` in `task-run-check-support.ts`. Worker checks use a registered browser workflow id and supply their own definition.
