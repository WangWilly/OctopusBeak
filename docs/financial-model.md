# Financial Model And Dashboard

The financial model is built from the append-only raw ledger. It is a second layer: raw rows stay untouched, and the model classifies rows into normalized transactions, asset positions, audit-only rows, or unsupported rows.

## Command

```bash
npm run run:build-financial-dashboard
```

Outputs are written under `data/ledger/`:

- `financial_model.json`
- `financial_model_quality.json`
- `financial_dashboard.html`

`data/` is ignored by git because these files can contain personal financial data.

## Model Semantics

`assetPositions` are the rows used for the integrated asset state. Each position records:

- institution and product
- asset class
- account identifier or source identifier
- currency
- value
- asset/liability/informational sign
- whether it is included in totals
- source file and source row index
- parser id and confidence

Included totals are conservative. Summary rollups that may double-count detailed holdings are marked `includeInTotals: false` and shown as audit-only information in the dashboard.

`normalizedTransactions` are normalized row-level events for cash, card, loan, fund, and brokerage sources where the row shape is supported.

`auditOnlyRows` are rows that the parser understands but does not model as a transaction or position, such as section labels, query metadata, credit limits, dividend detail rows, order rows, or generated positional summary rows.

`unsupportedRows` should stay at zero for the currently supported input set. A non-zero value means a row shape was not understood and should be reviewed before relying on the dashboard.

## Current Coverage

Supported balance/position sources:

- Cathay TWD deposit transactions and latest balances
- Cathay foreign-currency transactions and latest balances
- Fubon TWD deposit transactions and latest balances
- Fubon loan transaction balances
- YuanTa TWD and foreign-currency deposit transactions and latest balances
- YuanTa loan transaction balances
- YuanTa credit-card transactions, payments, and outstanding summaries
- YuanTa fund position rows with explicit market value
- YuanTa brokerage holding rows with explicit TWD market value
- YuanTa brokerage summary rollups as audit-only rows to avoid double counting

Not yet modeled as financial positions:

- Fubon credit-card liability balance, because current CSV rows only expose transactions.
- Some YuanTa fund combined-cell detail rows and order/dividend rows.
- Most generated YuanTa trade section label rows.

These are still preserved in the raw ledger and visible through parser coverage.
