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
- **Backup.** Off by default. Settings offers "back up first" only when the free disk space is at least the size of the store. The verification below, inside the transaction, is the safety net.
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

A chunk reads only the readers whose SQL names a table it changes. A query's answer depends only on the tables it reads, so no other answer can move. Within those, a reader keyed by a chain (a source subject and record kind), by a record (a chain and an occurrence key) or by a capture reads only the keys the chunk can change. That is sound only where every row the chunk can change sits under such a key. The chunks are cut along those keys, and phase B's statements are counted against them rather than trusted for the shape of their SQL: each delete must remove as many rows as name a selected copy in its table, and once every statement has run, each of the four record tables must have lost exactly those rows, kept none of them, and hold no row the chunk's transaction wrote (its `xmin`), so a statement that trades a selected row for another, updates in place of deleting, or also writes another record's row, in its own table or another, is refused (`removed-count-mismatch`). The manifest insert must add exactly one row for each capture owning a selected copy and change no other row of the table, and the manifests are checked again after the deletes, which run with the append-only guard off: none of the earlier ones gone, and no row written but the chunk's own (`manifest-mismatch`). These guards bound the statements to the record tables and the manifests, which is all phase B writes; a write to any other table is outside what a chunk proves, and the statements are fixed SQL, so the checks plant such writes only against these tables. A satellite such as the record provenance, which no reader reads, is held to its count the same way:

- **Phase A runs store-wide, one chunk per table.** Its run keys do not follow subjects. Transaction relation provenance links a loan transaction with a deposit transaction of another subject, account identifiers belong to an account that several subjects can feed, and the history readers are keyed by transaction, relation or account, not by subject. Reading them whole per table is cheap: phase A is under 100,000 rows on the 1.6 GB store, and a table's readers read only that table. Two tables are one chunk when one's selection names the other or a reader names both. Today that joins only the e-invoice observations and events. Phase A runs before every other chunk, because the domain rows it keeps decide which copies stay cited.
- **Phases B and C run per group of chains.** A record's copies, and a count partition, never leave one subject and record kind. A group holds every chain that a capture holding one of its copies also holds copies of, when the job plans. A capture has at most one manifest, written by the chunk that removes its copies; a capture split across two chunks would let the second chunk find the first's manifest and keep its copies. The count readers read the group's chains. The record readers read the records the chunk removes a copy of, each with all its copies: a record reader's rows are keyed by subject, record kind and occurrence key, and a removed copy changes only the rows of its own key. The capture membership reader reads the captures that own a removed copy, all of each capture's members included. No other capture changes: it owns no removed copy, it gets no manifest, and no manifest it has lists a removed copy, which the cited check refuses before anything is deleted. Both scopes come from the copies the chunk selected, are fixed before the first read, and are the same before and after the deletes. A selection that reaches a row outside the chunk's chains, or a copy without an occurrence key, which no record reader's scope holds, is refused before anything is deleted (`outside-chunk`). A sync between the plan and a chunk can only make a group less complete, never unsound: the chunk reads its captures again.
- **No smaller split yet.** A group of chains cannot be split further without writing one capture's manifest across two chunks, which needs a manifest the compaction can extend and tell apart from one the ADR 0152 writer wrote. If one group on a real store holds the ledger too long, that comes next. The job reports the longest chunk to measure it.

**A chunk is planned with its own row counts.** Phase B's selection runs as three statements in the chunk's transaction: the chunk's copies into a temporary table, the copies among them that something cites into a second one, and then the classification, which reads both. Each table's size and unique key tell the planner how many rows the statement before it found. The two tables are not analyzed: measured with and without, an ANALYZE of them saved no time (8,000 copies took 1,269 ms without and 1,287 ms with), and it wrote to `pg_statistic` in every chunk. As one query, the planner estimated a chunk's copies from the store's average per subject and record kind, which is one row on a store with many sources. For one row it scanned every citation of the chain again for each copy, so a chunk's time grew with its copies times its cited copies. On a 1.9 GB store, the slowest chunk held the ledger for 36 s and removed nothing; a synthetic chain of 30,000 cited copies took 220 s. The rows selected are the same, and the dry run still classifies in one query (`recordCopiesSql`). `npm run check:pglite-compaction-chunks` builds such a chain of 8,000 cited copies and fails when any chunk takes more than 2 s. That chunk took 16 s as one query, and takes under 1 s now. CI runs it in the performance lane (`compaction-chunk-performance.check.ts`).

