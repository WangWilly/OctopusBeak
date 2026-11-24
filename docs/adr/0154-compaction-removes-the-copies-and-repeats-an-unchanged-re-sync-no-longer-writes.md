# Compaction removes the copies and repeats an unchanged re-sync no longer writes

Status: accepted

Amends [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md) and [ADR 0152](./0152-an-unchanged-re-sync-reuses-stored-source-records.md).

ADR 0152 stopped an unchanged re-sync from writing a record copy, a domain row or a count row that says nothing new. It left the rows written before it in place. On a real store of 1.6 GB, the dry run (`npm run ledger:compaction-plan`) counts:

| Phase | Rows removable | About |
|---|---|---|
| A, domain rows | card details and card lifecycle: 22,156 of 22,586 each; instrument evidence: 318 of 325; statement summary: 1,333 of 1,356; security names: 1,227 of 1,248; account identifiers: 3,007 of 3,045; e-invoice observations and events: 19,216 of 19,529 each | 28 MB |
| B, record copies | 151,187 of 169,770 | 458 MB |
| C, count rows | 53,295 of 54,180 | 19 MB |

ADR 0008 keeps lineage append-only. Its hard deletes are the Contract Purge and the one-time Kind cleanup of [ADR 0144](./0144-a-store-removes-derived-kinds-a-refresh-wrote-again-unchanged.md). **This ADR adds a third hard delete: compaction removes the record copies, domain rows and count rows that the ADR 0152 writers would not have written, and keeps the answers its verifier compares, the e-invoice lineage lists excepted.**

## The owner's decisions

- **Trigger.** A manual "Compact ledger" action in Settings. It first shows the dry run's estimate of the space it would free, then the progress per source. It never runs in the open path. An automatic run may be considered later.
- **Backup.** Off by default. Settings offers "back up first" only when the free disk space is at least the size of the store plus a margin (below). The verification below, inside the transaction, is the safety net.
- **E-invoice lineage.** Compacted. The lineage view lists fewer observations and events: it shows when an invoice's observed revisions changed, as ADR 0152 now writes it, not every capture that saw them. No UI reads those lists.
- **On failure.** The compaction rolls back and keeps every row. The failure is recorded and shown in Settings, and the compaction is not retried automatically, as in ADR 0144.
- **Deferred.** Loan and investment copies that differ only in a positional sequence lexeme are treated as different content. Captures that already have a manifest are skipped. A later pass may compact both.

## Target state

The target is the store the ADR 0152 writers would have produced. In every table, the first row of each run of equal values, in the reader's own order, is kept, and its repeats are removed. Keeping the first, not the last, keeps the answer at every earlier knowledge point, for the reason ADR 0144 gives. The verifier checks this for every compacted table: it compares each table's history at every knowledge point, not only its latest row.

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

Copies of one record (subject, record kind and occurrence key) are ordered by commit sequence. A copy is removed when nothing cites it after phase A, no manifest lists it, its capture has no manifest yet, and it equals the copy before it. Equal covers every stored column except the ids, the owner capture's coverage shape for its scope key, its scope row's account and subject, and the set of assertions it backs. The tables that cite a record are read from `pg_constraint`, apart from the three satellite tables, and a foreign key or a bytea record-id column the compaction does not know makes it refuse. An assertion row that also names a run or coordinate cites its copy too. So do the record ids kept as text: `sourceRecordId` in the `provenance_json` of `enrichment_run_outputs` and `enrichment_taxonomy_assertion_values`, and `investment_funding_relations.source_linkage_key`. Each is listed by name, so a new text or JSON column that holds a record id must be added to that list; the scan cannot find one.

A removed copy goes with its satellite rows: its scope row, its record provenance and its source assertion rows. Its capture gets a manifest that lists the nearest earlier kept copy of the same record, so the capture's records, owned or reused, still hold one copy per occurrence key, as the ADR 0152 writer would have stored them. Removed copies of one capture have different occurrence keys, so the manifest lists no id twice, and the capture owns no other copy of a listed key, because a capture holds one copy per key.

The dry run and the compaction classify the copies with the same query (`recordCopiesSql`). Phase B runs after phase A's deletes, in the same transaction or, in the worker job, after every phase A chunk, because the domain rows phase A keeps are the ones that still cite a copy.

