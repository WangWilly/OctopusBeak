# Solver-only verification

Status: accepted

## Decision

Only on-device verification solvers complete verification. The App has no human verification path, in packaged or development builds, and `npm run workflow:dev` has none either. This supersedes the human actor of [ADR 0003](0003-structured-human-assistance-contracts.md) and the development-only `human` Verification Actor of [ADR 0012](0012-automatic-captcha-verification.md).

The structured contract from ADR 0003 survives as the solver's verification contract. Its code names stay unchanged on purpose: `HumanAssistanceContract`, the `humanAssistance` workflow port, `emitHumanAssistanceStage`, `app-workflow-human-assistance.ts`, and the `waiting_for_human` run status. The UI labels `waiting_for_human` as "verifying" ("驗證中"). A workflow still declares one verification stage at a time, and the host still validates its targets, completion rule, and version.

The App's assistance port requires a registered solver route for every stage. A stage without one fails closed. The run event is `solver-route-unavailable` when the challenge kind is solver-backed and `solver-challenge-unsupported` otherwise. Both map to the typed outcome `verification-configuration-failed`. A solver route that ends without resuming the stage also fails the run. Nothing hands the stage to a person.

Provider consequences:

- Cathay United Bank Email OTP runs only through the Gmail OAuth retrieval of [ADR 0014](0014-local-gmail-oauth-for-cathay-email-otp.md). When the send button is not visible, the workflow fails with the typed reason `challenge-unavailable`. The unused statement-scope repair stage is gone.
- E.SUN login verification emits `solver-challenge-unsupported` and fails. Users see the same typed outcome as before.
- Yuanta Trade certificate selection and its image challenge still fail closed through the Yuanta Trade solver handler. Audio verification follows [ADR 0019](0019-yuanta-trade-audio-verification.md).

The verification actor policy is removed. There is no `VERIFICATION_ACTORS` table, no `configureHostVerificationActorPolicy`, no `LIBRETTO_CLOUD_*_VERIFICATION_ACTOR` environment variable or settings key, and no `verificationActorsByCredentialGroup` in the Automation page model. The settings loader drops stale actor keys from an existing `settings.json` without an error.

The desktop UI has no Assist viewer and no manual Resume. The IPC channels `automation:resumeHumanAssistance`, `automation:viewerScreenshot`, `automation:viewerInspect`, `automation:viewerInput`, and `automation:viewerCompletionCheck` are removed.

`npm run workflow:dev` runs its `humanAssistance` port through the App's local solver route (`routeVerificationActor` with `verificationRoutingDependencies`) against the development page that it registers with `registerAppWorkflowPage`. It fails closed for any workflow or stage the App would not route. It does not run the ten-round CAPTCHA Retry Campaign of [ADR 0015](0015-bounded-captcha-retry-campaigns.md), so a retryable outcome ends the development run.

## Considered options

- **Keep the development-only `human` actor** (ADR 0012). Rejected. The packaged App never used it, yet it kept a second completion path, the Assist viewer, five IPC channels, and actor policy in the code base. Development verification now exercises the same solver route that production uses.
- **Rename the contract, port, and status to solver terms.** Deferred. The names cross persistence, IPC, and every provider workflow, and the rename is not needed to remove the human path.

## Consequences

- An unsupported or unrouted challenge always ends the run with a specific reason. The user fixes setup or waits for solver support, then starts a new run.
- The CONTEXT.md glossary describes verification with the `solver` as the only actor. The Assist presentation terms are retired.
- Adding a new verification stage requires a solver route. A workflow cannot ship a stage that waits for a person.
