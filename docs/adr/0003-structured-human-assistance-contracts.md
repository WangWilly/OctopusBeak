# Structured human assistance contracts for verification workflows

Status: accepted

## Decision

Every workflow that waits for human assistance must create a persisted `human assistance contract` through a shared host API. The contract is the only source of truth for what the Assist may show and do while a task run is waiting for a person.

A contract is versioned within the waiting task run and contains:

- one `human interaction stage` at a time;
- an allowlist of `human verification target` descriptors;
- provider-owned semantic identities and current geometry for those targets;
- a `verification context region` for the challenge information that must remain visible;
- an explicit `verification interaction mode` for each target;
- the `verification completion` rule; and
- the current contract version used to reject stale interactions.

Provider verification adapters resolve provider-specific frames, controls, challenge regions, and completion signals. The generic viewer does not scan arbitrary page inputs, infer the nearest input, or derive interaction rules from screenshots or log text.

Assist starts in a `verification focus view` centered on the declared target and context. A person may pan or zoom the presentation, but only declared targets can generate browser operations. Keyboard paths are required where possible; pointer-only drag targets require explicit declaration.

Independent verification must be confirmed by the workflow or host before Resume is enabled. For inline verification submitted with login information, a non-empty declared field is the available pre-submit condition; the workflow's login result remains the final correctness check. Onboarding progression is gated by successful task completion rather than local Assist interaction state.

If verification is incomplete or incorrect after Resume, the resumed run may return to `waiting_for_human` with refreshed challenge context and a new contract version, subject to workflow or provider retry limits. An exhausted verification becomes an explicit task failure.

Contract resolution failures, stale contract versions, legacy waiting runs without a contract, and new waiting states that omit a contract are fail-safe: no unrestricted viewer interaction and no Resume. Recovery requires a contract update or, for legacy runs, force-quit followed by a new workflow run.

Raw verification text and challenge screenshots remain session-memory-only. They are not written to the contract, task logs, analytics, exports, or other persistent records. Persisted records retain only target, operation, outcome, timing, and contract metadata.

## Context

The existing Assist used a generic screenshot viewer. It inspected the click point, then fell back to the nearest text input within a broad distance tolerance. This could open a floating input when the person clicked outside an input. It also represented progress with a generic `assistInteracted` flag, allowing a successful non-input click or drag to unlock Resume without proving that the required CAPTCHA or verification flow was complete.

The workflows have provider-specific human steps: Yuanta bank uses an inline CAPTCHA input, while Yuanta Trade can require a CAPTCHA checkbox followed by a verification modal. Other providers may use OTP, CAPTCHA, or another human-controlled verification surface. A generic DOM heuristic cannot safely express these differences.

## Consequences

- The automation server and task-run persistence must store contract versions and expose the current contract to the desktop UI.
- Workflows need provider verification adapters and a shared host API for creating and updating contracts.
- The viewer becomes a constrained presentation and input surface rather than a general browser remote-control surface.
- Existing waiting runs without contracts require an explicit recovery path instead of compatibility inference from logs.
- Verification retry and provider-specific completion signals become part of each workflow's contract.
- The implementation needs regression coverage for exact target containment, stale versions, stage transitions, onboarding gating, retry re-entry, and privacy boundaries.
