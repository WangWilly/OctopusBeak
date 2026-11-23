# An unchanged re-sync reuses stored Source Records

Status: accepted

Amends [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md) and [ADR 0004](./0004-plaid-inspired-canonical-financial-model.md).

ADR 0008 makes each Source Record belong to exactly one Capture. Scheduled Collection ([ADR 0045](./0045-scheduled-collection.md)) syncs every source daily, and each sync fetches a look-back window again: from 6 months up to 2 years, depending on the source. A record therefore gets a new copy on every sync, even when nothing about it changed.

Measured on one complete 200-record capture, committed again with only a new capture id:

| Table | Rows gained per unchanged re-sync |
|---|---|
| `source_records`, `source_record_scopes`, `source_record_provenance` | one per record |
| `assertion_provenance`, `source_occurrence_group_counts` | one per record |
| capture, scope, page, coverage, commit and projection-generation rows | one per capture |

Over 365 daily syncs of those 200 records, measured before [ADR 0153](./0153-projection-writes-only-changed-rows-and-the-worker-vacuums.md), the store grew by 391 MB, about 5.3 KB per record per sync. The commit slowed from 0.6 s to 3.5 s, mostly in the expected-occurrences query, which reads every stored copy. With ADR 0153 in place, the ten-sync check below measures about 3,900 bytes per record per sync on main before this change, in both of its modes. Domain commands add rows of their own on each sync:
- credit cards: a detail and a lifecycle row per item;
- e-invoices: an observation per invoice;
- investments: an observation per security or holding;
- loans: a relation provenance row per relation.

Dead tuples from the projection refresh are a separate source of growth, handled on their own.

**A record seen again unchanged is not written again. Its Capture records that it saw the stored copy.**

- A record reuses the latest stored copy for its subject, kind and occurrence key only when every stored field is equal, including bucket and group fields. The copy's capture must also have the same coverage shape, and nothing new in this commit may cite the record. Any other record is written as before.
- The copy must also back exactly the source assertions this commit links the record to. A record seen without its fact is stored again, because reusing the copy would make its capture a sighting of that fact, and withdrawal by omission reads sightings.
- The commit decides which records are cited before it stores any. It reads the facts and balances it is about to write: a new revision, new conversion evidence or a new balance revision cites its record. A command that adds its own rows names the records those rows will cite, or declares that they may cite any record of the capture, and then none is reused. A row written after the records are stored is checked against the plan: it may cite only a record its own capture stored.
- "Coverage shape" means the capture's occurrence-group coverage for the record: the contract version of each coverage entry with the record's group scope key, and whether that entry carries a bucket inventory. A record without an occurrence group has no coverage to compare.
- The coverage dates are not part of the shape. They follow the collection window, which starts from today, so they differ on every later day, and a shape that held them would store every record again each day. No reader reaches them through a record. The expected-occurrences query reads only the scope key, the contract version and the inventory of the owning capture's coverage. The only check that reads stored coverage dates, the one that requires a source with prior coverage to keep it, reads every capture's own coverage row. The bucket-less member-loss guard reads count rows, filtered by the incoming entry's dates. The expected-occurrences query finds each occurrence through the coverage of the capture that owns its latest copy. Reuse keeps that query's answer only because the owning capture's coverage matches the new one, so this condition must not be relaxed without changing that query.
- Each capture keeps one manifest row listing the stored records it reused, as packed 16-byte record ids. A capture's records are those it owns plus those in its manifest. Captures from before this change have no manifest and own all their copies.
- Readers that need true per-capture membership read it through one helper: withdrawal by omission, which matches the capture scope window, and loan counterparty evidence.
- Billed monotonicity reads the latest lifecycle by transaction instead of by the latest copy: the row written by the highest commit sequence, as the vanished-unbilled resolution of [ADR 0040](./0040-per-bucket-occurrence-continuity-and-unbilled-to-billed-supersession.md) already reads it. A transaction with no lifecycle row has no billed expectation.
- A source `assertion_provenance` row is written once per assertion and source record. The baseline unique key includes the commit, so the commit checks for an existing row first.
- An occurrence-group count row is written only when it raises the stored maximum within the same partition the continuity check reads: subject, record kind, scope key, contract version, date and fingerprint. A count stored under one contract version never suppresses one under another.
- The credit-card command writes four of its own tables only where a row differs from the latest stored row for its key, the one written by the highest commit sequence, as Billed Monotonicity reads the lifecycle:
  - instrument evidence, per instrument: differs when the instrument is new or its latest evidence names another occurrence;
  - transaction details, per transaction: revision, instrument, billing status, consume date, posting date, effective date basis and statement key;
  - transaction lifecycle, per transaction: revision, instrument, billing status and statement key;
  - statement summary evidence, per statement: the statement revision, which fixes the evidence occurrence it names.

  The record and capture a row cites are not compared, so an unchanged row is not written again for a new copy of its record. The command compares before admission, under ids the store already holds; an id the commit has yet to create, such as a new revision or statement revision, makes the row differ. Each record a new card row cites is cited, as are the evidence of card relations and the successor of an unbilled-to-billed supersession; every other record may be reused.
