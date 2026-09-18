# Spending financial latency benchmark

The benchmark uses only deterministic synthetic ledger data. The checked-in
profile contains cardinality envelopes, not accounts, merchants, invoices,
transaction identities, amounts, SQL, paths, or source payloads.

Run the small local smoke check with:

```bash
npm run bench:spending-latency
```

Run the shared regression budget with:

```bash
npm run bench:spending-latency:ci
```

The CI report is written to
`reports/spending-financial-latency-ci.json`. The command exits non-zero when
an iteration minimum or the normal/contention p99/max regression budget is
exceeded. The normal and contention p99 budgets are 200 ms and 500 ms;
maximum latency is a separate regression guard and never substitutes for p99.

Formal acceptance runs the complete 1x/2x × warm/cold × normal/contention
matrix, with direct pair, candidate confirmation, and unlink operations. It
requires at least 1,000 timed operations per scenario:

```bash
npm run bench:spending-latency:formal
```

The formal report is written to
`reports/spending-financial-latency-formal.json`. Run it in a fixed performance
environment and record the hardware profile explicitly when needed, for
example:

```bash
node --no-warnings --experimental-strip-types \
  scripts/spending-financial-latency-benchmark.mjs \
  --mode formal --hardware medium \
  --output reports/spending-financial-latency-formal.json \
  --checkpoint reports/spending-financial-latency-formal.checkpoint.json
```

The formal command writes an atomic checkpoint after every completed scenario
to `reports/spending-financial-latency-formal.checkpoint.json`. Progress is
printed as privacy-bounded scenario keys on stderr, so a long run remains
observable without exposing account, invoice, transaction, amount, SQL, or
payload data. If the process is interrupted, continue with:

```bash
npm run bench:spending-latency:formal -- --resume
```

Resume accepts a checkpoint only when its schema, profile fingerprint, seed,
build profile, hardware profile, iteration/selection matrix, and contention
delay match the current command. It skips only scenario records that pass the
complete scenario contract validation; corrupt, truncated, incompatible, or
unexpected checkpoint data fails closed. The final formal report is accepted
only when all 24 expected scenario keys are present. A partial checkpoint is
progress evidence, never a formal success report.

The worker-side machine-readable report schema is
`spending-financial-latency-worker-report-v1`. It reports p50/p95/p99/max,
bounded stage spans, warm/cold and contention labels, dataset cardinality
buckets, build/hardware profiles, and stable status. Its boundary explicitly
sets `uiVisibleProjectionMeasured: false` and `syntheticPatchMeasured: false`.
The benchmark contains no synthetic patch-as-paint claim.

Electron/CDP acceptance measures the missing boundary:

```bash
node --no-warnings --experimental-strip-types \
  scripts/spending-financial-latency-electron.mjs \
  --mode formal --cdp-endpoint http://127.0.0.1:9222 \
  --fixture-user-data /tmp/octopusbeak-171-cdp \
  --route 'file:///path/to/app/#/spending' \
  --hardware medium \
  --output reports/spending-financial-latency-electron-formal.json \
  --checkpoint reports/spending-financial-latency-electron-formal.checkpoint.json
```

The CDP runner requires the disposable user-data root created by
`desktop:dev:cdp-fixture`; `--fixture-user-data` is fail-closed for normal user
stores. It prepares deterministic 1x/2x datasets, snapshots each scale for
fast scenario reset, reloads the renderer for cold iterations, and brackets
contention iterations with a real SQLite `BEGIN IMMEDIATE` writer lock. These
controls live in the benchmark fixture module, not in the production renderer
API.

The runner measures from confirmation click through two renderer animation
frames after the affected section visibly changes. The visibility oracle
requires a ready `[data-purchase-report]` projection, an expected link or
candidate state transition, and a durable knowledge point that advanced (or a
known replay whose current state is already visible). Spinner changes, error
states, unrelated DOM mutations, and synthetic patches cannot pass. Its
boundary is `renderer-confirmation-to-visible-current-projection`, with
`domPaintMeasured: true` and `syntheticPatchMeasured: false`. It covers direct
pair, candidate confirmation, and unlink operations. Formal mode requires at
least 1,000 operations for every scenario and supports the same atomic,
privacy-bounded checkpoint/resume flow. The report contains only cardinality
and control-readiness markers; it never includes financial identifiers,
amounts, SQL, paths, or source payloads.

The formal acceptance aggregator requires both reports:

```bash
npm run bench:spending-latency:acceptance
```

Missing Electron-visible evidence is incomplete, not a pass. The aggregator
checks the complete 24-scenario matrix and applies the 200 ms normal / 500 ms
contention p99 budget independently to the worker and renderer-visible
measurements. The worker report diagnoses command latency, but only the
Electron-visible report proves the affected projection reached the screen.

For efficient local verification, run the focused contract checks first; do not
run the formal 24,000-operation Electron matrix in a worker checkout:

```bash
node --no-warnings --experimental-strip-types --test \
  scripts/spending-financial-latency-electron.check.mjs \
  scripts/spending-financial-latency-fixture.check.mjs
```