### Phase C: count rows

In each partition (subject, record kind, scope key, contract version, date and fingerprint), a count row is kept only when it raises the maximum stored before it. The member-loss guard and the count writer read only that maximum.

### Never touched

Captures, scopes, pages, coverages, commits, revisions, assertions, transitions, holdings and balances. A holding or balance observation cites its own record, and its key is new on every sync (ADR 0008, ADR 0042).

## Safety

- **Verified in each transaction.** Before deleting, the compaction reads each of the answers listed below and takes a SHA-256 digest of its rows, sorted as text. After deleting, it reads them again. Any difference throws, and the transaction rolls back. The worker job reads, in each chunk, the answers that chunk can change (see Chunks). The digests are exact; the prototype's sums of 60-bit hashes are not used. What is compared is this list, not every query that touches the tables:
  - card details, latest by revision (`latestCardDetailsByRevisionSql`) and latest by transaction (the card command);
  - card details, the distinct revision and consume date pairs the spending date match reads;
  - card lifecycle, latest by transaction (`listLatestLifecycle`) and by namespace, account and transaction (the card command);
  - instrument evidence and statement summary evidence, latest;
  - relation provenance, latest (the loan command);
  - account identifiers, the distinct set (account identity continuity, ADR 0049), and the commit that first saw each;
  - e-invoices, each invoice's latest observed revisions, the revisions that have an observation (`provenanceComplete`), and every event that is not `observed`, with all its columns;
  - count rows, the maximum of each partition;
  - at every knowledge point: the value as of each commit for card details, card lifecycle, instrument evidence, statement summary evidence, security names (the overview and the investment command), relation provenance, each invoice's observed set, and each count partition's running maximum;
  - e-invoices, the observations without an `observed` event at their commit and the `observed` events without an observation. A removed commit loses both together, so an event or observation removed alone shows;
  - record copies, which the readers name by content, not by id, because a capture's manifest names another copy than the one it owned:
    - the expected occurrences (`listPGliteExpectedOccurrences`) of every subject, record kind, scope key and inventoried contract version;
    - the latest copy of each record with what the reuse writer compares: every stored column, the owner capture's coverage shape, and the transaction assertions it backs; latest and at every knowledge point;
    - each capture's records through `captureSourceRecordIdsSql`, as withdrawal by omission and counterparty evidence read them: each with its content, its scope row's account and subject, every assertion it backs, and whether the capture's commit already knew it. The rows are not made distinct, so a copy listed twice or a listed copy that is gone shows.

  The e-invoice lineage lists are the one answer that changes, by the owner's decision: they lose the `observed` observations and events of the removed commits.

  Each delete must also remove exactly the rows that were selected.
- **Each removed copy checked on its own.** Before phase B writes a manifest or deletes, it checks each copy it selected against the three conditions again, apart from the selection: no citing column, manifest or assertion row naming a run cites it; its capture has no manifest; and every stored column but the ids equals its kept copy's. The columns are read from the catalog and compared exactly with `EXCEPT`, not through a hash. Any copy that fails stops the compaction before anything changes.
- **Triggers and foreign keys.** The deletes run with `SET LOCAL session_replication_role = replica`, as ADR 0144 does, and with the purge guard setting on. This skips the per-row foreign-key checks, the append-only guards, and the pairing refresh on each card details delete. The latest details the pairing reads do not change. The manifests are written before replication mode is turned on, so their foreign keys are checked. The compaction first refuses a store where any table has a foreign key to a compacted table other than `source_records`, whose citing columns phase B reads and checks as above, or where any trigger on one is not in the default mode that replication mode turns off. A disabled trigger is refused too, so the compaction only skips the triggers the schema installs.
- **Markers and idempotence.** The compaction writes its markers in `pglite_operational_migrations` in the same transaction: `ledger-compaction-domain-counts-v1` for phases A and C, and `ledger-compaction-records-v1` for phase B. A later run skips each phase whose marker it finds, and removes nothing once both are written. A store compacted before phase B existed has only the first marker, so its next run compacts its record copies only. Without the markers, the selections also find nothing: the rows they keep differ from their neighbours, and each capture that lost a copy now has a manifest. The worker job writes both only once every chunk is done, and adds `ledger-compaction-space-v1` once the tables are rewritten, as ADR 0144 does.
- **Never in the open path.** ADR 0144 runs on store open, because its delete is small and bounded. Compaction is not. On a synthetic store of 4 GB, phases A to C took about two minutes in one transaction, and on a real store the dry run alone holds the ledger for seconds per source. An open that waits for it would look like a hang, and a failure there would block the app. The owner starts it from Settings, and the worker runs it on its background lane in chunks (below).
- **Returning the space.** Deleted rows only free pages for reuse. The worker job then rewrites the compacted tables with the manual reclaim of [ADR 0155](./0155-a-manual-reclaim-rewrites-bloated-ledger-tables.md), one table per step, and writes `ledger-compaction-space-v1` once the reclaim ends as `reclaimed` or finds nothing to reclaim.

