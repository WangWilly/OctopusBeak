# Automatic CAPTCHA verification (solve + judge)

Status: accepted

The first version solves CAPTCHA verification automatically in addition to the existing human assistance path: a workflow still declares one verification challenge, but a `solver` Verification Actor — a local OCR or vision model run by the automation host — reads the challenge image and returns an answer with a confidence score, which the host injects via CDP when it meets the challenge's threshold. The two actors are mutually exclusive within one run: a solver run never falls back to human assistance, exhausting the fixed three-attempt limit finalizes the run as failed, and the actor is chosen per supported source with `human` as the default. Only text CAPTCHA and image-selection challenges are solved automatically (a checkbox is an ordinary declared click, not a solver task); "judging" means detecting whether the challenge actually appears, while final correctness remains the login outcome.

## Considered Options

- **Solver-first with automatic human fallback** — rejected because the user chose strict separation: mixing both actors in one run would blur the completion condition and make "who decides success" ambiguous.
- **Remote/third-party solver first** — rejected for the first version because it ships challenge images off-device, cutting against the local-first financial data boundary; the solver seam is left pluggable so a remote solver can be added later behind explicit consent and de-identified images.
- **Workflow-side solver (OCR inside the `libretto` process)** — rejected because the product's local vision model lives in the Electron host; declaring the challenge to the host matches the existing "workflow emits, host executes" contract architecture.
- **No confidence threshold (trust the login result alone)** — rejected because a low-probability solve would still be submitted, increasing lockout risk; the threshold gates submission.

## Consequences

- Reverses the "Out of Scope: automatically solving CAPTCHA, OCR, ML classification, bypassing anti-automation controls" line in `docs/specs/structured-human-assistance-contracts.md` (ADR 0003).
- The glossary generalizes `human verification …` terms to actor-neutral `verification …` terms and adds `verification actor`, `verification solver`, `solve confidence`, `solve attempt`, and `verification challenge presence`.
- Per-source actor selection and the challenge confidence threshold become persisted operational configuration; the automation host gains a solver adapter seam alongside the existing provider verification adapter.
- Local solver answers and challenge images remain session-memory-only; a future remote solver is gated by consent and de-identified image transfer.
