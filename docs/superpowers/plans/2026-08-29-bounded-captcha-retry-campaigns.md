# Bounded CAPTCHA Retry Campaigns Implementation Plan

> Implement the accepted design in
> `docs/adr/0015-bounded-captcha-retry-campaigns.md`. Keep each step test-first
> and do not broaden retry eligibility beyond typed, proven outcomes.

## Goal

Give every solver-backed text CAPTCHA and image-selection workflow up to ten
fresh challenge rounds per user-initiated operation. Each next round restarts
the complete workflow, while the UI and task history retain one operation. Keep
the existing maximum of three distinct OCR strategies per captured image.

## Architecture

The automation host owns a `CaptchaRetryCampaign` state machine above workflow
process execution. It freezes the launch input, creates one persisted task run,
starts fresh workflow/browser executions serially, and finalizes the task only
when the campaign ends. After a workflow publishes its existing human-
assistance contract, host-side verification routing invokes the configured
solver and returns a typed `VerificationRoutingOutcome` to the campaign. Logs,
generic exceptions, and workflow-to-host CAPTCHA IPC do not drive control flow.

The task run's existing `attempt` and `maxAttempts` fields represent consumed
CAPTCHA rounds only while a campaign is active. The host never persists CAPTCHA
images, answers, sign-in details, or mailbox/authentication secrets. Internal
execution IDs may be retained for operational correlation, but must not create
additional user-visible history rows.

## Fixed Constraints

- Scope: solver-backed `text-captcha` and `image-selection` workflows.
- Excluded: checkbox challenges and every `human` Verification Actor.
- Limit: exactly ten rounds, with no provider or user override in version one.
- A round is consumed only after successful challenge-image capture.
- One captured image permits one to three distinct Solve Attempts and at most
  one submitted answer.
- Retry triggers are only `solver-exhausted` and proven `provider-rejected`.
- Ambiguous login failures and infrastructure/workflow failures are terminal.
- Before retry, the prior workflow process and browser session must be cleaned
  up; no two rounds may overlap.
- No added backoff, in-page refresh, cross-round image comparison, crash resume,
  continue button, or automatic human fallback.
- Every restart uses the immutable launch snapshot; secrets remain in memory.

## Task 1: Model the campaign and round outcomes

**Create**

- `src/lib/automation/server/captcha-retry-campaign.ts`
- `src/lib/automation/server/captcha-retry-campaign.check.ts`

Define the campaign's closed discriminated union for at least:

- `succeeded`
- `retryable` with reason `solver-exhausted | provider-rejected`
- `failed` with a non-retryable classification
- `cancelled`

Define pure campaign transitions that track `consumedRounds`, enforce the fixed
maximum of ten, and reject malformed or out-of-order events. Model capture
success separately so load/locator/capture failures cannot consume a round.

Write failing tests first for:

1. first successful capture consumes round one;
2. missing challenge consumes none and may complete normally;
3. load/locator/capture failure consumes none and terminates normally;
4. structural-invalid captured challenge consumes one and may emit
   `solver-exhausted`;
5. only the two retry reasons advance;
6. success/cancellation/non-retryable failure ends the campaign;
7. the tenth retryable outcome ends as exhausted rather than starting round 11;
8. duplicate or stale outcomes cannot advance state.

Run:

```bash
npm test -- captcha-retry-campaign.check
npm run typecheck
```

## Task 2: Preserve one task run across workflow restarts

**Update**

- `src/lib/automation/server/runner.ts`
- `src/lib/automation/server/task-run-execution.ts`
- `src/lib/automation/server/task-run-finalization.ts`
- the browser/session lifecycle module used by task execution
- their colocated checks

Separate these concepts:

1. user-visible task-run creation/finalization;
2. one internal workflow process/browser execution;
3. campaign coordination across internal executions.

Create the task run once, freeze the launch snapshot once, and loop only when
host-side verification routing returns a typed `solver-exhausted` outcome.
Await workflow-process and browser-session cleanup before launching the next
execution. Reuse in-memory sign-in details without copying them into persistent
campaign state. Do not create a workflow-to-host CAPTCHA socket, environment
variables, or reporter helper.

Update task-run progress atomically after a challenge is captured. If the app or
automation process disappears unexpectedly, finalize the current task as failed;
do not persist a resumable campaign.

Tests must prove:

