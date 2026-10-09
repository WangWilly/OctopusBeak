# TDCC e-Passbook through its mobile App protocol

Status: accepted

## Decision

TDCC e-Passbook (集保 e 存摺) is a shipped supported source that calls the e-Passbook mobile App's HTTP API directly, the way the TedLin1993/all-set-tw reference project does. It does not automate a web page. It runs as a non-browser workflow through the same typed runtime, queue, and Financial Commit port as MaiCoin ([ADR 0032](0032-app-owned-workflow-runtime.md)). The App's official name is 集保e手掌握 (formerly 集保 e 存摺).

The client reproduces the App's request envelope: `appInfo`, device ID, device type, `sequence`, a SHA-256 `signature` over the request body, a rotating `tokenID`, and AES-CBC encryption of sign-in fields under a key derived from the timestamp and device type. The App version, API version, and key-derivation rule are fixed in code. When TDCC rejects a request in a way that shows the protocol changed, the run fails with the typed reason `provider-protocol-outdated` and the fix ships in a new App release. There is no remote protocol configuration.

TDCC is an Intermediary source. Each reported broker securities account or bank settlement account is a Financial Account whose Institution is the maintaining broker or bank. The Source connection belongs to TDCC.

## Device trust

TDCC asks for a one-time code when a device it does not trust signs in. That code is entered during Source device registration, which is a sign-in settings action wherever TDCC Sign-in details are entered, in Settings and in onboarding Credential setup. It follows TDCC's sequence: Email OTP first, then SMS OTP when TDCC reports the mobile number as unverified. Registration is setup in the same category as Gmail OTP mailbox authorization, so it does not breach [ADR 0039](0039-solver-only-verification.md). The workflow never waits for a person. A run that finds the device untrusted fails with an actionable reason that points to registration.

The Phase 0 probe showed that TDCC trusts one device per person at a time. A sign-in from this App signs the e-Passbook phone App out, and signing in to the phone App again asks for a one-time code. A phone App sign-in in turn withdraws trust from this App's device, so the next run fails and the person registers again. Registration is therefore repeated, not once. A run reuses the saved session token where it can, because only a fresh sign-in signs the phone App out. In the probe a session stayed valid for at least 6.5 minutes and had expired by 30 minutes, but a phone App sign-in fell inside that window, so the expiry time is not yet known.

The device identity has a fixed common Android model, a random device ID, and the latest session token. It is an Authentication secret stored in the safeStorage-encrypted `credentials.json`. Password changes keep it, because they must not force another OTP. A change of Sign-in identifier resets it: the stored device records the identifier it was registered for, and a device registered for another identifier counts as unregistered. Gmail retrieval of TDCC codes is out of scope.

In the App, Electron main runs registration across IPC calls (`tdcc-registration-service.ts`). It keeps one registration between calls, passes each typed code straight to TDCC without storing it, and abandons a registration that waits more than ten minutes for a code. A device registered again keeps its device ID. The device identity and session are saved only after a fresh sign-in shows that TDCC trusts the device. A registration and a sync-tdcc run each sign in with the same device, so the host never runs them at once: one device lock (`tdcc-device-lock.ts`) refuses a registration while a run holds the device and refuses a run while a registration holds it.

## Session port

The sign-in details, the device identity, and the session token stay out of the workflow input and the child environment, like the Gmail refresh token. A TDCC run reaches them through a host-owned session port, `TdccSessionPort` in `src/workflows/tdcc-session.ts`. The worker sends its requests as frames, and Electron main answers them from `credentials.json` through `createTdccSessionHost`.

- `open()` returns the Source connection keys, the registered device, and the last saved session. It never returns the password. When no device is registered for the saved sign-in identifier, it returns `device-registration-required`.
- `signInDetails()` returns the sign-in identifier and password. A run asks for them only when TDCC no longer accepts the saved session.
- `saveSession()` is a one-way frame that the client sends on every token rotation. The host writes the newest rotation without acknowledging it, and it writes any pending rotation before the run settles, even after a failure, a cancellation, or a worker crash. The host saves a session only while the device the run leased is still the registered one, so a run that overlaps a new registration cannot overwrite the newer session.

Two other shapes were considered:

- **Host-owned client.** Electron main would hold the `TdccClient` and make every TDCC call, and the worker would ask for response bodies by endpoint. No secret would ever reach the worker. But every endpoint and every TDCC failure reason would need its own frame, the paging loops would move into main, and an account's TR002 history could exceed one frame. Main would also perform the network calls of a run.
- **Secrets in the workflow input.** The host would put the device, session, and password into the worker's start data and read the rotated token from the run result. It is the smallest change, but it puts every TDCC secret into the input of every run, and a run that fails or is cancelled returns no result, so the rotated token is lost.

The lease shape keeps the password out of a run that reuses its session and saves every rotation as it happens. It costs two request frames and one one-way frame.

## Rollout

Phase 0 is a development-only probe command. It reuses the production TDCC client and records a redacted field inventory of every endpoint (positions, funds, settlement balances and transactions, trades, asset trend) to a git-ignored local directory. It writes nothing to the canonical store and is not packaged. The probe reaches device trust through the registration action from the terminal, not through a workflow stage. Phase 1 admits each product only after the inventory settles its Source Contract and overlap handling. The first sync then collects all history TDCC offers and continues incrementally from its cursor.

## Considered options

- **Automate the TDCC web e-Passbook.** Rejected. It would match the other sources, where the page owns crypto and signing, but direct App calls are faster, need no browser, and are proven by all-set-tw across all five TDCC products.
- **Ship it as an off-by-default experiment.** Rejected. It ships as a normal supported source.
- **Enter the OTP mid-run, amending ADR 0039.** Rejected. It would restore the human path that ADR 0039 removed.
- **Read TDCC codes from Gmail.** Deferred. It would re-register automatically after each phone App use, but it brings along ADR 0014's Google verification status and still signs the phone App out. It is the first option to revisit if repeated registration proves too costly.
- **Automate the TDCC web e-Passbook to avoid the single trusted device.** Not investigated. Whether a web sign-in coexists with the phone App is unknown.
- **Make the protocol constants remotely configurable.** Rejected. That would only cover version bumps, and a change in the crypto rules still needs a release.

## Consequences

- Using TDCC here and in the phone App conflict. Each side's sign-in costs the other side a one-time code. The UI must say so when the person enables TDCC.

- A TDCC App update can break sync until an Octopus Beak release ships. The failure is a specific outcome, not a generic connection error.
- Impersonating the App may conflict with TDCC terms or trip its risk controls. This was accepted on purpose.
- TDCC reports holdings and settlement accounts that other sources also collect, such as Yuanta Trade and bank deposit workflows. Under [ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md) these stay separate, so overview totals can count them twice. Phase 1 must resolve this for each product before admission.
