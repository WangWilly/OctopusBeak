# Interaction and pairing performance contract

Status: accepted

The desktop UI treats responsiveness and Spending Pairing as explicit product
contracts. Every user click must produce a perceivable response within 200 ms;
the complete data operation may continue asynchronously. Opening candidate
Pairing choices and confirming a Pairing must each finish within one second,
including cold-start work, while preserving complete candidate coverage and
financial correctness.

## Context

The initial page implementation could wait for several independent data loads
before showing the shell. Spending Pairing could also perform candidate
calculation and a full report recomputation in the renderer's critical path.
Those choices make a slow source or large ledger feel like a frozen desktop
application even when the underlying operation is progressing.

The product needs an objective boundary that distinguishes immediate feedback
from eventual data completion, and a reproducible Pairing target that cannot
be met by silently dropping candidates or weakening the spending
deduplication rules.

## Decision

### 1. 200 ms is the interaction-feedback budget

For every click covered by the desktop UI, one of the following must be
observable within 200 ms: navigation, a state transition, a disabled/busy
state, a spinner, or an error acknowledgement. The budget does not require a
network, database, or projection result to complete in that interval.

Data preparation, parsing, indexing, and projection work must not block the
renderer main thread. CPU-heavy work crosses an existing worker boundary or is
split into yieldable asynchronous chunks. Main-thread long tasks are part of
acceptance evidence; cursor, hover, scroll, and click feedback must remain
usable while data work is pending.

### 2. Pairing has a hard one-second completion budget

The following operations are independently measured from the user's action to
an interactive result:

1. opening the Pairing candidate list, including candidate indexing and
   complete ordering; and
2. confirming the selected Spending deduplication link, including its
   indivisible write and the affected-record/summary update.

Both operations must finish within one second for cold and warm runs on the
current development machine. The benchmark records the machine model, RAM,
macOS, Electron, and Node versions. Its first supported data set contains
100,000 transactions, 10,000 invoices, and 10,000 existing links.

Candidate indexes may be reused while the data version is unchanged and must
be invalidated when transactions, invoices, or existing links change. A
successful confirmation updates only affected records and summary deltas;
it does not synchronously rebuild unrelated report blocks. Candidate
completeness, ordering quality, one-to-one link constraints, and the atomic
write contract remain unchanged.

### 3. Evidence is local and reproducible

The project maintains repeatable cold/warm benchmarks, end-to-end Pairing
tests, and renderer long-task checks. Shell startup, navigation, global
refresh, opening candidates, and confirming Pairing are covered. Independent
functional cases may run in parallel, but contention-sensitive performance
benchmarks run in isolation so their numbers remain credible. No external
user-performance telemetry is collected.

If the one-second target cannot be met at the supported data size while
preserving correctness, implementation stops at measured evidence: the
bottleneck and alternatives are reported for an explicit product decision.
The implementation does not silently move work to the background, truncate
candidates, or relax the target.

## Consequences

- Users receive immediate feedback even when a projection or Pairing request
  is still running.
- Worker boundaries and incremental updates become part of the acceptance
  surface rather than optional optimizations.
- Large synthetic fixtures make future regressions visible before real ledgers
  grow to the same size.
- The current development machine is a reproducible baseline, not a promise
  that every unsupported machine has identical timings.

## Rejected alternatives

- Requiring every click's complete data operation to finish in 200 ms: remote
  and disk work cannot meet that bound reliably, and it would encourage
  unsafe shortcuts.
- Showing a "processing" message within one second while Pairing continues
  indefinitely: it avoids measuring the user-visible result and weakens the
  requested contract.
- Sorting only a prefix of transactions or changing the order later: this can
  hide the correct candidate and changes the meaning of explicit confirmation.
- Measuring only warm cache runs: the first user interaction would remain
  slow and the cold-start path would be untested.
- Sending remote telemetry: it is outside this product's privacy and
  acceptance scope.

## Verification

Phase-specific tests must report the fixed data-set shape and full environment
metadata alongside cold/warm timings. The refresh coordinator and worker
seams are verified separately from the UI, while the final integration suite
checks that the shell stays interactive during those asynchronous operations.
