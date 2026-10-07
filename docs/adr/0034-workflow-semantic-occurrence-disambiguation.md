# Workflow semantic occurrence disambiguation

Accepted amendment: [ADR 0040](./0040-per-bucket-occurrence-continuity-and-unbilled-to-billed-supersession.md) replaces the identical-inventory comparability rule below with per-occurrence, per-queried-bucket continuity, and adds evidence-gated withdrawal of an unbilled credit-card purchase by its billed successor.

Status: accepted

Extend semantic fingerprint group ordinals, already used by Fubon loan and
credit-card contracts, to other financial collection workflows where the
source contract supports them. The user has explicitly authorized a database
rebuild: delivery must not add old-key mappings, legacy readers, migration,
or recovery paths. The user owns rebuilding the database and recollection.

## Confirmed decision: indistinguishable occurrence groups

The user selected group-slot identities: preserve every occurrence in a
complete indistinguishable group with a group-scoped ordinal, without claiming
individual historical continuity between otherwise identical transactions.
Unrelated row insertion must not renumber that group. The accepted rules below
define completeness evidence, count changes, and duplicate collection handling
for every audited workflow. ADR 0026 remains a product-specific precedent; its
balance-evolution policy does not become a generic group-ordinal rule.

## Confirmed decision: unexplained count reduction

If a later capture proves the same group complete but reports fewer occurrences,
and the source supplies no supported cancellation or correction evidence,
reject the attempted commit and retain the previously admitted financial data.
Group-slot identity alone does not establish which occurrence disappeared or
authorize reducing the current projection's transaction count. Comparisons
must concern the same complete group scope, not different query windows.
Coverage is carried as a collection of independently comparable `scopeKey`
and date-range entries, so a multi-account or multi-currency capture does not
imply one shared transaction group. The coverage array inventories the source
buckets queried by that capture, including explicit entries for buckets with
zero rows; an unqueried bucket's absence is not evidence of a count decrease.

Credit-card captures use a stronger queried-bucket proof because statement
periods can age out of a rolling history while an indistinguishable transaction
group is partitioned by its effective date. Each complete card capture records
the exact full inventory of queried billed periods and the unbilled grid (or,
for E.SUN, the requested timeline months or combined requested range), including
empty buckets. Counts are comparable only when the full inventory is identical;
when it changes, the capture does not prove that an omitted prior bucket became
empty. For equal inventories, compare the total per semantic group across all
buckets in each capture, then compare captures; do not add historical totals
from separate captures. Bucket labels and each row's bucket membership are
collection provenance only and do not participate in the semantic fingerprint
or durable occurrence key. If indistinguishable rows cross billing states or
query buckets within one capture, reject them unless the source proves the rows
are separate occurrences.

## Confirmed decision: workflow coverage and collection completeness

Review every financial transaction workflow. Retain reliable source-provided
identifiers where available; use group ordinals where the source lacks a
reliable occurrence identifier and its contract can establish complete groups.
Existing loan and credit-card ordinal strategies are included in completeness
and count-reduction checks. A shared mechanism owns ordinal assignment and
continuity checks; source contracts own identity fields and completeness proof.

Adjust collection boundaries and combine all required pages to obtain the
complete date or statement-period scope established by the source contract.
If completeness still cannot be proved, reject admission rather than count a
partial response as a complete group. Only comparable covered scopes may be
checked for count reduction; moving a query window past a group is not evidence
that an occurrence disappeared. This broadens the product-specific precedent
in ADR 0026 without making its Fubon balance-evolution policy generic.

### MaiCoin MAX v3 source audit

MAX v3's [official OpenAPI contract](https://max-api.maicoin.com/api/doc/external/v3)
requires an int64 `id` for trade rows, a string `uuid` for reward rows, and a
string `sn` for deposit, withdrawal, transfer, and convert rows. MaiCoin therefore
keeps those provider IDs
as transaction identity and does not assign occurrence ordinals or fall back to
them when a required ID is missing or invalid. Trade history pages in ascending
`from_id` order; timestamp-based statement histories use the provider's inclusive
`created_at >= timestamp` cursor. The collector retains overlap at that cursor,
drops a repeat only when its required native ID and full payload match, and
rejects a changed payload for the same ID or a saturated timestamp boundary.
All endpoint batches must prove the same complete date range before the
canonical capture is admitted; the history range remains separate from the
snapshot's HTTP-Date effective date, including when every history endpoint is
empty. A `self-trade` row remains fail-closed until the adapter can represent
its fee-bearing economic legs without omitting effects.

### Yuanta Fund and Trade source audit

The Yuanta Trade report exposes optional reference columns such as trade or
order numbers, but the audited report contract does not establish them as
unique fill IDs. Transaction rows therefore use semantic group slots. A Trade
history capture must include every requested report type for the same exact
date range. The collector accepts only complete inline grid arrays with no
remote transport, unproven server paging, or declared total that disagrees with
the captured row count; an incomplete or missing report blocks admission.

