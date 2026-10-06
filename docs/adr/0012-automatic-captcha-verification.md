# Automatic CAPTCHA verification (solve + judge)

Status: accepted; human actor superseded by [ADR 0039](0039-solver-only-verification.md)

ADR 0039 removed the development-only `human` Verification Actor, its `LIBRETTO_CLOUD_*_VERIFICATION_ACTOR` overrides, and Assist. `solver` is the only actor, in every build. The text below records the original two-actor decision. Its solver rules, the confidence threshold, privacy, and fail-closed behavior remain in force.

The first version solves CAPTCHA verification automatically in addition to the existing human assistance path: a workflow still declares one verification challenge, but a `solver` Verification Actor — a local OCR or speech model run by the automation host — reads challenge media and returns an answer with a confidence score, which the host injects via CDP when it meets the challenge's threshold. The two actors are mutually exclusive within one run: a solver run never falls back to human assistance, and the actor is chosen per supported source. The user-facing App always uses `solver`, ignoring persisted or environment-provided `human` overrides in packaged builds. Only an unpackaged development build may select `human`, using a per-source process environment variable such as `LIBRETTO_CLOUD_CATHAY_VERIFICATION_ACTOR=human`; persisted settings cannot enable manual verification. ADR 0015 governs the bounded ten-round campaign after same-media solve attempts are exhausted. Declared text and audio CAPTCHAs are solved automatically; image-selection requires an explicitly supported local vision engine, and Yuanta Trade uses audio instead of its unsupported image challenge (ADR 0019). A checkbox is an ordinary declared click, not a solver task. "Judging" means detecting whether the challenge actually appears, while final correctness remains the login outcome.

## Considered Options

- **Solver-first with automatic human fallback** — rejected because the user chose strict separation: mixing both actors in one run would blur the completion condition and make "who decides success" ambiguous.
- **Remote/third-party solver first** — rejected for the first version because it ships challenge images off-device, cutting against the local-first financial data boundary; the solver seam is left pluggable so a remote solver can be added later behind explicit consent and de-identified images.
- **Workflow-side solver (OCR inside the `libretto` process)** — rejected because the product's local vision model lives in the Electron host; declaring the challenge to the host matches the existing "workflow emits, host executes" contract architecture.
- **No confidence threshold (trust the login result alone)** — rejected because a low-probability solve would still be submitted, increasing lockout risk; the threshold gates submission.

## Consequences

- Reverses the "Out of Scope: automatically solving CAPTCHA, OCR, ML classification, bypassing anti-automation controls" line in `docs/specs/structured-human-assistance-contracts.md` (ADR 0003).
- The glossary generalizes `human verification …` terms to actor-neutral `verification …` terms and adds `verification actor`, `verification solver`, `solve confidence`, `solve attempt`, and `verification challenge presence`.
- Challenge confidence thresholds remain operational configuration. Actor selection is a host-enforced runtime policy: automatic in the user-facing App, with per-source environment overrides only in development. Existing saved human selections do not grant manual access.
- Automatic verification exposes progress and cancellation, but no Assist entry in Automation. Missing setup, unsupported challenges, or exhausted bounded retries end the run with a specific reason and relevant setup guidance instead of waiting for human verification.
- Local solver answers and challenge images remain session-memory-only; a future remote solver is gated by consent and de-identified image transfer.
