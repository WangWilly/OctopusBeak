# Unreadable credentials open the App, and a new Card identity secret asks for a reset

Status: accepted

Amends [ADR 0062](./0062-credit-card-query-inventory-and-user-triggered-reset.md): a Canonical Reset is now also how a person leaves card accounts derived from an earlier Card identity secret.

`credentials.json` holds two kinds of value under one safeStorage envelope. One kind is the Sign-in Details a person types. The other is the Card identity secret the App creates once, which Fubon, E.SUN and Yuanta workflows use to derive opaque card identities. Two failures followed from that:

- Startup decrypted the envelope before opening anything else. If the Keychain could no longer decrypt it (a reset Keychain, a new Mac, a re-signed build), or the file was not JSON, the App showed a stack trace and quit on every launch. The person could still recover by deleting the file by hand.
- With no secret in the file, startup created a new one without checking anything. Every later card sync then derived new identities and admitted each card as a second account beside the old one. Sign-in Erasure keeps the secret for exactly this reason, but a missing file was not guarded.

**Credentials that cannot be read no longer stop the App.** Startup logs the failure and leaves the file untouched. The ledger opens, and every credential reads as failed. A legacy `.env` still migrates its settings; its credential lines wait for a later start. Clearing Sign-in Details from Settings replaces a file that cannot be decoded, which is the recovery path: it also replaces the secret, which can no longer be read anyway. A file that cannot be reached at all, such as one the App may not open, is left alone and the clear fails. Startup still stops when safeStorage cannot encrypt at all, since no credential could be stored.

**The ledger records which Card identity secret each namespace's card accounts came from.**

- Provisioning the secret, at startup and after Sign-in Erasure, writes `card-identity-verifier.json` beside `credentials.json`. It holds a SHA-256 verifier of the secret, never the secret, because the PGlite worker reads it. It also says whether this install created the secret or found it already in `credentials.json`.
- The ledger keeps one verifier per integration namespace in `card_identity_secrets`.
- A namespace **splits** when it holds credit-card accounts and they came from another secret. Either its record names another verifier, or it has no record and this install created the current secret. A secret created here cannot be the one those accounts came from.
- A card capture in a namespace that splits is refused as `canonical-reset-required`, and `financial.canonical.resetRequired` names the namespace. The source row then asks for "Delete all collected financial data", as it does for a superseded identity epoch.
- Any other card commit records the current verifier for its namespace. That covers a namespace with no card account, and one with no record whose secret was found in place, as on an install upgrading to this change.
- A Canonical Reset removes every card account and every record.
- A missing or damaged verifier file reads as unknown, and the ledger admits and records nothing. Provisioning writes the file again.

## Considered options

- **Store the Card identity secret outside `credentials.json`.** Rejected. It must stay encrypted, because with it and the ledger a card number's fingerprint could be brute-forced. A second file under the same Keychain key fails in the same cases.
- **Keep accepting the split.** Rejected. Duplicated cards double every card balance and spending total, and nothing tells the person why.
- **Derive the identity epoch from the secret.** Rejected. Every existing install's epoch would change at once and require a Canonical Reset.
- **Let saving one credential overwrite an unreadable file.** Rejected for now. It would also drop the unreadable secret as a side effect of an unrelated edit.

## Consequences

- An install that upgrades with its secret in place records it at its first card commit. A split that happened before this change is not detected.
- Restoring an older `credentials.json` whose secret differs from a namespace's record asks that namespace for a Canonical Reset, once the App provisions it at the next start.
- Clearing Sign-in Details while they cannot be decoded asks every namespace with card accounts for a Canonical Reset. Nothing warns the person beforehand yet.
- The verifier file changes only at startup and at Sign-in Erasure. A `credentials.json` replaced by hand while the App runs is compared against the old verifier until the next start.
- Sign-in Erasure also removes credential lines from a legacy `.env`, so they cannot migrate back.
- Whether this install created the secret lives only in the verifier file. If that file is lost after an Erasure and before the first card commit, the next start records the secret as found, and a namespace with card accounts and no record adopts it.
- A card commit that reads the verifier file as unknown admits and records nothing. On an install that created its secret, the namespace then reads as split at its next commit.
- The Automation page shows "Read failed" on each credential, but nothing on it yet points the person to Settings.
