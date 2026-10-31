# Opening a store installs newly registered source contracts

Status: accepted

Amends [ADR 0035](0035-source-contract-catalog-and-rule-admission.md). ADR 0035 made a store open only when its installed source contract catalog equals the registry, with no migration, on the premise that the product had no users and a developer rebuilds the database. OctopusBeak now ships to people who keep their financial data across updates. Under that rule, adding the Binance route ([ADR 0084](0084-binance-declares-bounded-trade-history.md)) made every existing store fail at startup (`automation-runtime-snapshot-failed`), before the person could reach the Canonical Reset.

**When an existing store opens, the App installs every contract version the registry has and the store lacks, with all of its rule tuples, in one transaction. It never rewrites or removes an installed contract.**

- **Additive only.** A contract is identified by its authority route and contract version. One the store lacks is inserted from the compiled registry. An installed contract whose namespace, stream or rule tuples differ from the registry, or one the registry no longer has, is left as it is, and the store still fails closed as ADR 0035 requires.
- **Trust still comes only from the App.** The rows come from the registry compiled into the App, never from a capture or the database. The write guards on both catalog tables are disabled only inside that transaction and are enabled again before it commits, so normal DML still cannot extend trust.
- **Order.** The baseline metadata check runs first, so an older baseline still fails before anything is written. The full catalog assertion runs after the extension.

## Considered options

- **Keep exact equality and require a rebuild.** Rejected. A person updating the App would lose access to their data until they deleted it, and the App could not start far enough to offer the reset.
- **Reset the canonical store automatically.** Rejected. It deletes financial data the person did not choose to delete.
- **Version the catalog with explicit migrations.** Not needed for additions. A changed contract still needs its own decision, because rewriting trust under stored captures would change what those captures were admitted under.

## Consequences

- Adding a Verified source or a new contract version no longer needs a database rebuild.
- Changing or removing an installed contract still makes existing stores fail closed and still needs an explicit decision.
- A store opened by a newer App gains that App's contracts. An older App then sees contracts its registry lacks and fails closed, as before.
