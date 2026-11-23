# An unchanged re-sync reuses stored Source Records

Status: accepted; implementation in progress

Amends [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md).

ADR 0008 makes each Source Record belong to exactly one Capture. Scheduled Collection ([ADR 0045](./0045-scheduled-collection.md)) syncs every source daily, and each sync fetches a look-back window again: from 6 months up to 2 years, depending on the source. A record therefore gets a new copy on every sync, even when nothing about it changed.

Measured on one complete 200-record capture, committed again with only a new capture id:

| Table | Rows gained per unchanged re-sync |
|---|---|
| `source_records`, `source_record_scopes`, `source_record_provenance` | one per record |
| `assertion_provenance`, `source_occurrence_group_counts` | one per record |
| capture, scope, page, coverage, commit and projection-generation rows | one per capture |

Over 365 daily syncs of those 200 records, the store grew by 391 MB, about 5.3 KB per record per sync. The commit slowed from 0.6 s to 3.5 s, mostly in the expected-occurrences query, which reads every stored copy. The ten-sync check below measures about 5.0 KB per record per sync. Domain commands add rows of their own on each sync:
- credit cards: a detail and a lifecycle row per item;
- e-invoices: an observation per invoice;
- investments: an observation per security or holding;
- loans: a relation provenance row per relation.

Dead tuples from the projection refresh are a separate source of growth, handled on their own.

**A record seen again unchanged is not written again. Its Capture records that it saw the stored copy.**

- A record reuses the latest stored copy for its subject, kind and occurrence key only when every stored field is equal, including bucket and group fields. The copy's capture must also have the same coverage shape, and nothing new in this commit may cite the record. Any other record is written as before.
- The copy must also back exactly the source assertions this commit links the record to. A record seen without its fact is stored again, because reusing the copy would make its capture a sighting of that fact, and withdrawal by omission reads sightings.
- The commit decides which records are cited before it stores any. It reads the facts and balances it is about to write: a new revision, new conversion evidence or a new balance revision cites its record. A command that adds its own rows declares that they may cite any record of the capture, and then none is reused.
- "Coverage shape" means the capture's occurrence-group coverage for the record: the contract version of each coverage entry with the record's group scope key, and whether that entry carries a bucket inventory. A record without an occurrence group has no coverage to compare.
- The coverage dates are not part of the shape. They follow the collection window, which starts from today, so they differ on every later day, and a shape that held them would store every record again each day. No reader reaches them through a record: the expected-occurrences query reads only the scope key, the contract version and the inventory of the owning capture's coverage, and the checks that read coverage dates read every capture's own coverage row. The expected-occurrences query finds each occurrence through the coverage of the capture that owns its latest copy. Reuse keeps that query's answer only because the owning capture's coverage matches the new one, so this condition must not be relaxed without changing that query.
- Each capture keeps one manifest row listing the stored records it reused, as packed 16-byte record ids. A capture's records are those it owns plus those in its manifest. Captures from before this change have no manifest and own all their copies.
- Readers that need true per-capture membership read it through one helper: withdrawal by omission, which matches the capture scope window, and loan counterparty evidence.
- Billed monotonicity reads the latest lifecycle by transaction instead of by the latest copy: the row written by the highest commit sequence, as the vanished-unbilled resolution of [ADR 0040](./0040-per-bucket-occurrence-continuity-and-unbilled-to-billed-supersession.md) already reads it. A transaction with no lifecycle row has no billed expectation.
- A source `assertion_provenance` row is written once per assertion and source record. The baseline unique key includes the commit, so the commit checks for an existing row first.
- An occurrence-group count row is written only when it raises the stored maximum within the same partition the continuity check reads: subject, record kind, scope key, contract version, date and fingerprint. A count stored under one contract version never suppresses one under another.
- An unchanged re-sync therefore costs a fixed set of rows per capture plus about 16 bytes per reused record, instead of about 5,300.

`npm run check:pglite-resync-growth` measures this through the generic commit, on a deposit route and on a credit-card route. Some of its occurrence groups have two members, and each sync's window ends a day later than the one before. It fails while any table gains more than eight rows per unchanged re-sync, or the store grows by more than 256 bytes per record. It runs outside CI until the change is complete.

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
- Until a domain command converts, its records keep being copied, because a record a new row cites cannot be reused.
- Loan counterparty evidence on a reused record finds its transaction through the revision that record created. On a copy it matches the capture's account and the fact's source sequence instead. Both name the same transaction when a fact is keyed by its occurrence, as deposit facts are.