## Chunks

The worker job (`runLedgerCompaction` in `compaction-job.ts`) runs the phases as chunks. Each chunk is one step on the background lane and one transaction (`compactLedgerChunk`), so a sync, a commit or a page read queued meanwhile runs before the next chunk. Each chunk keeps the safety of the single transaction: the same selections narrowed to the chunk, the three checks on each removed copy, replication mode and the purge guard for the deletes, exactly as many rows removed as selected, and the readers read before and after, with any difference rolling the chunk back.

A chunk reads only the readers whose SQL names a table it changes. A query's answer depends only on the tables it reads, so no other answer can move. Within those, a reader keyed by a chain (a source subject and record kind) or by a capture reads only the chunk's chains or captures. That is sound only where every row the chunk can change sits under a key in the chunk, so the chunks are cut along those keys:

- **Phase A runs store-wide, one chunk per table.** Its run keys do not follow subjects. Transaction relation provenance links a loan transaction with a deposit transaction of another subject, account identifiers belong to an account that several subjects can feed, and the history readers are keyed by transaction, relation or account, not by subject. Reading them whole per table is cheap: phase A is under 100,000 rows on the 1.6 GB store, and a table's readers read only that table. Two tables are one chunk when one's selection names the other or a reader names both. Today that joins only the e-invoice observations and events. Phase A runs before every other chunk, because the domain rows it keeps decide which copies stay cited.
- **Phases B and C run per group of chains.** A record's copies, and a count partition, never leave one subject and record kind. A group holds every chain that a capture holding one of its copies also holds copies of, when the job plans. A capture has at most one manifest, written by the chunk that removes its copies; a capture split across two chunks would let the second chunk find the first's manifest and keep its copies. The record readers read the group's chains, and the capture membership reader reads every capture that holds one of their copies, all of each capture's members included. A copy removed in the chunk is in that set, and no capture outside it changes: it owns no removed copy, and no manifest lists one. A selection that reaches a row outside the chunk is refused before anything is deleted (`outside-chunk`). A sync between the plan and a chunk can only make a group less complete, never unsound: the chunk reads its captures again.
- **No smaller split yet.** A group of chains cannot be split further without writing one capture's manifest across two chunks, which needs a manifest the compaction can extend and tell apart from one the ADR 0152 writer wrote. If one group on a real store holds the ledger too long, that comes next. The job reports the longest chunk to measure it.

**Progress comes from the data.** A committed chunk's selection finds nothing again: its kept rows differ from their neighbours, and each capture that lost a copy has a manifest. A stopped, crashed or quit run therefore plans again and runs every chunk, and the chunks already done select nothing, read no reader and commit nothing. The markers `ledger-compaction-domain-counts-v1` and `ledger-compaction-records-v1` are written only after every chunk is done, so they still mean that a whole phase is compacted. `compactLedger`, the whole compaction in one transaction, stays as the reference the checks compare the job with; the job leaves an old-shaped store with the same rows.

**Failure.** A chunk that throws rolls back alone; the chunks before it stay committed, each verified. The run ends as `failed` with the chunk and the failure, and the worker keeps it as the last result, which the status operation returns. Nothing retries it: the job starts only when the owner starts it. Stop aborts the running chunk, which rolls back, and starts no other.