Yuanta Fund likewise exposes transaction numbers without a contract guarantee
that they identify each occurrence. Current holdings do not enumerate closed
positions, so per-current-position detail queries cannot authorize complete
account history. The general history source instead covers the account across
`single`, `type2` and `type3`: single purchases use `buy`, periodic purchases use
`deduct`, and every type has `sell/trans/profit/devide`. The mutually exclusive
purchase options are established by the source query-option handler and guided
page observations. Periodic `change` reports standing-instruction settings,
with no executed cash or units; it does not produce financial occurrences.

The collector requires all fifteen financial query results, exact requested
dates, cleared position filters, response-associated request verification, and
an unpaged result. Every empty report must explicitly state `查無資料`. Coverage
inventories the three complete account scopes, rather than the current holding
lots. Missing reports or unidentified historical securities reject the whole
capture. If all current positions are closed, explicit source absence permits
history collection; the entire dated transaction set and coverage remain in one
capture. An empty current inventory alone never asserts zero historical
transactions. Explicit absence combined with all fifteen explicitly empty
reports still admits one coverage-only capture. Its effective scope boundary
is the verified history end date; no holding, zero balance, or valuation date
is invented. Independent repeated collections retain distinct captures and
the same empty financial transaction set. Holding and margin-balance observations retain their own source
identity and do not receive transaction ordinals.

## Confirmed decision: group growth

A later complete, comparable capture may increase a group's count when the
existing financial claims remain consistent. Preserve the established slots
and append additional slots. This establishes multiplicity, not individual
historical continuity. Slot assignment must not depend on unrelated rows,
page positions, query-range ordinals, capture IDs, or a database-wide counter.

## Confirmed decision: collection duplicates

Exclude a technical recollection only when a reliable source identifier or
source collection-scope evidence establishes that it is the same observation.
Equal transaction content alone must not collapse distinct occurrences.
Avoid overlapping query partitions where possible and do not accumulate both
a request attempt and its retry as independent transaction rows. If unresolved
overlap or recollection ambiguity affects group multiplicity, reject admission
before assigning slots or writing canonical financial data.

## Implementation boundaries and acceptance

- Audit source identity and completeness contracts for all transaction workflows,
  including deposits, loans, cards, investments, crypto and invoices. Retain
  contract-established source identifiers; an identity conflict must not silently
  fall back to group slots. Balance-only or non-transaction records do not acquire
  transaction ordinals.
- Source adapters supply their stable fingerprint, account/product scope,
  complete date or statement-period boundary, and collection provenance. The
  shared module validates complete groups and assigns group ordinals after
  required pages and partitions have been assembled. A query window is coverage
  evidence, not part of durable slot identity.
- Admission persists and compares group multiplicity in the same transaction
  as the financial capture. Detect reductions including a previously nonempty
  group becoming empty, but only where the later coverage proves that group
  complete. Uncovered dates or statement periods are not count reductions.
- A conflicting or incomplete capture has no partial canonical effect within
  its commit boundary. This does not introduce a transaction covering every
  workflow in Sync All.
- Keep permitted provider-specific financial evolution explicit. A group ordinal
  is not evidence of a correction, cancellation, or balance evolution; the
  existing Fubon loan allowlist does not become a generic allowance.
- Tests cover identical rows preserving multiplicity, unrelated row insertion,
  page and query partition changes, group growth, count reduction to one or zero,
  moving windows, incomplete pages, retry/overlap ambiguity, source-ID conflicts,
  and atomic rollback. Cover existing card and loan ordinal paths as well as
  newly supported workflows. Review the final uncommitted changes against HEAD.
- Cutover uses a rebuilt database, with no key remapping, old-format readers,
  migration, repair, or automatic purge. The user performs the rebuild and live
  workflow recollection after the implementation is verified.

The user confirmed this design and authorized implementation. The caller will
rebuild the database and recollect workflows after implementation is reviewed.


## Yuanta fund name identity policy

On 2026-10-02 the user explicitly authorized booking with source-reported fund names when fund codes are absent, and required monetary currency to follow the transaction amount label. Fund history reports expose names rather than native codes. The producer therefore consistently uses a NFKC/whitespace-normalized source-name key across holdings and account history; metadata availability never switches that identity to a native code. Native position codes remain source evidence. Original display spelling remains in the captured table, while the fixed Security name uses the same normalization as its key.

Unknown pricing currency is represented explicitly by an empty Security currency; it is not inferred from settlement cash. Each nonzero monetary event requires the amount's explicit currency. Zero-cash unit distributions have no monetary denomination and use the no-currency marker `XXX`. Canonical admission and the database commit boundary share a validator that permits this name identity only for `yuanta-fund`, with exact normalized name/key agreement. Other integrations retain their existing native identity contract.

Product-specific maps and mandatory catalog lookup are removed. Missing descriptive metadata cannot reject otherwise complete financial rows. Complete account history still requires all 15 queries and three investment-type scopes; dates, units, money, footer shapes and occurrence continuity are unchanged. Metadata enrichment and normalized display variations must preserve transaction identity and repeated import counts. Changed names remain distinct named Securities; there is no automatic rename merge or persisted-key migration.
