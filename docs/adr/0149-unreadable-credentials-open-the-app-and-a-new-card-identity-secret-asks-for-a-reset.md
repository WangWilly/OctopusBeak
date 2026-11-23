# Unreadable credentials open the App, and a new Card identity secret asks for a reset

Status: accepted

Amends [ADR 0062](./0062-credit-card-query-inventory-and-user-triggered-reset.md): a Canonical Reset is now also how a person leaves card accounts derived from an earlier Card identity secret.

`credentials.json` holds two kinds of value under one safeStorage envelope. One kind is the Sign-in Details a person types. The other is the Card identity secret the App creates once, which Fubon, E.SUN and Yuanta workflows use to derive opaque card identities. Two failures followed from that:

- Startup decrypted the envelope before opening anything else. If the Keychain could no longer decrypt it (a reset Keychain, a new Mac, a re-signed build), or the file was not JSON, the App showed a stack trace and quit on every launch. The person could still recover by deleting the file by hand.
- With no secret in the file, startup created a new one without checking anything. Every later card sync then derived new identities and admitted each card as a second account beside the old one. Sign-in Erasure keeps the secret for exactly this reason, but a missing file was not guarded.

**Credentials that cannot be read no longer stop the App.** Startup logs `automation-credentials-unreadable` and leaves the file untouched. The ledger opens, and every credential reads as failed. Clearing Sign-in Details from Settings replaces an unreadable file instead of failing on it. That is the recovery path: it also replaces the secret, which can no longer be read anyway.

**The ledger records which Card identity secret its card accounts came from.**

- After the App provisions the secret at startup or after Sign-in Erasure, it writes `card-identity-verifier` beside `credentials.json`. The file holds a SHA-256 verifier of the secret, never the secret, because the PGlite worker reads it.
- The ledger keeps its own verifier in `card_identity_secret`. A card commit records the current verifier when the ledger has none yet, or when it holds no credit-card account.
- When the verifiers differ and an integration namespace holds credit-card accounts, a card capture in that namespace is refused as `canonical-reset-required`, and `financial.canonical.resetRequired` names the namespace. The source row then asks for "Delete all collected financial data", as it does for a superseded identity epoch.
- A namespace with no card account commits under the new secret.
- After a Canonical Reset no card account remains, so the next card commit adopts the new verifier.
- An absent or damaged verifier file means "unknown", and the ledger changes nothing. Startup writes the file again.

## Considered options

- **Store the Card identity secret outside `credentials.json`.** Rejected. It must stay encrypted, because with it and the ledger a card number's fingerprint could be brute-forced. A second file under the same Keychain key fails in the same cases.
- **Keep accepting the split.** Rejected. Duplicated cards double every card balance and spending total, and nothing tells the person why.
- **Derive the identity epoch from the secret.** Rejected. Every existing install's epoch would change at once and require a Canonical Reset.
- **Let saving one credential overwrite an unreadable file.** Rejected for now. It would also drop the unreadable secret as a side effect of an unrelated edit.

## Consequences

- The first card commit after upgrade records the verifier of whichever secret is current. A split that happened before this change is not detected.
- Restoring an older `credentials.json` whose secret differs from the ledger's also asks for a Canonical Reset.
- The Automation page shows "Read failed" on each credential, but nothing on it yet points the person to Settings.
