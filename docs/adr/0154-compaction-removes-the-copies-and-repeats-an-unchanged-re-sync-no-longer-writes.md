# Compaction removes the copies and repeats an unchanged re-sync no longer writes

Status: accepted

Amends [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md) and [ADR 0152](./0152-an-unchanged-re-sync-reuses-stored-source-records.md).

ADR 0152 stopped an unchanged re-sync from writing a record copy, a domain row or a count row that says nothing new. It left the rows written before it in place. On a real store of 1.6 GB, the dry run (`npm run ledger:compaction-plan`) counts:

| Phase | Rows removable | About |
|---|---|---|
| A, domain rows | card details and card lifecycle: 22,156 of 22,586 each; instrument evidence: 318 of 325; statement summary: 1,333 of 1,356; security names: 1,227 of 1,248; account identifiers: 3,007 of 3,045; e-invoice observations and events: 19,216 of 19,529 each | 28 MB |
| B, record copies | 151,187 of 169,770 | 458 MB |
| C, count rows | 53,295 of 54,180 | 19 MB |

ADR 0008 keeps lineage append-only. Its hard deletes are the Contract Purge and the one-time Kind cleanup of [ADR 0144](./0144-a-store-removes-derived-kinds-a-refresh-wrote-again-unchanged.md). **This ADR adds a third hard delete: compaction removes the record copies, domain rows and count rows that the ADR 0152 writers would not have written, and keeps every answer a reader gives.**

## The owner's decisions

- **Trigger.** A manual "Compact ledger" action in Settings. It first shows the dry run's estimate of the space it would free, then the progress per source. It never runs in the open path. An automatic run may be considered later.
- **Backup.** Off by default. Settings offers "back up first" only when the free disk space is at least the size of the store. The verification below, inside the transaction, is the safety net.
- **E-invoice lineage.** Compacted. The lineage view lists fewer observations and events: it shows when an invoice's observed revisions changed, as ADR 0152 now writes it, not every capture that saw them. No UI reads those lists.
- **On failure.** The compaction rolls back and keeps every row. The failure is recorded and shown in Settings, and the compaction is not retried automatically, as in ADR 0144.
- **Deferred.** Loan and investment copies that differ only in a positional sequence lexeme are treated as different content. Captures that already have a manifest are skipped. A later pass may compact both.

## Target state

The target is the store the ADR 0152 writers would have produced. In every table, the first row of each run of equal values, in the reader's own order, is kept, and its repeats are removed. Keeping the first, not the last, keeps the answer at every earlier knowledge point, for the reason ADR 0144 gives.

### Phase A: domain rows

Each table compares the columns its ADR 0152 writer compares. The dry run (`compaction-plan.ts`, `PHASE_A`) and the compaction select the rows with the same queries.

| Table | Run key | Compared | Order |
|---|---|---|---|
| card transaction details | transaction | revision, instrument, billing status, consume date, posting date, effective date basis, statement key | commit sequence, record id |
| card transaction lifecycle | namespace, account, transaction | revision, instrument, billing status, statement key | commit sequence, lifecycle event id |
| card instrument evidence | instrument | the evidence record's occurrence key | commit sequence, record id |
| card statement summary evidence | statement | statement revision, evidence key | commit sequence, record id |
| security name observations | security | name, contract version | commit sequence, capture id |
| transaction relation provenance | relation | evidence record key, relation id, contract version | commit sequence, record id |
| account identifier observations | account, kind, value, evidence version, source field | (the first row is kept) | commit sequence, observation id |
| e-invoice observations and events | invoice and observing commit | the set of revisions the commit observed | commit sequence |

An observing commit of an invoice repeats when it observed the same revisions as the observing commit before it, created none of them, and wrote only `observed` events for the invoice. Its observations and events are removed.

Phase A runs first, because the rows it keeps decide which record copies are still cited.

### Phase B: record copies

Copies of one record (subject, record kind and occurrence key) are ordered by commit sequence. A copy is removed when nothing cites it after phase A, no manifest lists it, its capture has no manifest yet, and it equals the copy before it. Equal covers every stored column except the ids, the owner capture's coverage shape for its scope key, its scope row's account and subject, and the set of assertions it backs. The tables that cite a record are read from `pg_constraint`, and a citing column the compaction does not know makes it refuse. The removed copy's capture gets a manifest that lists the nearest earlier kept copy, so per-capture membership stays exact.