- Readers find the current card rows by key rather than through the capture or the latest copy. Billed Monotonicity and the vanished-unbilled resolution read the latest lifecycle by transaction. Every reader of card details reads a revision's details row written by the highest commit sequence, ties broken by the highest record id: Spending pairing, the purchase report, payment-source facts, the merge log, and the date facts of the Spending report and of a single current transaction. They used to take the row with the lowest record id, or whichever row a scan returned last, which is arbitrary once one revision holds rows with different posting dates or billing statuses. Instrument evidence and statement summary evidence have no reader outside the command.
- The e-invoice command writes an invoice's observations only when the set of revisions a capture lists for it differs from the set its latest observing commit observed, the one with the highest commit sequence. It then writes an observation of every listed revision, with an `observed` event for each one that already existed, and each of those records is cited. A new revision is never in the stored set, so its revision row, observation and events are always written. The lineage view lists an invoice's observations and events, which now record when its observed revisions changed rather than every capture that saw them. Each revision still has the observation written with it, so the view's provenance stays complete.
- The loan command writes relation provenance only when the relation is new, or when the evidence its latest provenance row names differs: the evidence record key, relation id and contract version of the row written by the highest commit sequence. The evidence record is cited, in the loan capture or in the counterpart capture that holds it. Typed loan facts are written once per transaction revision, so a record is cited for them only when its transaction has no revision yet or its latest revision has no facts. Nothing reads relation provenance except this comparison. The repayment resolver also writes it, citing the record of an endpoint's revision, which that revision's capture stored.
- The investment command writes a Security's name observation only when the Security is new, or when the name or contract version differs from its latest name observation: the one with the highest commit sequence, ties broken by the highest capture id, as the overview reads current and historical names. This amends ADR 0004's "each admitted Capture appends a typed name observation". The record a new name observation cites is cited. Investment transactions, Passbook movements and embedded margin balances are written once, so their records are cited only when their row does not exist yet. The independent margin account's capture writes no row of the command, so its record may be reused. Each record's sequence lexeme is its source record key, not its position in the capture: a position renumbers every later record when an earlier one leaves the window, and a renumbered record is stored again.
- Holding observations keep their existing rule. ADR 0008 makes each Holding measurement a new Observation, and repeated independent observations are retained even when values match. The TDCC and Yuanta adapters therefore derive the measurement key from the capture, and the MaiCoin and Binance adapters derive it from a record key that carries the provider's time, so no two syncs share one. The readers depend on that: the overview and the daily history treat the holding rows that share an `observed_at` as one collection run, and a newer run without a Security means it was sold (ADR 0042). Writing holdings only on change would make every unchanged holding look sold. A holding record from TDCC, MaiCoin or Binance also carries the provider's time in its key, so it is new on every sync and could not be reused. A holding observation is written unless an observation of exactly that measurement exists, and its record is cited whenever it is written.
- An unchanged re-sync therefore costs a fixed set of rows per capture plus about 16 bytes per reused record, instead of about 3,900 with ADR 0153 in place.

`npm run check:pglite-resync-growth` measures this through the generic commit, on a deposit route and on a credit-card route, through the credit-card command with an instrument, statements and each purchase's card rows, and through the e-invoice, investment and loan commands. Its investment capture holds two holdings, whose two records and observations are new on every sync by the rule above. Its loan payments keep their source sequence index from sync to sync. Some of its occurrence groups have two members, and each sync's window starts and ends a day later than the one before, so the oldest rows age out. It fails while any table gains more than eight rows per unchanged re-sync, or the store grows by more than 256 bytes per record. It passes in every mode, and CI runs it in the performance lane (`resync-growth-performance.check.ts`).

Copies already stored stay as they are. A compaction of existing duplicates will be decided after measuring real stores.

## Considered options

- **Write nothing at all for an unchanged sync**, for example "same set as capture X" or an end-of-sighting marker. Rejected. Several captures per subject in one sync would flap between sets, and the per-record saving over 16 bytes is small.
- **Keep every copy and add indexes.** Rejected. That speeds up reads but keeps the linear growth.
- **Prune old copies.** Deferred. Pruning deletes history, so it needs its own decision and checks.

## Consequences

- ADR 0008's "each Source Record belongs to exactly one Capture" becomes "each Source Record is owned by exactly one Capture, and later Captures may reuse it through their manifest".
- The change lands in steps, each with its own checks:
  1. a manifest with a membership helper;
  2. billed members by transaction;
  3. reuse in the generic store;
  4. credit-card domain rows written only on change, after the check gains a mode that drives the credit-card command;
  5. the other domain commands.
- The Fubon and Yuanta loan adapters number rows by their position in the response, so a row that ages out of the window renumbers the rows after it, and those records are stored again. Reusing them needs a position-independent source sequence index, which is still open.
- `financial_account_identifier_observations` still gains one row per capture.
- Copies stored before this change stay as they are; compacting them is still open.
- Loan counterparty evidence on a reused record finds its transaction through the revision that record created. On a copy it matches the capture's account and the fact's source sequence instead. Both name the same transaction when a fact is keyed by its occurrence, as deposit facts are.
- Loan counterparty evidence is the one new row that may cite a reused record. Its row names the record and the capture that sighted it, which is not the capture that owns the record. This is safe because its readers join that capture only to read when it was observed, and no reader matches it to the record's owner.
- A standalone source admission, with no financial facts, stores every record and reuses none. Its caller may write rows that cite the records after the admission's transaction ends, and the commit cannot check those rows.
