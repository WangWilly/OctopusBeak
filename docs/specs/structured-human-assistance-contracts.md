# Structured Human Assistance Contracts for Verification Workflows

## Problem Statement

The current Assist flow treats human interaction as a generic browser-viewer interaction instead of a workflow-declared verification step.

This produces three related failures:

1. A floating input box can appear when the user clicks outside the actual CAPTCHA input. The current viewer chooses the nearest inspectable text target within a broad proximity window, so a click on an unrelated page region can be associated with a nearby input.
2. A generic local interaction signal can make Resume available even though the required CAPTCHA, checkbox, challenge, or verification modal has not been completed.
3. Onboarding and workflow progression are not gated by the real outcome of human verification. The UI can advance because the user interacted with Assist, rather than because the workflow confirmed that the external prerequisite was satisfied.

The problem affects Yuanta Securities first, but the underlying failure is shared by every workflow that pauses for an external prerequisite or human verification. The product needs one consistent model that distinguishes an actionable target from visible page content, interaction from completion, inline verification from an independent verification step, and a current contract from an old or missing one.

Yuanta-specific requirements are:

- Yuanta Bank allows typing only into the actual CAPTCHA input region.
- Yuanta Trade supports a first stage for the CAPTCHA checkbox and a later stage for the verification modal or challenge controls.
- The focus view zooms to the relevant input or challenge while keeping the challenge context visible.
- Arbitrary page content cannot be clicked through the verification flow.
- Other workflows use the same contract whenever their CAPTCHA, OTP, or comparable verification can be modeled.

When verification is not an independent workflow step and the field is submitted together with login information, non-empty input may be used as the pre-submit condition. Final correctness must still be determined by the login or workflow outcome.

## Solution

Introduce a structured, persisted Human Assistance Contract as the sole source of truth for every human-assisted workflow.

A workflow creates or updates the contract through a shared host API. The automation server associates the contract with the current task run, persists its current version, and exposes it to the Assist UI. A provider verification adapter resolves the contract against the live browser state and reports the actual workflow outcome. The generic viewer no longer infers arbitrary inputs from page geometry.

The contract describes one Human Interaction Stage at a time. Each stage contains the stage identity and version, a finite allowlist of Human Verification Targets, allowed Verification Interaction Modes, a Verification Context Region, focus presentation, completion policy, and retry/failure information.

Every viewer operation carries the target identity, interaction mode, and contract version. The server rejects operations that do not match the current stage, target allowlist, mode allowlist, or contract version. The UI reloads the latest contract instead of falling back to unrestricted interaction.

The Assist focus view centers and zooms the browser presentation on the declared target and its context. The user may pan or zoom the presentation for readability. Panning and zooming affect only the Assist presentation; browser input is sent only when explicitly directed at a declared target.

Completion differs by workflow shape:

- An independent verification step enables Resume only after the workflow or provider adapter confirms completion. A click or typed value alone is not completion.
- An inline verification field submitted with login information may use a non-empty input as its pre-submit condition. Correctness is determined by the resulting login or task outcome.
- A failed or incomplete resume re-enters waiting with refreshed context and a new contract version. Retries are bounded by the workflow or provider; exhaustion becomes an explicit failure.

Onboarding advances only from the real task result. Local interaction may make Assist controls available, but cannot settle onboarding or enable the next step by itself.

The first provider implementations are Yuanta Bank and Yuanta Trade, followed by migration of other workflows that pause for CAPTCHA, OTP, or comparable human verification. A new human-assisted workflow must use the shared contract API; a raw pause without a contract is a contract error and must fail safely.

## User Stories

