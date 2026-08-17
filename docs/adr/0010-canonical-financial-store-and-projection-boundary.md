# Canonical financial store and projection boundary

Status: accepted

OctopusBeak stores admitted source evidence, source-scoped identities, immutable typed financial revisions, assertion lineage, committed sync state, authority routes, and disposable current projections in one canonical SQLite database so each accepted financial change and its visible projection commit atomically. Operational configuration, secrets, failed attempts, temporary transport state, and scrub jobs remain outside that database; products read only the Current, Historical, and Lineage query contracts and never interpret compact payloads, assertion precedence, or legacy tables themselves.

The write model is hybrid relational rather than EAV or a generic event store: typed domain tables own financial values and real foreign keys, while a shared append-only assertion spine records producer, lifecycle, knowledge time, and provenance. Current projections are transactionally materialized and generation-switched when rebuilt; historical projections are calculated from immutable facts using explicit financial-time and knowledge-time cutoffs. The complete physical specification and transaction boundaries are defined in [Canonical financial storage specification](../specs/canonical-financial-storage.md).

## Consequences

- Canonical commits, accepted Captures, committed Source Sync State, successful complete-scope Import Runs, assertion transitions, and affected current projections share one SQLite transaction.
- Integration contracts must produce total typed values, identity, effective time, Capture Scope completeness, and authority routing before admission. Canonical storage contains no required-value `unknown`, conflict state, correction queue, or partial Capture.
- Financial identity and values are never sourced from JSON, mutable entity rows, current projections, UUID timestamps, SQLite `REAL`, or JavaScript `Number`.
- Contract bugs are handled by scoped Contract Purge and recollection, not Identity Correction or invented migration values. Globally incompatible schema changes use Canonical Reset.
- WAL and application-level serialization provide one canonical writer; readers use snapshot connections through query contracts.

## Rejected alternatives

- Product-specific canonical tables or direct product reads: rejected because they duplicate precedence and historical semantics.
- Generic entities, EAV values, JSON facts, or polymorphic target IDs: rejected because they weaken type, foreign-key, and admission guarantees.
- Mutable assertion status or in-place financial updates: rejected because they erase knowledge-time lineage.
- Materialized historical snapshots: rejected because the immutable write model can answer explicit dual-cutoff history without daily duplication.
- A shared content-addressed payload store: rejected for the first version because compact Source Records are intentionally small and independent Capture occurrences must remain visible.
