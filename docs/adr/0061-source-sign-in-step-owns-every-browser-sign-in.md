# One Source sign-in step owns every browser sign-in

Status: accepted

Applies the division of [ADR 0060](0060-product-collection-run-owns-every-verified-product-outcome.md) to sign-in: a workflow supplies the page mechanics, and one shared module owns the policy. It builds on [ADR 0059](0059-run-event-outcome-and-signal.md) for run event signals and [ADR 0015](0015-bounded-captcha-retry-campaigns.md) for CAPTCHA retry triggers.

## Context

Ten browser sources signed in through seven hand-written sequences, and the copies had drifted:

- Six sources confirmed a provider prompt that signs the person out of their other session: SinoPac, Yuanta Bank, Fubon, CTBC, E.SUN and Cathay. Only SinoPac disclosed a Session Takeover in sign-in settings.
- Dialog handling took five forms. SinoPac and Post dismissed dialogs during the sign-in attempt only. Yuanta Bank accepted and classified them while signing in. Yuanta Trade, CTBC, E.SUN and Cathay accepted every dialog for the life of the page. Fubon kept its own fence. HNCB and LINE Bank registered no listener.
- Only Post emitted the `login-dialog-interrupted` signal. The same interruption on SinoPac classified as `authentication-failed`, which tells people to check their sign-in details.
- Several waits ignored cancellation. A cancelled HNCB run could keep waiting for up to 120 seconds.
- Whether a workflow owned its CAPTCHA submission outcome was a flag, kept in step by hand with the rejection evidence the workflow parsed.
- Five product collections had no session check, and nothing showed the omission.

Shared helpers had begun to spread piece by piece. `signInAttempt` served only SinoPac and Post.

## Decision

**A browser source signs in through one Source sign-in step.**

- The workflow supplies a plan:
  - how to tell it is signed in;
  - how to fill the form;
  - an optional CAPTCHA Verification Stage and its answer field;
  - how to submit;
  - the routine prompts it clears;
  - its dialog policy, its session probe and its deadline.
- The step owns:
  - the order of those steps and the authentication run events;
  - one dialog listener, its lifetime and the classification of every dialog;
  - the polling, the deadline and cancellation through the run's own signal;
  - the terminal failure event and its typed error;
  - the session check the Product Collection Run uses.

Fubon and Yuanta Trade keep their inner sign-in and use only the step's shell: the event bracket, cancellation, the dialog listener and the takeover rule.

**A takeover prompt lives beside its disclosure.**

- The Verified Source definition declares `sessionTakeover: { notice, prompt? }`. The prompt records the phase in which it appears: before submit, or while sign-in settles.
- A prompt cannot be declared without its notice, and plans have no takeover field. The step can therefore confirm only a prompt that the source discloses.
- The step confirms a takeover at most once. A second takeover prompt ends sign-in with the `login-dialog-interrupted` signal.

**Rejection evidence is declared, and outcome ownership follows from it.**

- `verification.rejection` names the dialog or on-page text that proves the provider rejected a CAPTCHA answer.
- The step turns that evidence into `CaptchaProviderRejectedError`, the CAPTCHA Retry Trigger.
- The host treats the workflow as owning its submission outcome exactly when that evidence is declared.

**Every dialog has an explicit policy.** The step checks a dialog in this order: the declared takeover, then the declared rejection, then the plan's policy. The policy is one of:

- an observer;
- `fail`: dismiss and signal `login-dialog-interrupted`;
- `dismiss`;
- `accept`;
- `accept-for-page`.

Each source keeps the behavior it had, now written down in one place.

**The session check is required.** A plan declares a session probe, or `none` with a reason. Post, Yuanta Trade, CTBC, E.SUN and LINE Bank declare `none` until a live check proves a marker that holds on every collection page.

## Considered options

- **Fix the defects source by source.** Rejected. The defects came from drift, and the earlier fixes had already been copied by hand between two sources.
- **A declarative table of page observations on the Verified Source definition.** Rejected as the base design.
  - Its prompt vocabulary becomes the interface every source author must learn, and it grows with each unusual page.
  - It moves prompts that only the workflow needs into data the main process loads.
  - Two ideas were kept from it: the typed prompt description, and the takeover phase.
- **Named phase callbacks.** Rejected.
  - About fourteen hooks mirrored each source's existing steps, and several existed for a single source.
  - A hook that replaced the wait loop let a source bypass the step's policy.
- **Fold Fubon and Yuanta Trade fully into the step.** Rejected for now. Their steps would widen the plan for every other source:
  - Fubon: the at-most-once takeover fence, the generation-fenced submit and the on-page rejection text;
  - Yuanta Trade: the ServiSign and certificate steps.
- **Stop confirming takeover prompts and fail with a User-action Failure.** Rejected. Scheduled collection would fail whenever the person's phone App was signed in.

## Consequences

- Six sources now show a Session Takeover disclosure in sign-in settings, not one.
- `signInAttempt` and each source's own dialog code are removed. The step's check runs against real Chromium pages.
- These failures now classify as `authentication-dialog-interrupted`:
  - an unclassified dialog on SinoPac;
  - a repeated takeover prompt on any source.
- A sign-in deadline classifies as `authentication-timeout`. Neither this nor `authentication-dialog-interrupted` tells the person to check their sign-in details.
- A plan's signed-in probe may end sign-in with a typed error. SinoPac's generic error page therefore classifies as `source-unavailable` instead of `authentication-failed`.
- HNCB and LINE Bank still dismiss unknown dialogs. Moving them to `fail` needs live evidence.
- The checks use fixture pages, so each migrated source needs a live sync before release.
