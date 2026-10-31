# Union Bank New New Bank speaks the App protocol

Status: accepted

Builds on [ADR 0041](0041-tdcc-epassbook-app-protocol-source.md) (a source reached through its mobile App protocol) and [ADR 0047](0047-preview-sources-outside-canonical-admission.md) (Preview sources). The protocol shape was learned from the MIT-licensed [all-set-tw](https://github.com/TedLin1993/all-set-tw) `ubot` connector; no code is copied from it.

New New Bank (聯邦銀行, Institution `bank-803`) is an App-only digital account. It has no web bank to drive with a browser, so **the Preview source talks to the Android App's JSON API over `node-http`**, the same transport class as OBank's Preview source.

- **Device identity.** On first connection the App generates a random 64-hex device UUID and keeps it with the Source connection for every later run. It is never derived from the person's national ID, because a derived value would encode identity data in an identifier sent on every request. A first sign-in from the new device that the bank answers with `NS090`, or with a KYC or profile-update flag, ends the run as "complete this in the New New Bank App" and is not retried.
- **App version.** The `appVer`, device model and OS version the source presents are one constant owned by the source definition. When the bank refuses that version, the run fails with one explicit classification ("source protocol needs an update") that an Error report carries. The source never retries with a guessed newer version.
- **Encryption.** The sign-in body is encrypted the way the App does it (RSA-encrypted password, AES-128-OFB body with an RSA-wrapped IV), using Node's `crypto`. Only sign-in is encrypted.
- **Not live-verified.** Nobody on the project holds a New New Bank account, so the first version is built from the protocol description and synthetic fixtures and ships only as a Preview source. It needs a live probe before [Preview source promotion](../../CONTEXT.md).

## Considered options

- **Drive a browser.** Rejected: there is no web bank for this account type.
- **Derive the device UUID from the national ID** (all-set-tw's fallback). Rejected for the reason above; a persisted random UUID is just as stable.
- **Track the current App version automatically.** Rejected. Guessing a version the bank has not seen from this device is more likely to trigger a security review than a deliberate update.

## Consequences

- The source is a deliberately fragile contract: a forced App update breaks it until someone updates the constant. The explicit classification makes that visible instead of looking like a credential failure.
- Losing the stored device UUID (for example a reset Source connection) makes the next sign-in look like a new device and may require verification in the App again.
