# Desktop Mock Data Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop mock ledger with a coherent launch-relative Taiwan household dataset that demonstrates every portfolio, spending, and automation view.

**Architecture:** `mockLedgerQueryData(referenceDate)` remains the typed portfolio fixture boundary and generates every date from one Taipei launch-day anchor. The SQLite seeder consumes that data and adds normalized invoice/item and automation records that are not part of `LedgerQueryData`. Existing migrations and generic row insertion remain unchanged.

**Tech Stack:** TypeScript, Node.js standard library, SQLite via the existing ledger client, Svelte/Electron read models.

## Global Constraints

- Replace the existing typed fixture rows; do not merely shift their dates.
- Use one coherent fictional household and plausible Taiwan-local values.
- Only dates vary by launch day; identifiers and amounts remain deterministic.
- Add no dependency or fixture framework.
- Seed no fake resumable browser session.

---

### Task 1: Coherent launch-relative portfolio fixture

**Files:**
- Modify: `src/lib/shared-ledger/server/mock-data.ts`
- Modify: `src/lib/shared-ledger/server/mock-data.check.ts`

**Interfaces:**
- Produces: `mockLedgerQueryData(referenceDate?: Date): LedgerQueryData`
- Produces: dates derived from a Taipei calendar anchor through local `date(daysOffset)`, `iso(daysOffset, hour)`, and `month(monthsOffset)` helpers.

- [ ] **Step 1: Add failing launch-relative and coherence assertions**

Use a fixed `new Date("2026-07-11T04:00:00.000Z")` in the check. Assert the newest source date is `2026-07-11`, account balances equal the latest balance per account, fund/brokerage values contain both gains and losses, and every required typed table has enough rows for its chart/list.

- [ ] **Step 2: Run the check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/mock-data.check.ts
```

Expected: failure because `mockLedgerQueryData` ignores the supplied launch date and existing balances/names do not satisfy the new scenario.

- [ ] **Step 3: Replace the typed dataset**

Create one household scenario:

| Area | Fixture |
| --- | --- |
| TWD cash | Cathay salary account and LINE Bank reserve; salary, rent, card autopay, savings transfer, ATM withdrawal |
| FX cash | USD travel savings and JPY travel cash with deposits and one fee |
| Cards | Cathay cashback and Fubon travel cards; paid/unpaid, refund, foreign purchase, installment |
| Loans | one mortgage and one car loan with decreasing balances and a principal prepayment |
| Funds | Taiwan index, global bond, technology, and Japan REIT positions; positive and negative returns plus buy/redemption/dividend/conversion activity |
| Brokerage | TSMC, Taiwan 50 ETF, world ETF, bond ETF, and settlement cash; buys and sells with one realized gain |
| Crypto | BTC, ETH, USDC assets and one USDT margin liability; trade/deposit/withdrawal/reward rows |

All arrays must use the same account/product identifiers and reconcile obvious relationships such as latest loan balances and account balances.

- [ ] **Step 4: Run the focused check**

Run the Task 1 command. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared-ledger/server/mock-data.ts src/lib/shared-ledger/server/mock-data.check.ts
git commit -m "test: rebuild coherent portfolio mock data"
```

### Task 2: Spending and automation SQLite fixtures

**Files:**
- Modify: `src/ledger/seed-mock-ledger-db.ts`
- Create: `src/ledger/seed-mock-ledger-db.check.ts`

**Interfaces:**
- Produces: `seedMockLedger(ledgerDir: string, referenceDate?: Date): string`
- Consumes: `mockLedgerQueryData(referenceDate)` from Task 1.

- [ ] **Step 1: Add a failing temporary-ledger check**

Create a temporary directory, call `seedMockLedger(root, new Date("2026-07-11T04:00:00.000Z"))`, and assert:

- four distinct confirmed invoice months
- all seven category identifiers
- at least one multi-item invoice
- one voided invoice excluded by the spending store
- item categories can be updated and read back
- latest automation runs include `completed` and `failed`
- source and typed row counts are non-zero

- [ ] **Step 2: Run the check and verify it fails**

```bash
node --no-warnings --experimental-strip-types src/ledger/seed-mock-ledger-db.check.ts
```

Expected: failure because the seeder has no export and does not populate invoice or automation tables.

- [ ] **Step 3: Export the seeder and preserve CLI behavior**

Move the current body into `seedMockLedger`, return the SQLite path, and run `main()` only when `import.meta.url` matches `process.argv[1]`. Keep `desktop:dev:mock` unchanged.

- [ ] **Step 4: Seed normalized invoices and items**

Generate four months of purchases from fixed templates and launch-relative timestamps. Include groceries, restaurants, transit/fuel, household supplies, clothing/electronics, leisure/subscriptions, and uncategorized fees. Use stable `invoice_key` and `item_key` values, integer sequence numbers, confirmed statuses for visible rows, and one voided invoice.

- [ ] **Step 5: Seed automation history**

Insert current-day completed crawler/import runs and one failed E-Invoice run with a readable error message and log tail. Do not use `waiting_human`, because there is no corresponding live Libretto session.

- [ ] **Step 6: Run the seed check**

Run the Task 2 command. Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ledger/seed-mock-ledger-db.ts src/ledger/seed-mock-ledger-db.check.ts
git commit -m "feat: seed complete desktop mock ledger"
```

### Task 3: End-to-end mock desktop verification

**Files:**
- Modify only if verification exposes a fixture defect in Task 1 or Task 2 files.

**Interfaces:**
- Consumes: `npm run run:seed-mock-ledger-db -- "$PWD/data/mock-desktop/data/ledger"`

- [ ] **Step 1: Run focused and static verification**

```bash
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/mock-data.check.ts
node --no-warnings --experimental-strip-types src/ledger/seed-mock-ledger-db.check.ts
npm run typecheck
git diff --check
```

Expected: all exit 0 and Svelte reports zero errors/warnings.

- [ ] **Step 2: Regenerate the actual desktop mock ledger**

```bash
npm run run:seed-mock-ledger-db -- "$PWD/data/mock-desktop/data/ledger"
```

Expected: `data/mock-desktop/data/ledger/ledger.sqlite` is recreated successfully.

- [ ] **Step 3: Verify the Electron UI**

Run `npm run desktop:dev:mock` with CDP enabled and inspect `#/overview`, `#/assets`, `#/liabilities`, `#/spending`, and `#/automation` at desktop and compact widths. Confirm charts are nonblank, lists contain realistic labels, all spending categories appear, an invoice modal can edit a category, and no console or invalid-SVG errors occur.

- [ ] **Step 4: Commit any fixture corrections**

```bash
git add src/lib/shared-ledger/server/mock-data.ts src/lib/shared-ledger/server/mock-data.check.ts src/ledger/seed-mock-ledger-db.ts src/ledger/seed-mock-ledger-db.check.ts
git commit -m "fix: polish desktop mock scenarios"
```
