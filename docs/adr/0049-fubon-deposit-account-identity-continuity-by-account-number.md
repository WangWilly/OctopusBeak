# Fubon deposit account identity continuity by account number

Status: accepted

## Context

The Fubon domestic-deposit source keys each account on `sha256(fubon-source-account-v2, option value)`, where the option value is the account selector's `NNN-00<14 digits>-CCY-NN`. When an account turns multi-currency, Fubon rewrites the currency code and also the `NNN` prefix, the `NN` suffix, or both. The same bank account then hashes to a new source account key and opens a second Financial Account with duplicated transactions and a second balance. A live database held three accounts for one 14-digit number.

The 14-digit account number is the stable identifier. [ADR 0021](0021-source-key-and-provider-account-number.md) already records it as versioned account-number evidence beside the opaque source account key. Every transaction's occurrence key and every balance capture key embeds the source account key, so a remap after derivation cannot prevent duplicates. Continuity has to be decided before the collector derives an identity.

## Decision

The Fubon contract continues an admitted account by its evidenced account number. Before deriving an identity for a statement capture that carries account-number evidence, the collector asks the store which admitted accounts in the same namespace, Source Connection, Identity Epoch, and `domestic-deposit` stream carry that number as a `depository-account` identifier observation. It asks once per number per run.

- No account carries it. The capture keeps the key derived from its raw option value, and later options for that number in the same run reuse that key.
- Exactly one account carries it. The capture admits under that account's source account key, so its transactions, occurrence keys, and current balance land on the existing account. Financial admission accepts a continued key only for a capture with account-number evidence.
- More than one account carries it. The collector fails closed for that account only. Its statements land as source-only evidence, the run reports an `account-identity-ambiguous` exclusion with the option shape and the account count, and no balance is captured for it. Other accounts collect normally.

The raw option value stays the hash input, exactly as every released build hashed it. A capture without account-number evidence derives its key as before and never reads continuity.

The read is the `financial.accountIdentity.continuity` RPC operation, served to workflows that declare `requiresAccountIdentity` in the same way as the TDCC fund-account read. It returns a source account key or a count, never an identifier value.

The Settings action that purged a superseded duplicate account is removed.

## Considered options

- **Rewrite the currency code to TWD before hashing.** Rejected. Fubon also rewrites `NNN` and `NN`, so the rewrite still splits accounts, and it changes the key of a USD-coded option already admitted under its raw hash.
- **Re-key every Fubon account to its account number.** Rejected. Every admitted identity would move, and the App has no mechanism to reset a connection's accounts. Looking the number up at collection time keeps every admitted key.
- **Remap to the existing account inside the store when the account is ensured.** Rejected. The transactions would already carry occurrence keys built from the new key and would still duplicate.
- **Pick one account when several match.** Rejected. Choosing among existing accounts is the identity repair that [ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md) rules out.
- **Keep the Settings purge for databases that already hold duplicates.** Rejected. Prevention replaces repair, and an in-app hard delete of financial lineage contradicts ADR 0008's contract-purge-and-recollect posture.

## Consequences

- An account whose option Fubon rewrites keeps one Financial Account, one transaction history, and one current balance.
- On a fresh database the first option seen for a number fixes that account's key, whichever currency code it carried.
- A database that already holds duplicate accounts for a number stops collecting financial data for that account. Each run excludes it as `account-identity-ambiguous` until the owner rebuilds the database. Nothing is deleted.
- Continuity is part of the Fubon contract's key derivation. It never merges, relinks, or rewrites an admitted account.