**A chunk's readers follow what it removes, not what it holds.** The record and capture readers first read every copy of the chunk's chains and every capture that held one. A chain whose records are new on every sync, such as holdings, has a capture per sync, so a chunk that removed seven copies read thousands of members twice. On a 1.9 GB store those two reads were 46 s of a 141 s run. The same check builds such a chain, 1,200 captures of 50 records each with seven copies to remove; its chunk took 4.5 s when the readers read the whole chain and takes 0.8 s now. `compaction.check.ts` also counts the rows a chunk's readers read, and runs every planted phase B defect through a chunk, which must refuse each as the whole compaction does.

**The job analyzes once, at the end.** A chunk runs no ANALYZE on the tables it changes. Its statements read the rows it staged, and the planner sizes a table from its pages on disk, which a delete leaves as they were, so a later chunk plans as an earlier one did. Per chunk, the ANALYZE was 20 s of the 141 s run. Once every chunk is done, the job analyzes each compacted table and the manifests, one table per step, before it writes the markers. A run that stops or fails leaves the statistics as they were until the next run completes.

A chunk still reads every row of each table that cites a record without an index on that column, once to select and once to check the copies it removes. Those scans grow with the store, not with the chunk. They are left alone: on the 1.9 GB store the selection's scan took at most 0.42 s in a chunk and the check's at most 1.15 s. A chunk also reads its scoped readers twice when it removes something, and those reads grow with the copies it removes. A chunk that removes tens of thousands of copies is therefore still the longest; it gets shorter only with the smaller split above.

**Progress comes from the data.** A committed chunk's selection finds nothing again: its kept rows differ from their neighbours, and each capture that lost a copy has a manifest. A stopped, crashed or quit run therefore plans again and runs every chunk, and the chunks already done select nothing, read no reader and commit nothing. The markers `ledger-compaction-domain-counts-v1` and `ledger-compaction-records-v1` are written only after every chunk is done, so they still mean that a whole phase is compacted. `compactLedger`, the whole compaction in one transaction, stays as the reference the checks compare the job with; the job leaves an old-shaped store with the same rows.

**Failure.** A chunk that throws rolls back alone; the chunks before it stay committed, each verified. The run ends as `failed` with the chunk and the failure, and the worker keeps it as the last result, which the status operation returns. Nothing retries it: the job starts only when the owner starts it. Stop aborts the running chunk, which rolls back, and starts no other.

**Host-only operations.** `financial.canonical.compact` runs the job on the `background-steps` lane, one at a time; `financial.canonical.compactionStatus` returns the running chunk, *i* of *n*, with the rows removed so far, or how the last run ended; and `financial.canonical.compactionStop` stops it. None has a renderer route or workflow access. They replace `financial.canonical.compactLedger`, which held the ledger for the whole compaction.

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
- **Check only that each removed row equals a kept row.** Rejected as the only check. Equal rows can still change a reader's answer, for example the name at a knowledge point between them. The readers' answers are what must hold.

## Consequences

- ADR 0008's hard deletes become three: the Contract Purge, the Kind cleanup of ADR 0144, and this compaction.
- ADR 0152's "copies already stored stay as they are" holds only until the owner compacts the store.
- ADR 0152's "captures from before this change have no manifest and own all their copies" holds only until then too. A compacted capture from before ADR 0152 has a manifest that lists the earlier copies it no longer owns, as a capture written after it would.
- Domain history no longer shows each sync that repeated an unchanged row. Nothing reads those rows.
- The marker survives a Canonical Reset, which keeps `pglite_operational_migrations`, and a second run is a no-op while it exists. The commands write no repeats, but loan repayment resolution (`relations.ts`) still writes relation provenance without comparing it with the latest row, so such repeats can collect after a compaction. Compacting them, or any repeat a future writer adds, needs a new marker key (`-v2`).