### Phase C: count rows

In each partition (subject, record kind, scope key, contract version, date and fingerprint), a count row is kept only when it raises the maximum stored before it. The member-loss guard and the count writer read only that maximum.

### Never touched

Captures, scopes, pages, coverages, commits, revisions, assertions, transitions, holdings and balances. A holding or balance observation cites its own record, and its key is new on every sync (ADR 0008, ADR 0042).

## Safety

- **One verified transaction.** Before deleting, the compaction reads every reader the removed rows feed and takes a SHA-256 digest of its rows, sorted as text. After deleting, it reads them again. Any difference throws, and the transaction rolls back. The digests are exact; the prototype's sums of 60-bit hashes are not used. The readers:
  - card details, latest by revision (`latestCardDetailsByRevisionSql`) and latest by transaction (the card command);
  - card details, the distinct revision and consume date pairs the spending date match reads;
  - card lifecycle, latest by transaction (`listLatestLifecycle`) and by namespace, account and transaction (the card command);
  - instrument evidence and statement summary evidence, latest;
  - security names at every knowledge point (the overview and the investment command);
  - relation provenance, latest (the loan command);
  - account identifiers, the distinct set (account identity continuity, ADR 0049);
  - e-invoices, each invoice's latest observed revisions and the revisions that have an observation (`provenanceComplete`);
  - count rows, the maximum of each partition.

  Each delete must also remove exactly the rows that were selected.
- **Triggers and foreign keys.** The deletes run with `SET LOCAL session_replication_role = replica`, as ADR 0144 does, and with the purge guard setting on. This skips the per-row foreign-key checks, the append-only guards, and the pairing refresh on each card details delete. The latest details the pairing reads do not change. The compaction first refuses a store where any table has a foreign key to a compacted table, or where any trigger on one would still fire in replication mode.
- **Markers and idempotence.** The compaction writes its marker in `pglite_operational_migrations` in the same transaction. A later run finds the marker and removes nothing. Without the marker, the selection also finds nothing, because the rows it keeps differ from their neighbours. The worker job adds a second marker once the tables are rewritten, as ADR 0144 does.
- **Never in the open path.** ADR 0144 runs on store open, because its delete is small and bounded. Compaction is not. On a synthetic store of 4 GB, phases A to C took about two minutes in one transaction, and on a real store the dry run alone holds the ledger for seconds per source. An open that waits for it would look like a hang, and a failure there would block the app. The owner starts it from Settings, and the worker runs it on its background lane in chunks per source subject. Partitions never cross a subject.
- **Returning the space.** Deleted rows only free pages for reuse. The worker job then rewrites the touched tables with `VACUUM (FULL, ANALYZE)`, which cannot run inside a transaction.

## Delivery

1. The dry run (`financial.canonical.compactionPlan`, `npm run ledger:compaction-plan`).
2. Phases A and C with the verifier: `compactLedgerDomainAndCounts` in `compaction.ts`, exposed as the host-only operation `financial.canonical.compactDomainAndCounts`. It runs as one transaction, so it must not be wired to the UI before step 4. A failure throws `LedgerCompactionError`; recording it for Settings is the job's.
3. Phase B with manifests.
4. The worker job: chunks per subject, markers, VACUUM FULL and progress events.
5. The Settings action and its copy, with the dry-run estimate and the opt-in backup.
6. Optionally, a pass that ignores positional sequence lexemes.

## Considered options

- **Keep the old rows.** Rejected. They are about a third of a real store, and they slow every read that scans a whole history.
- **Keep the last row of each run.** Rejected. An earlier knowledge point would see no row, as ADR 0144 explains.
- **Run on store open, as ADR 0144 does.** Rejected for the reasons above.
- **Back up by default.** Rejected. It needs as much free space as the store itself, and the verification already rolls back any change a reader could see.
- **Check only that each removed row equals a kept row.** Rejected as the only check. Equal rows can still change a reader's answer, for example the name at a knowledge point between them. The readers' answers are what must hold.

## Consequences

- ADR 0008's hard deletes become three: the Contract Purge, the Kind cleanup of ADR 0144, and this compaction.
- ADR 0152's "copies already stored stay as they are" holds only until the owner compacts the store.
- Domain history no longer shows each sync that repeated an unchanged row. Nothing reads those rows.
- The marker survives a Canonical Reset, which keeps `pglite_operational_migrations`. That is safe because the current writers write no repeats.
