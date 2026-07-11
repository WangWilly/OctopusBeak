# Desktop Mock Data Refresh

## Goal

Rebuild the `desktop:dev:mock` ledger as one coherent fictional Taiwan household dataset. It must make every implemented dashboard feature visible immediately and keep dates current on every launch.

## Data Design

- Replace the existing typed fixture rows rather than preserving or merely shifting them.
- Derive all dates from one launch-day UTC anchor using explicit day/month offsets.
- Use consistent accounts, cards, loans, funds, brokerage positions, and crypto balances with plausible TWD values and transaction histories.
- Include enough historical snapshots to render overview, asset, and liability charts with gains, losses, deposits, withdrawals, repayments, and multiple currencies.
- Seed four months of normalized `personal_invoices` and `personal_invoice_items`, covering all seven spending categories, multi-item invoices, an excluded voided invoice, and user-editable categories.
- Seed automation task history with successful current-day runs and one failed latest run so both completed and attention states are visible without creating a fake resumable browser session.

## Implementation

- Keep `src/lib/shared-ledger/server/mock-data.ts` as the typed source for portfolio rows, but replace its dataset and expose a launch-date argument.
- Extend `src/ledger/seed-mock-ledger-db.ts` with the invoice and automation rows that belong to their physical SQLite tables.
- Reuse the existing generic insert helpers and database migrations; add no fixture framework or dependency.

## Verification

- Expand the existing mock-data check for launch-relative dates and coherent balances.
- Add a seed check that creates a temporary ledger and verifies portfolio tables, spending months/categories, confirmed-versus-voided filtering, automation states, and editable category persistence.
- Run focused checks, typecheck, and generate the actual `data/mock-desktop/data/ledger/ledger.sqlite` used by `desktop:dev:mock`.
