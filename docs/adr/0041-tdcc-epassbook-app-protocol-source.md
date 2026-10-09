# TDCC e-Passbook through its mobile App protocol

Status: accepted

## Decision

TDCC e-Passbook (集保 e 存摺) is a shipped supported source that calls the e-Passbook mobile App's HTTP API directly, the way the TedLin1993/all-set-tw reference project does. It does not automate a web page. It runs as a non-browser workflow through the same typed runtime, queue, and Financial Commit port as MaiCoin ([ADR 0032](0032-app-owned-workflow-runtime.md)).

The client reproduces the App's request envelope: `appInfo`, device ID, device type, `sequence`, a SHA-256 `signature` over the request body, a rotating `tokenID`, and AES-CBC encryption of sign-in fields under a key derived from the timestamp and device type. The App version, API version, and key-derivation rule are fixed in code. When TDCC rejects a request in a way that shows the protocol changed, the run fails with the typed reason `provider-protocol-outdated` and the fix ships in a new App release. There is no remote protocol configuration.

TDCC is an Intermediary source. Each reported broker securities account or bank settlement account is a Financial Account whose Institution is the maintaining broker or bank. The Source connection belongs to TDCC.

## Device trust

TDCC asks for a one-time code when a device it does not trust signs in. That code is entered during Source device registration, which is a sign-in settings action wherever TDCC Sign-in details are entered, in Settings and in onboarding Credential setup. It follows TDCC's sequence: Email OTP first, then SMS OTP when TDCC reports the mobile number as unverified. Registration is setup in the same category as Gmail OTP mailbox authorization, so it does not breach [ADR 0039](0039-solver-only-verification.md). The workflow never waits for a person. A run that finds the device untrusted fails with an actionable reason that points to registration.

The device identity has a fixed common Android model, a random device ID, and the latest session token. It is an Authentication secret stored in the safeStorage-encrypted `credentials.json`. Password changes keep it, because they must not force another OTP. A change of Sign-in identifier resets it. Gmail retrieval of TDCC codes is out of scope.

## Rollout

Phase 0 is a development-only probe command. It reuses the production TDCC client and records a redacted field inventory of every endpoint (positions, funds, settlement balances and transactions, trades, asset trend) to a git-ignored local directory. It writes nothing to the canonical store and is not packaged. The probe reaches device trust through the registration action from the terminal, not through a workflow stage. Phase 1 admits each product only after the inventory settles its Source Contract and overlap handling. The first sync then collects all history TDCC offers and continues incrementally from its cursor.

## Considered options

- **Automate the TDCC web e-Passbook.** Rejected. It would match the other sources, where the page owns crypto and signing, but direct App calls are faster, need no browser, and are proven by all-set-tw across all five TDCC products.
- **Ship it as an off-by-default experiment.** Rejected. It ships as a normal supported source.
- **Enter the OTP mid-run, amending ADR 0039.** Rejected. It would restore the human path that ADR 0039 removed.
- **Read TDCC codes from Gmail.** Deferred. Registration happens once, and Gmail would bring along ADR 0014's Google verification status.
- **Make the protocol constants remotely configurable.** Rejected. That would only cover version bumps, and a change in the crypto rules still needs a release.

## Consequences

- A TDCC App update can break sync until an Octopus Beak release ships. The failure is a specific outcome, not a generic connection error.
- Impersonating the App may conflict with TDCC terms or trip its risk controls. This was accepted on purpose.
- TDCC reports holdings and settlement accounts that other sources also collect, such as Yuanta Trade and bank deposit workflows. Under [ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md) these stay separate, so overview totals can count them twice. Phase 1 must resolve this for each product before admission.
