# Bounded CAPTCHA Retry Campaigns

Status: accepted

## Decision

A user-initiated automation that uses a solver-backed `text-captcha` or
`image-selection` challenge runs as one CAPTCHA Retry Campaign. The campaign is
shown and persisted as one task run even if its provider workflow is restarted
internally. Checkbox challenges and human-operated verification are outside this
mechanism.

Each campaign permits at most ten CAPTCHA Challenge Rounds. A round starts only
after the workflow successfully captures a challenge image. It may run one to
three distinct provider-declared OCR strategies against that image and may
submit at most one accepted answer. A captured image that violates its declared
challenge contract consumes the round without submission. A missing challenge,
or a failure to load, locate, or capture it, does not consume the retry budget
and follows the workflow's normal outcome.

Only two typed outcomes may advance the campaign:

- `solver-exhausted`: no candidate satisfies the provider's Solve Acceptance
  Policy.
- `provider-rejected`: a provider-specific probe explicitly proves that the
  submitted CAPTCHA answer was rejected.

Log text, exception wording, process exit status, an ambiguous login failure,
incorrect credentials, account restrictions, and browser or transport faults
never establish a retry trigger. A provider may emit `provider-rejected` only
after the signal has fixture or live evidence. Providers without that evidence
may still retry `solver-exhausted`, but ambiguous post-submit failures fail
closed.

The first version obtains a new challenge by terminating and cleaning up the
current workflow/browser execution and restarting the whole provider workflow.
Rounds are strictly serial and begin without an added retry delay. Every restart
uses the provider, collection choices, verification configuration, and
in-memory sign-in details captured when the campaign began. Secrets, solver
answers, and challenge images are never persisted or logged.

The campaign ends on success, cancellation, a non-retryable failure, ten
consumed rounds, application termination, or unexpected automation-process
loss. Exhaustion fails closed without switching to human assistance. There is
no automatic crash recovery, resume UI, provider-specific retry limit,
user-configurable limit, in-page refresh, or cross-round image comparison in
the first version. A later explicit user run starts a fresh ten-round campaign.

This decision supersedes only the part of
`0012-automatic-captcha-verification.md` that finalized a task immediately after
the three same-image Solve Attempts were exhausted. Its solver ownership,
acceptance, privacy, and fail-closed rules remain in force.

## Considered Options

- **Restart the complete workflow inside one bounded campaign** — chosen because
  it gives every provider a fresh browser and challenge using one common host
  mechanism, without adding provider-specific refresh navigation in the first
  version.
- **Refresh only the CAPTCHA or login page** — deferred because refresh controls,
  state preservation, and rejection behavior differ by provider and require
  separate evidence.
- **Treat ten OCR invocations as the budget** — rejected because multiple
  strategies against one image are acceptance evidence, not ten fresh
  challenges.
- **Retry every failed login** — rejected because it can repeat incorrect
  credentials or account failures and increase lockout risk.
- **Infer retryability from logs or error strings** — rejected because prose is
  not a stable protocol and cannot prove provider rejection.
- **Create one task/history item per workflow restart** — rejected because the
  restarts implement one user request and would expose internal mechanics as
  unrelated failures.
- **Persist campaign state and resume after restart** — deferred because it
  expands secret handling and recovery semantics; interruption ends the first
  version's campaign.
- **Fall back to human verification after exhaustion** — rejected because it
  silently changes the selected Verification Actor.

## Consequences

- The automation host owns a campaign state machine above individual workflow
  processes and preserves one task-run identity across internal restarts.
- Workflow execution needs a private typed round-outcome channel; stdout and
  exception messages remain diagnostic only.
- Process and browser-session cleanup becomes a prerequisite for starting the
  next round.
- Task progress may expose the current round and fixed maximum, but no continue
  action or interrupted-campaign recovery is required.
- Every solver-backed provider receives `solver-exhausted` retry behavior.
  `provider-rejected` support is added provider by provider only after its
  rejection probe is proven.
- Tests must distinguish same-image Solve Attempts from fresh Challenge Rounds,
  verify the ten-round bound, and prove that unrelated failures never restart a
  workflow.
