# No shared domestic deposit admission module

Status: rejected

## Decision

The six bank deposit admissions (CTBC, Post, HNCB, Yuanta, Fubon, and SinoPac domestic) stay separate modules. They share only `canonicalDigest`, the SHA-256 domain digest every one of them already computed byte for byte. A shared admission module with one Deposit Source Adapter per bank, and typed commit submissions in place of the PGlite commands workflows build, were both proposed and rejected after reading all six banks.

The banks looked alike from outside: 750 to 2,100 lines each, the same four stage names, and repeated helper names. Inside, the parts a shared module would own differ per bank, and most of them are identity formulas that [ADR 0035](0035-source-contract-catalog-and-rule-admission.md) freezes:

- **Occurrence key fields.** CTBC and Post hash description and note. Yuanta adds a check number. HNCB adds depositor and reference. SinoPac hashes three raw columns. Fubon hashes the fence and the content hash.
- **Fence fields.** Fubon also includes the attestation ID, evidence version, currency, and a combined date-time.
- **Record body.** The compact JSON uses `subjectDigest` or `accountDigest`, carries different extra digests, and SinoPac serializes it with a stable key order. `effectiveOn` is the accounting date for CTBC and Post but the transaction date for HNCB and SinoPac. Occurrence groups partition by `effectiveOn` for CTBC, by the local transaction date for Post and HNCB, and by the accounting date for Yuanta.
- **Capture semantics.** SinoPac's effective time is the transaction time at minute precision. The others use the accounting date at second precision. HNCB, Yuanta, and Fubon carry their semantics in their own objects.
- **Orchestration.** CTBC, Post, HNCB, and SinoPac run their stages inline. Yuanta and Fubon run through `collectSelectedProducts`, with different event codes that runtime suffix regexes and the dashboard consume.

An adapter would have to pass every one of these as a parameter. Its interface would be as wide as the code it replaced, so deleting the module would only move that code back into each bank.

## Considered options

- **A shared admission module with a Deposit Source Adapter per bank.** Rejected for the reasons above.
- **Typed commit submissions, with the commit choosing the command, the atomic grouping, and the order.** Rejected. The commit cannot choose the grouping, because Cathay deliberately commits all of one run's domestic statements as one atomic item and only the workflow knows that. It cannot choose the command either. A mixed commit with one step is not equivalent to that step's own command: the direct commit turns a database error into a typed admission error that the run records as an item failure, while the mixed commit lets the error propagate as a fatal run failure. Every other kind maps one-to-one to its command, so the submission type would only rename commands across twenty workflows.
- **Relation commands as a list built with the item, instead of a callback after commit.** Rejected. Building Yuanta's loan relation evidence can throw for a complete account with no records in range. Inside the post-commit callback, that becomes a relation warning and the loan still commits. Built with the item, it fails the whole run.

## Consequences

- Golden checks under `src/workflows/deposit-commit-goldens/` record what each of the six banks hands to the Canonical Financial Commit, including its progress events. A change to any bank's admission is checked against them, and `UPDATE_DEPOSIT_GOLDENS=1` rewrites a golden only when the change is intended.
- A bug in one bank's admission is fixed in that bank. Before copying a fix to another bank, check that bank's formula, because the formulas differ on purpose.
- Revisit this decision only if several banks move to one provider-independent record formula. That would itself need a new identity epoch and a purge-and-recollect under ADR 0035.
