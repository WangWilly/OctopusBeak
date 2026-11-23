# An unchanged re-sync reuses stored Source Records

Status: accepted; implementation in progress

Amends [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md).

ADR 0008 makes each Source Record belong to exactly one Capture. Scheduled Collection ([ADR 0045](./0045-scheduled-collection.md)) syncs every source daily, and each sync fetches a look-back window again: from 6 months up to 2 years, depending on the source. A record therefore gets a new copy on every sync, even when nothing about it changed.

Measured on one complete 200-record capture, committed again with only a new capture id:

| Table | Rows gained per unchanged re-sync |
|---|---|
| `source_records`, `source_record_scopes`, `source_record_provenance` | one per record |
| `assertion_provenance`, `source_occurrence_group_counts` | one per record |
| capture, scope, page, coverage and commit rows | one per capture |

Each unchanged re-sync grows the store by about 5.3 KB per record. After 365 daily syncs of those 200 records, the store had grown by 391 MB. The commit had slowed from 0.6 s to 3.5 s, mostly in the expected-occurrences query, which reads every stored copy. Credit-card, e-invoice, investment and loan commands also add a row of their own per item on each sync. Dead tuples from the projection refresh are a separate source of growth, handled on their own.

**A record seen again unchanged is not written again. Its Capture records that it saw the stored copy.**

- A record reuses the latest stored copy for its subject, kind and occurrence key only when every stored field is equal, including bucket and group fields. The copy's capture must also have the same coverage shape, and nothing new in this commit may cite the record. Any other record is written as before.
- Each capture keeps a manifest of the stored records it reused. A capture's records are those it owns plus those in its manifest. Captures from before this change have no manifest and own all their copies.
- Readers that need true per-capture membership read it through one helper: withdrawal by omission and loan counterparty evidence. Billed monotonicity reads the latest lifecycle by transaction instead of by the latest copy.
- A source `assertion_provenance` row is written once per assertion and source record. An occurrence-group count row is written only when it raises the stored maximum.
- An unchanged re-sync therefore costs a fixed set of rows per capture plus about 16 bytes per reused record, instead of about 5,300.

`npm run check:pglite-resync-growth` measures this. It fails while any table gains more than a fixed number of rows per unchanged re-sync. It runs outside CI until the change is complete.

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
  4. credit-card domain rows written only on change;
  5. the other domain commands.
- Until a domain command converts, its records keep being copied, because a record a new row cites cannot be reused.