1. As a Yuanta Bank user, I want Assist to focus on the actual CAPTCHA input so I know where to type.
2. As a Yuanta Bank user, I want clicks outside the CAPTCHA input to do nothing and never open a floating input box.
3. As a Yuanta Bank user, I want the CAPTCHA challenge image, label, and required context to remain visible while the input is zoomed in.
4. As a Yuanta Bank user, I want to type only into the declared CAPTCHA target.
5. As a Yuanta Bank user, I want Resume to remain unavailable until the workflow has collected the CAPTCHA input and is ready to submit it.
6. As a Yuanta Bank user, I want a wrong CAPTCHA result to return me to a refreshed verification stage.
7. As a Yuanta Trade user, I want the first stage to expose only the CAPTCHA checkbox as actionable.
8. As a Yuanta Trade user, I want nearby page content to remain visible but non-actionable unless explicitly declared.
9. As a Yuanta Trade user, I want the checkbox transition to produce a separate stage for the later verification modal.
10. As a Yuanta Trade user, I want only the modal and its declared challenge controls to be actionable.
11. As a Yuanta Trade user, I want the modal instructions and challenge context to remain visible while zoomed in.
12. As a user of any workflow, I want Assist to explain whether the expected action is type, click, keyboard activation, or drag.
13. As a user, I want pointer-only controls such as drag challenges to be explicitly declared and guided.
14. As a user, I want keyboard-accessible targets to support keyboard activation when the external page supports it.
15. As a user, I want to pan and zoom the Assist presentation without changing the live browser page.
16. As a user of an independent CAPTCHA, OTP, or modal step, I want Resume only after workflow confirmation.
17. As a user entering verification with login credentials, I want a non-empty field to allow submission while final success remains based on login outcome.
18. As an onboarding user, I want the next step blocked until the associated task succeeds.
19. As an onboarding user, I want failed or incomplete verification to keep me in Assist with a clear retry state.
20. As a workflow author, I want to declare semantic targets and context regions instead of relying on nearest-input detection.
21. As a workflow author, I want to update the contract when navigation, a new challenge, or a modal changes the controls.
22. As a workflow author, I want independent and inline completion policies to be explicit.
23. As a workflow author, I want provider limits and retry exhaustion behavior to be explicit.
24. As an automation server, I want contracts persisted with task runs so reconnects and UI reloads preserve state.
25. As an automation server, I want stale target operations rejected after a contract update.
26. As an automation server, I want missing or unresolvable contracts to keep the run waiting and disable Resume.
27. As an automation server, I want legacy waiting runs without contracts to avoid inferred interaction and require force-quit plus a new run.
28. As a user, I want raw CAPTCHA, OTP, and verification text excluded from contracts, logs, analytics, and exports.
29. As a user, I want CAPTCHA screenshots and focus views cleared when the active session ends.
30. As a user, I want force quit to terminate the waiting session without implying verification success.
31. As a product operator, I want all modelable CAPTCHA/OTP workflows to follow the same restriction and gating rules.
32. As a test author, I want the boundary between visible context and actionable targets independently testable.

## Implementation Decisions

1. The automation server owns the Human Assistance Contract lifecycle. A shared host API creates a contract, associates it with the current task run, persists it, versions it, and transitions the run into and out of human waiting.
2. The contract is structured data, not a log message. It identifies the current Human Interaction Stage, version, targets, interaction modes, context region, focus presentation, completion policy, and retry state.
3. A stage may contain multiple explicit controls, but every control is individually declared. Visibility, editability, proximity, or semantic similarity does not make a control actionable.
4. Each target has a stable semantic identity supplied by the provider adapter and a live resolution against the current browser frame or modal. Resolved geometry is presentation and validation data, not permission to infer targets.
5. Provider verification adapters resolve provider-specific frames, controls, challenge regions, and completion evidence. The generic viewer only presents the contract and enforces its operation boundary.
6. Viewer operations are explicit: type, click, keyboard activation, and drag are separate modes. Drag is accepted only when explicitly declared.
7. The server validates every operation against current contract version, stage, target identity, interaction mode, and live resolution. Rejected operations send no browser click or type event.
8. Human verification removes nearest-target and broad-proximity fallback. A click outside a target may manipulate only the Assist presentation as pan/zoom; it cannot become browser input or an inferred floating input.
9. The focus view uses target and Verification Context Region to calculate readable initial zoom. Context may be visible without being actionable. Pan/zoom remains local to the presentation.
10. Independent verification requires workflow/provider confirmation before Resume. Inline verification allows a non-empty field as a pre-submit condition and delegates correctness to the resulting login or workflow result.
11. Resume availability derives from the contract and workflow outcome. Generic interaction flags cannot settle an onboarding step or authorize continuation.
12. Failed or incomplete resume re-enters human assistance with refreshed resolution and a new contract version. Retry and exhaustion behavior belong to the workflow/provider and must produce explicit failure.
13. Onboarding uses task outcome as its progression gate. Assist interaction state may control presentation or enable a resume request, but cannot complete onboarding.
14. Workflows that pause for human verification migrate to the shared API. New raw pauses without contracts are invalid and fail safely.
15. Legacy runs without contracts receive no inferred targets or unrestricted viewer operations. They can be force-quit; recovery starts a new contract-backed run.
16. Contract resolution failure leaves the run waiting, disables Resume, explains the unresolved target, and recovers only through contract update or force quit.
17. Persistence may retain stage metadata, target identifiers, versions, state, and retry metadata, but never raw verification text. Raw input is used only for the live CDP interaction.
18. Screenshots and focus views remain session-memory-only, are cleared when the session or run ends, and are not exported or attached to task history.
19. Yuanta Bank uses an independent adapter whose actionable target is the exact CAPTCHA input and whose context includes the challenge information needed to answer.
20. Yuanta Trade uses staged verification: the first stage declares the CAPTCHA checkbox; a later version declares the verification modal and challenge controls.
21. Other modelable CAPTCHA, OTP, and comparable prerequisite workflows adopt the same contract. Provider differences belong in adapters and workflow policies, not generic viewer heuristics.
22. The contract API is the only source of truth exposed to Assist. The UI does not scan arbitrary inputs or infer completion from generic viewer events.

