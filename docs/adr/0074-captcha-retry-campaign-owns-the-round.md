# The CAPTCHA Retry Campaign owns the round

Status: accepted

Refines [ADR 0015](0015-bounded-captcha-retry-campaigns.md) and [ADR 0070](0070-source-declared-captcha-retry-cooldown.md). Applies [ADR 0052](0052-active-automation-task-run-owns-run-lifecycle.md) and [ADR 0067](0067-workflow-execution-owns-per-execution-state.md).

`captcha-retry-campaign.ts` was a pure state machine that only counted rounds. The policy lived in `captcha-retry-coordinator.ts`, which the runner calls for every run: it checked the task against the App catalog, built the assistance route, joined the route with the execution, recorded the active round, decided whether to stop or retry, admitted the next round and waited out a source's cooldown. The stop precedence (an uncertain commit, a Canonical Reset, a failed route, a stop, a retryable route) sat in one loop with the route join and the run writes, so only tests that drove a real run and a real route could check it.

**The campaign module owns the campaign; a round adapter owns the round.**

- **`runCaptchaRetryCampaign({ taskId, run, executeRound })` runs every run.** It numbers each round, gives it a fresh execution id, and passes `attempt`, `maxAttempts` and `retrying: round > 1`. Round one runs with `maxAttempts: 1` until it captures a challenge. When the round captures one, the campaign's `onChallengeCaptured` advances the state machine and writes the active round to the run at once, so progress shows "retry 2/3" during the round. After a retryable round it admits the next round with a `running` transition and waits out the source's cooldown. It returns only the `TaskRunReport`.
- **`decideAfterRound({ campaign, report, assessed, routing, aborted })` is pure.** It returns `stop` with the report the run finishes with, or `retry` with the next round. Earlier checks win: an unknown commit outcome and a required Canonical Reset stop with the report; a failed route fails it; a stopped run or a cancelled report cancels the campaign; a retryable route retries, or, after the last round, stops with a proven `verification-failed` and asks the loop to record `verification-solver-exhausted`; otherwise the report stands.
- **`captchaRoundExecution(deps)` in `captcha-round-execution.ts` is the round adapter.** It checks the task against the App catalog when it is built. A task that routes verification gets the assistance route, the join of the route with the execution, the late capture on a provider rejection, and the rejection of the worker's stage on solver exhaustion. Any other task only executes, so it runs one round with the same stop precedence.
- **The state machine stays inside the module.** `createCaptchaRetryCampaign` and `transitionCaptchaRetryCampaign` remain exported for their own check.

## Considered options

- **Keep the coordinator and extract only the stop precedence as a pure function.** Rejected. The campaign module would still not own the campaign: numbering, admission and the active-round write would stay in a second module that every run passes through.
- **Fold the route join into the campaign.** Rejected. The join depends on the human-assistance port, the source routes and the verification settings. The campaign would then need all of them, and a test of the stop decision would again need a run and a route.

## Consequences

- The campaign is tested with a fake run and a fake round in `captcha-retry-campaign-loop.check.ts`, including a table for `decideAfterRound`. `app-workflow-captcha-bridge.check.ts` keeps only the tests that need a real browser, the real human-assistance port or a source-declared route.
- After a round the campaign no longer writes `attempt` and `maxAttempts` again. The capture write and the next round's `running` transition already wrote the same values.
- Two known races moved into the round adapter unchanged:
  - Only the last assistance route in an execution is joined. A second request in the same execution overwrites the first route's promise, so the first route's outcome is not awaited.
  - The join waits for the route after the execution returns. A source route that ignores its abort signal keeps the round, and so the run, waiting.