**Host-only operations.** `financial.canonical.compact` runs the job on the `background-steps` lane, one at a time; `financial.canonical.compactionStatus` returns the running chunk, *i* of *n*, with the rows removed so far, or how the last run ended; and `financial.canonical.compactionStop` stops it. None has a renderer route or workflow access. They replace `financial.canonical.compactLedger`, which held the ledger for the whole compaction.

## The Settings action

Step 5 of the delivery. Settings' data section has a "Compact ledger" row, beside "Reclaim ledger space", and it follows that row's shape (ADR 0155).

- **Estimate first.** The row runs the dry run (`financial.canonical.compactionPlan`) on the live worker, one step per phase A table and per source subject on the background lane, and shows about how much the compaction would free. A large subject's step holds the ledger for seconds, so the estimate runs only when the owner asks for it, and the row's hint says, before the estimate runs, that checking may pause OctopusBeak for a few seconds. A store with nothing removable shows "Nothing to compact"; a store whose citations the planner does not know shows that it cannot be compacted yet.
- **Then the run, with progress and Stop.** Once confirmed, the row shows the backup, then step *i* of *n* with the rows removed so far, then the reclaim's table *i* of *n*. Stop aborts the running chunk. A stop during the reclaim ends the run as `stopped`, not `compacted`: every chunk and both markers are committed, the space marker is not, and the next run only reclaims. Settings left and opened again follows a run still going, as the reclaim row does.
- **The backup is opt-in, and offered only with room.** `financial.canonical.compactionBackupRoom` reads the size of the ledger's folder and the free space on its disk; it reads no table. Settings offers "Back up the ledger first", unticked, only when the free space is at least `ledgerBackupBytesNeeded`: the folder's size, plus 10% of it, plus 256 MiB. A backup that just fits would leave the disk full, and the WAL the first chunk writes would then fail with ENOSPC, which stops PostgreSQL. The worker computes the figure and the backup checks it again before it copies, so Settings and the backup use one rule. The rule is the same on a disk that clones: a clone costs almost nothing when it is made, but it keeps the old blocks once the compaction and its reclaim rewrite the tables, so it ends up costing the folder's size too. Next to the box, Settings gives the folder's size and says that the backup is saved beside the ledger folder, named after it with `before-compaction` and the time, and that OctopusBeak pauses while the copy is made on a disk that cannot clone files. A worker on a temporary folder offers none.
- **How the backup is consistent.** The backup is the first step of the run, after the plan and before the first chunk, on the background lane (`backUpLedger` in `data-dir-backup.ts`). It removes any `.partial` copy an earlier backup left, checks the room again, then, as one background step, opens one transaction on the store, runs `CHECKPOINT` in it, copies the folder while the transaction is still open, and only then ends it. The size walk before the step and the flush after it hold neither the lane nor the lock. PGlite runs every `query`, `exec` and `transaction` under one transaction mutex, so no live query, operational write, vacuum or other job can run while the transaction is open. The `CHECKPOINT` first writes every dirty page to the data files. So the copy is the folder as of one moment, with nothing written during the copy. Opened, it recovers from that checkpoint. The copy goes beside the folder, never over an earlier one. It is written as `<folder>.before-compaction-<UTC time>.partial`, flushed to the disk, and only then renamed to `<folder>.before-compaction-<UTC time>`, so a folder with a backup's name is always a whole copy. A copy that fails is removed, and the run ends as `failed` before any chunk runs. A stop, or the shutdown that aborts the run when the app quits, aborts the copy between files and the flush; the partial copy is removed and the run ends as `stopped`. A worker killed before that leaves the `.partial` copy, which the worker removes when it next opens the store, and the next backup removes it too.
- **How the backup copies.** On macOS the copy is `/bin/cp -cR`, which clones each file with clonefile(2). Measured on APFS with a 2.2 GB store, the clone held the lock for about 220 ms, CHECKPOINT included, and used about 1 MiB; Node's `fs.cp` held it for 5.3 s and used 2.2 GiB. Node's `fs.cp`, `cpSync` and `copyFile` with `COPYFILE_FICLONE` copy every byte on APFS, and `COPYFILE_FICLONE_FORCE` fails with ENOSYS. On a disk that cannot clone, such as HFS+ or exFAT, `cp -c` copies the bytes itself, and the lock is held for the whole copy: 7.5 s for the same store on HFS+. If `cp` fails, or on another platform, `fs.cp` copies the folder and checks the stop between files. A check holds a write back while the folder is copied: the write waits, the copy opens with every row committed before it and without the waiting write, and the ledger takes the write afterwards.
- **A failure persists across restarts.** When a run fails, the compactor writes one row to `pglite_operational_migrations`, key `ledger-compaction-last-failure`, with the rows removed, the chunks done and whether the backup failed in its signature column, and the time of the failure in `applied_at`. It is not a marker: no run skips anything because of it. After a restart, the status operation returns it as `failed-earlier` when this worker has run nothing yet, and Settings shows the failure on opening. Nothing retries it. Starting a compaction deletes the row first; a store that cannot delete it fails the run's own plan, which records the failure again. A Canonical Reset deletes the row, because it counts rows of the store the reset empties; the markers survive it.
- **A chunk that fails its own verification fails.** A `LedgerCompactionError` from a chunk ends the run as `failed` even when Stop was pressed meanwhile. Only another error after an abort is a stop.
- **The renderer sees sizes, counts, phase and status.** The Settings desktop service forwards the estimate's removable rows and bytes and the backup room's two sizes. It forwards the progress phase, *i* of *n* and the rows removed, and the result's status, rows removed, reclaimed bytes and whether the backup failed. No table, reader, chunk, subject, namespace, failure message or backup path reaches the renderer. The compaction moves no data version: no answer a page reads changes.