## Testing Decisions

1. Test the shared host API and task-run lifecycle for contract creation, persistence association, version updates, waiting, success, retry, explicit failure, and force quit.
2. Test that operations from an old stage or contract version are rejected without browser input.
3. Test exact hits on declared targets versus nearby or unrelated context; only exact target hits may produce type or click actions.
4. Replace nearest-input fallback expectations with assertions that only declared, actually hit targets can open a type action.
5. Test initial centering and zoom around target plus context, and confirm pan/zoom does not create browser operations.
6. Test type, click, keyboard activation, and explicitly declared drag; reject undeclared modes.
7. Test Yuanta Bank exact CAPTCHA resolution and independent completion.
8. Test Yuanta Trade checkbox resolution, transition to modal stage, modal target resolution, and later completion.
9. Test inline verification: non-empty permits combined login submission, empty does not, and success depends on authentication outcome.
10. Test incorrect/incomplete resume, refreshed context, new contract version, stale-operation rejection, and provider/workflow retry limit.
11. Test that no click, type, drag, or generic interaction advances onboarding; only successful task outcome settles the gated step.
12. Test target/context resolution failure: remain waiting, disable Resume, send no unrestricted input, and recover only after valid update or force quit.
13. Test legacy runs without contracts cannot infer targets or continue.
14. Test persisted metadata is present while raw verification text and session screenshots are absent from records, logs, analytics, exports, and history.
15. Add end-to-end coverage for Yuanta Bank, Yuanta Trade, onboarding, and at least one additional CAPTCHA/OTP workflow. Assert observable behavior and outcomes rather than implementation-specific DOM heuristics.
16. Extend existing automation viewer, onboarding state, dashboard, task-run finalization, retry-stage, and provider workflow seams instead of duplicating production logic.

## Out of Scope

- Automatically solving CAPTCHA, OTP, image challenges, or verification modal content.
- OCR, machine-learning classification, or bypassing provider anti-automation controls.
- Unrestricted remote browser control.
- Persisting or exporting raw verification text, CAPTCHA screenshots, or focused challenge images.
- Changing provider retry limits or bypassing lockout, rate-limit, or authentication policy.
- Replacing the general automation viewer for non-human-assisted workflows.
- A broad visual redesign of the Automation Dashboard unrelated to verification focus and safety.
- Refactoring every workflow beyond publishing and honoring a contract.
- Guaranteeing that an external provider accepts a correct answer.
- Treating focus, interaction, or non-empty input as proof of independent completion.
- Supporting legacy waiting runs through inferred contracts or unrestricted fallback.

## Further Notes

The accepted domain decision is recorded in the structured human assistance contracts ADR, and the shared vocabulary is recorded in the project context glossary. This should be implemented as a cross-cutting protocol with provider adapters rather than as a Yuanta-only UI patch.

Existing viewer tests encode nearest-input fallback and must be revised. The existing onboarding interaction signal remains useful for presentation state but must not remain a progression gate.

A practical implementation sequence is:

1. Add the persisted contract model and shared host API.
2. Add server-side operation validation and version handling.
3. Constrain the viewer and implement target/context focus presentation.
4. Implement Yuanta Bank and Yuanta Trade adapters and staged completion.
5. Migrate other modelable CAPTCHA/OTP workflows.
6. Replace onboarding progression checks with task-outcome gating.
7. Add privacy, legacy-run, retry, resolution-failure, and end-to-end coverage.

The work may be decomposed into implementation tickets after acceptance, but every ticket must preserve finite target allowlists, explicit interaction modes, workflow-owned completion, version freshness, fail-safe resolution, and verification-data privacy.
