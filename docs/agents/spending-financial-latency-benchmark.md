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
exceeded.

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

The machine-readable report schema is
`spending-financial-latency-report-v1`. It reports p50/p95/p99/max, bounded
stage spans, warm/cold and contention labels, dataset cardinality buckets,
build/hardware profiles, and stable status. The affected-section visibility
boundary is approximated at the public command result → minimal patch seam;
renderer paint is measured separately by Electron acceptance.