## Delivery

1. The dry run (`financial.canonical.compactionPlan`, `npm run ledger:compaction-plan`).
2. Phases A and C with the verifier.
3. Phase B with manifests, in the same transaction: `compactLedger` in `compaction.ts`. It was exposed as the host-only operation `financial.canonical.compactLedger` until step 4.
4. The worker job: chunks, markers, the reclaim and progress, as the host-only operations above.
5. The Settings action and its copy, with the dry-run estimate and the opt-in backup.
6. Optionally, a pass that ignores positional sequence lexemes.

## Considered options

- **Keep the old rows.** Rejected. They are about a third of a real store, and they slow every read that scans a whole history.
- **Keep the last row of each run.** Rejected. An earlier knowledge point would see no row, as ADR 0144 explains.
- **Run on store open, as ADR 0144 does.** Rejected for the reasons above.
- **Chunk phase A per subject too.** Rejected. Its run keys cross subjects, so a per-subject digest would have to carry the cross-subject rows into both chunks, and phase A is small enough to read whole per table.
- **Record each chunk's progress in a table.** Rejected. The data already says which chunks are done, and a progress table could disagree with it after a crash.
- **Back up by default.** Rejected. It needs as much free space as the store itself, and the verification already rolls back any change to the answers it compares, latest and at every knowledge point.
- **Back up with `dumpDataDir`, or by copying the folder without holding the store.** Rejected. `dumpDataDir` writes a tarball, not a folder that opens as a ledger. A copy taken while other work can query lets a write land in some files and not in others.
- **Record a failure in a new table.** Rejected for now. One failure at a time needs one row, and a new table would add a schema step for it. `pglite_operational_migrations` already holds the compaction's markers and survives a reset.
- **Check only that each removed row equals a kept row.** Rejected as the only check. Equal rows can still change a reader's answer, for example the name at a knowledge point between them. The readers' answers are what must hold.

## Consequences

- ADR 0008's hard deletes become three: the Contract Purge, the Kind cleanup of ADR 0144, and this compaction.
- ADR 0152's "copies already stored stay as they are" holds only until the owner compacts the store.
- ADR 0152's "captures from before this change have no manifest and own all their copies" holds only until then too. A compacted capture from before ADR 0152 has a manifest that lists the earlier copies it no longer owns, as a capture written after it would.
- Domain history no longer shows each sync that repeated an unchanged row. Nothing reads those rows.
- The marker survives a Canonical Reset, which keeps `pglite_operational_migrations`, and a second run is a no-op while it exists. The commands write no repeats, but loan repayment resolution (`relations.ts`) still writes relation provenance without comparing it with the latest row, so such repeats can collect after a compaction. Compacting them, or any repeat a future writer adds, needs a new marker key (`-v2`).