- ten internal executions still create one history row;
- settings changed after launch are ignored until a later user operation;
- internal rounds are serial and cleanup completes first;
- cancellation prevents another launch;
- generic failure, wrong credentials, and ambiguous post-submit failure never
  restart;
- no sign-in detail appears in persisted task or audit records.

Run the relevant focused checks, then:

```bash
npm run typecheck
```


## Task 3: Route solver exhaustion through the campaign

**Update**

- `src/lib/automation/server/verification-routing.ts`
- `src/lib/automation/server/verification-routing.check.ts`
- solver execution/planning checks

Replace the current immediate task failure after three unsuccessful same-image
strategies with a typed host-side `VerificationRoutingOutcome` carrying
`solver-exhausted`. Preserve all current candidate normalization, confidence,
agreement, strategy uniqueness, and single-submission rules.

The route must invoke `onChallengeCaptured` exactly once after a successful
capture. The runner records that event in `CaptchaRetryCampaign`, and then
transitions the same campaign to a retry only after routing returns
`solver-exhausted`. A workflow-side reporter, socket, environment variable,
or log marker is not part of this control path.

Add regression coverage proving:

- three strategies still evaluate the same captured image;
- repeating an identical strategy cannot manufacture a new attempt or
  agreement;
- no accepted candidate submits nothing and requests a fresh round;
- an accepted candidate is submitted once;
- solver exceptions remain non-retryable unless they are already represented as
  a policy-level exhausted result.

## Task 4: Integrate every supported workflow

Audit and update these workflow families:

- Taipei Fubon Bank
- Yuanta Bank
- Hua Nan Bank
- Chunghwa Post
- Bank SinoPac
- E-Invoice
- Yuanta Trade image-selection verification

For each workflow, declare its challenge image and solver metadata in the
existing human-assistance contract. Do not duplicate campaign loops or emit a
second CAPTCHA outcome from provider workflows. Keep all provider
preprocessing, acceptance policies, loaded-image requirements, and answer-shape
contracts unchanged.

Add a table-driven integration check showing that each solver-backed workflow is
registered and that checkbox/human workflows are not. A provider whose
challenge is absent must continue its existing path without starting a campaign
round.

## Task 5: Add provider-rejection probes only with evidence

For each provider, inspect sanitized fixtures and—where needed—perform a live
read-only or controlled Electron/CDP run to identify a stable CAPTCHA-specific
rejection signal. Record the evidence beside the provider check.

A probe is admissible only if it distinguishes CAPTCHA rejection from:

- incorrect credentials;
- account lock/restriction;
- generic validation errors;
- navigation/network failure;
- ambiguous continued presence of the login form.

Providers without adequate evidence receive only `solver-exhausted` retry in
this version. Do not invent a fallback heuristic. Each admitted probe needs
positive CAPTCHA-rejection fixtures plus negative fixtures for the neighboring
failure classes. Until a probe is proven, `provider-rejected` must fail closed
and must not advance the campaign.

## Task 6: Expose bounded progress without recovery controls


## Task 7: End-to-end verification

**Update as needed**

- automation task/page model
- task progress UI and localization resources
- their checks

Show passive progress such as `驗證碼嘗試 3 / 10` only after a challenge round
has been consumed. Do not add a Continue button, interrupted-campaign state,
provider-specific limit, or user setting. Preserve one final result and one
history entry.

Run the complete automated suite:

```bash
npm run typecheck
npm test
git diff --check
```

Then perform controlled Electron/CDP smoke tests for representative providers:

1. force or observe solver exhaustion and prove a clean full-workflow restart;
2. verify the next execution obtains a freshly captured challenge;
3. prove task history remains one item and round progress increments once;
4. verify a proven CAPTCHA rejection retries;
5. verify a wrong-password or ambiguous login failure does not retry;
6. cancel during a round and prove no subsequent workflow launches;
7. inspect logs/storage to confirm no image, answer, or credentials were saved.

If a live provider cannot safely produce a rejection case, retain fixture-based
coverage and leave `provider-rejected` disabled for that provider.

## Suggested Commit Sequence

1. `test: specify bounded captcha retry campaigns`
2. `refactor: preserve task runs across workflow restarts`
3. `feat: retry solver-backed captcha workflows`
4. `feat: add proven provider captcha rejection probes`
5. `test: cover captcha retry campaign integration`

Do not commit generated CAPTCHA debug images, OCR answers, authentication
material, or live provider response bodies.
