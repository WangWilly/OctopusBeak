# A store removes derived Kinds a refresh wrote again unchanged

Status: accepted

A projection refresh for a commit that touched no transaction read every transaction but no current Kind. It therefore wrote every derived Kind again, unchanged, as a new assertion with its own output, provenance, transition and taxonomy value. A balance-only capture produces such a commit, so every sync repeated the write. Fixed refreshes write nothing for an unchanged Kind, as the storage spec requires ("without duplicating an unchanged assertion value"). Stores written before the fix hold up to thousands of identical Kind assertions per transaction, which make up most of their size.

ADR 0008 keeps Derived Assertion lineage append-only, and its only hard delete is a Contract Purge. **This ADR adds a second, one-time hard delete: a store removes the derived Kind assertions a refresh wrote again unchanged.**

- **What is removed.** A derived Kind assertion that repeats the assertion before it on the same transaction: same producer, rule lineage, route, value, taxonomy code and output provenance, each with exactly one output, where neither was ever superseded, withdrawn or restored. Its output, provenance, transition and taxonomy value are removed with it. An unsupported Kind output that repeats the output before it is removed too, unless a withdrawal rests on its run.
- **What stays.** The first assertion of each run, which is the one a correct refresh would have kept. Any assertion a category's provenance names as its evidence also stays. Source and User Assertions, categories, enrichment runs and commits are never touched.
- **How.** It runs once, on store open, in one transaction. Current rows move onto the kept assertion the Kind selection picks, so the cleanup writes no commit and the knowledge point does not move. The tables are then rewritten to return the space to the disk; an interrupted rewrite runs again on the next open.
- **When it cannot finish.** The cleanup only returns space. If it fails, it rolls back, keeps every row, and is not tried again; the store opens as before.

The Kind every transaction had at every commit, and the evidence behind it, stay the same. Only the repeats, which say nothing the first assertion does not, disappear.

## Considered options

- **Keep the repeats.** Rejected. They make up most of an affected store and slow every read of Kind history, and they record a defect, not a fact.
- **Keep the last assertion of each run.** Rejected. It changes the Kind an earlier cutoff sees, since the last assertion did not exist yet, and it keeps a row a correct refresh never writes.
- **Rebuild the projection with a full refresh after deleting.** Rejected. It writes a commit, restamps every current row, and costs a full re-derivation, when moving the current rows is enough.

## Consequences

- An assertion's history no longer shows the dates on which the bug repeated it. Nothing reads those dates.
- The cleanup reads each transaction's whole Kind history once. On a large store it takes some time on the first open after the update, and that open waits for it.
