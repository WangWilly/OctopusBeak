# Asset Account Spending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include confidently classified asset-account outflows in `#/spending`, keep ambiguous or non-consumption rows out of totals, let users override every automatic decision, and present invoice/account spending as two rounded category-stacked bars per period.

**Architecture:** Extend the ledger with a small override table keyed by the existing `account_transactions.statement_row_id`. `loadSpending` reads invoices, account withdrawals, counterpart deposits, genuine card-payment rows, and overrides; pure model functions classify transactions and build display-ready records and per-source totals. The existing Electron IPC bridge persists overrides. Svelte keeps the current page hierarchy, renders date-grouped records with sticky headers, and reuses one paired-bar component for monthly and daily charts.

**Tech Stack:** TypeScript, Node SQLite (`better-sqlite3` through the existing ledger client), Electron IPC/preload, Svelte 5, LayerChart, existing `node:assert` checks.

## Global Constraints

- Preserve the approved page order: monthly card, month toolbar/daily-modal button, daily records card.
- Do not add top-level metrics, reconciliation equations, a second dashboard, or dependencies.
- Keep the daily chart in `DailySpendingModal` only.
- Count only `included` records. `excluded` and `pending` rows remain visible and reversible.
- A manual override always wins; deleting it restores current automatic classification.
- Use exact, explainable matching. A generic `繳費`, `轉帳`, or cash withdrawal must not become a confident exclusion or purchase.
- Use `statement_row_id` as the persisted ledger identity; never copy the source transaction into the override table.
- Keep classification and aggregation pure and covered by one focused model check.
- Keep persistence covered by one focused store check.

---

### Task 1: Add persistent account-spending overrides

**Files:**
- Modify: `src/ledger/db/migrations.ts:1320-1425`
- Modify: `src/ledger/db/migrations.check.ts` near the version-22 migration check and final cleanup

- [ ] **Step 1: Write the failing migration check**

Add a temporary ledger directory and assert that migration 23 creates the table and constraints:

```ts
const spendingOverrideLedgerDir = mkdtempSync(join(tmpdir(), "spending-overrides-"));
const spendingOverrideDb = openLedgerDatabase(spendingOverrideLedgerDir);
spendingOverrideDb.prepare(`
  INSERT INTO spending_transaction_overrides (
    statement_row_id, state, category, automatic_state,
    automatic_reason, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`).run(
  "account-row-1", "included", "food", "excluded",
  "credit_card_payment", "2026-07-16T00:00:00.000Z",
);
assert.throws(() => spendingOverrideDb.prepare(`
  INSERT INTO spending_transaction_overrides (
    statement_row_id, state, automatic_state, updated_at
  ) VALUES ('bad', 'unknown', 'pending', '2026-07-16T00:00:00.000Z')
`).run(), /CHECK constraint failed/);
```

Include `spendingOverrideLedgerDir` in the existing `finally` cleanup loop.

- [ ] **Step 2: Run the migration check and confirm it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/db/migrations.check.ts
```

Expected: failure with `no such table: spending_transaction_overrides`.

- [ ] **Step 3: Implement migration 23**

Add a migration helper and entry:

```ts
function createSpendingTransactionOverrides(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE spending_transaction_overrides (
      statement_row_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('included', 'excluded', 'pending')),
      category TEXT CHECK (
        category IS NULL OR category IN (
          'food', 'daily', 'transport', 'shopping', 'home', 'leisure', 'other'
        )
      ),
      automatic_state TEXT NOT NULL
        CHECK (automatic_state IN ('included', 'excluded', 'pending')),
      automatic_reason TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}
```

Append migration `{ version: 23, name: "spending_transaction_overrides", up: createSpendingTransactionOverrides }`. Do not add a foreign key: overrides must survive a temporarily missing source transaction.

- [ ] **Step 4: Re-run the migration check**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: persist spending transaction overrides"
```

---

### Task 2: Model conservative classification and per-source totals

**Files:**
- Modify: `src/lib/spending/model.ts:6-161`
- Modify: `src/lib/spending/model.check.ts`

- [ ] **Step 1: Write one failing focused model check**

Extend the existing check with fixtures covering all required branches:

```ts
const accountTransactions: SpendingAccountTransactionInput[] = [
  accountRow("direct", 880, "簽帳消費 好市多", "2026-07-16"),
  accountRow("card-payment", 19_356, "玉山信用卡款", "2026-07-16"),
  accountRow("self-transfer", 5_000, "自轉", "2026-07-15"),
  accountRow("mirrored", 3_000, "轉帳", "2026-07-14"),
  accountRow("cash", 2_000, "提款", "2026-07-13"),
  accountRow("invoice-duplicate", 100, "測試商店", "2026-02-01"),
];

const model = buildSpendingModel({
  invoices,
  accountTransactions,
  counterpartDeposits: [depositRow("other-account", 3_000, "2026-07-15")],
  cardPayments: [cardPaymentRow(19_356, "2026-07-15")],
  overrides: [{
    statementRowId: "card-payment",
    state: "included",
    category: "home",
    automaticState: "excluded",
    automaticReason: "credit_card_payment",
    updatedAt: "2026-07-16T00:00:00.000Z",
  }],
});
```

Assert:

- explicit direct purchase is included;
- explicit card payment and loan payment are automatically excluded;
- explicit or mirrored self-transfer is excluded;
- generic cash/transfer is pending;
- exact same-date, same-amount purchase with normalized merchant overlap attaches to the invoice and adds no second amount;
- manual `included` card-payment override wins;
- selected-month total includes invoices plus included account rows only;
- `monthlyRows` and `dailyRows` expose separate `invoice` and `account` category maps;
- date groups are newest-first and report included total, excluded count, and pending count.

- [ ] **Step 2: Run the model check and confirm it fails**

```bash
node --no-warnings --experimental-strip-types --test src/lib/spending/model.check.ts
```

Expected: type/export failures for the new DTOs and `buildSpendingModel` input.

- [ ] **Step 3: Add explicit DTOs and state/reason unions**

Keep them in `model.ts` to avoid a second model layer:

```ts
export type SpendingState = "included" | "excluded" | "pending";
export type SpendingSource = "invoice" | "account";
export type SpendingReason =
  | "direct_purchase"
  | "credit_card_payment"
  | "loan_payment"
  | "internal_transfer"
  | "invoice_duplicate"
  | "ambiguous_transfer"
  | "cash_withdrawal"
  | "unclassified";

export type SpendingAccountTransactionInput = {
  statementRowId: string;
  bank: string;
  accountNumber: string | null;
  currency: string;
  date: string;
  description: string | null;
  note: string | null;
  amount: number;
};

export type SpendingOverrideDto = {
  statementRowId: string;
  state: SpendingState;
  category: SpendingCategory | null;
  automaticState: SpendingState;
  automaticReason: SpendingReason | null;
  updatedAt: string;
};
```

Add display-ready account records containing `key`, source, final state, automatic state/reason, manual flag, date, label, amount, and category. Keep invoice details intact for `InvoiceDetailModal`.

- [ ] **Step 4: Implement pure conservative classification**

Add small helpers in `model.ts`:

```ts
function automaticAccountDecision(
  row: SpendingAccountTransactionInput,
  deposits: readonly SpendingAccountTransactionInput[],
  invoices: readonly SpendingInvoiceDto[],
  cardPayments: readonly SpendingCardPaymentInput[],
): { state: SpendingState; reason: SpendingReason; category: SpendingCategory } {
  // Ordered from strongest exclusions/duplicate match to direct purchase,
  // then conservative pending fallback.
}
```

Use these exact policy gates:

1. `放款繳款` or explicit loan-payment wording -> `excluded/loan_payment`.
2. explicit `信用卡款`, `信用卡費`, `繳信用卡` wording, or same-amount genuine negative card-payment row within two local calendar days -> `excluded/credit_card_payment`; plain `繳費` does not match.
3. explicit `自轉` or normalized text containing another owned account number -> `excluded/internal_transfer`.
4. same currency and amount deposit in another owned account within two local calendar days -> `excluded/internal_transfer`.
5. exact amount and date plus normalized merchant overlap with an included invoice -> `excluded/invoice_duplicate`, and keep the account source reference on the invoice display record.
6. explicit purchase/debit-card wording such as `簽帳消費` -> `included/direct_purchase`.
7. cash withdrawal -> `pending/cash_withdrawal`.
8. generic transfer -> `pending/ambiguous_transfer`.
9. anything else -> `pending/unclassified`.

Normalize only whitespace, punctuation, full-width forms, and case. Do not fuzzy-match amounts or merchant names.

- [ ] **Step 5: Refactor `buildSpendingModel` around display-ready records**

Change the call shape to one object so future inputs do not grow positional parameters:

```ts
buildSpendingModel({
  invoices,
  accountTransactions,
  counterpartDeposits,
  cardPayments,
  overrides,
  selectedMonth,
  selectedCategory,
})
```

Use source-separated chart rows:

```ts
type SpendingSourceAmounts = {
  invoice: SpendingCategoryAmounts;
  account: SpendingCategoryAmounts;
};
type MonthlySpendingRow = SpendingSourceAmounts & { month: string; total: number };
type DailySpendingRow = SpendingSourceAmounts & { date: string; total: number };
```

Apply overrides after automatic classification. Count only final `included` account records. Return `recordsByDate` newest-first and selected-month excluded/pending collections for the disclosure.

- [ ] **Step 6: Re-run the model check**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/spending/model.ts src/lib/spending/model.check.ts
git commit -m "feat: classify account spending conservatively"
```

---

### Task 3: Load account rows and persist manual overrides

**Files:**
- Modify: `src/lib/spending/server/store.ts:1-117`
- Modify: `src/lib/spending/server/store.check.ts:1-180`

- [ ] **Step 1: Extend the failing store check**

Add helpers that insert two withdrawal rows, one counterpart deposit, and one explicit card payment into `account_transactions`. Assert that `loadSpending` returns classified display records and source-separated totals.

Then persist and reload:

```ts
updateSpendingTransactionOverride({
  statementRowId: "card-payment",
  state: "included",
  category: "home",
  automaticState: "excluded",
  automaticReason: "credit_card_payment",
}, ledgerDir);

assert.equal(
  loadSpending(ledgerDir).accountRecords.find((row) => row.statementRowId === "card-payment")?.state,
  "included",
);

updateSpendingTransactionOverride({ statementRowId: "card-payment", state: null }, ledgerDir);
assert.equal(
  loadSpending(ledgerDir).accountRecords.find((row) => row.statementRowId === "card-payment")?.state,
  "excluded",
);
```

Also assert validation for blank IDs, unknown states/categories, and missing source rows when creating an override.

- [ ] **Step 2: Run the store check and confirm it fails**

```bash
node --no-warnings --experimental-strip-types --test src/lib/spending/server/store.check.ts
```

Expected: missing `updateSpendingTransactionOverride` and missing account records.

- [ ] **Step 3: Expand `loadSpending` in one database session**

Keep the existing invoice query. Add:

- all deduplicated account withdrawals with positive `withdrawal_amount`;
- deposits needed for mirrored-transfer detection;
- genuine card-payment lines from `credit_card_statement_lines` where the signed TWD amount is negative, retaining payment date and absolute amount for exact nearby-date matching;
- all override rows;
- the existing normalized row identity (`statement_row_id`) as the stable key.

Map SQLite rows to the model input types, call `buildSpendingModel` server-side, and return the display-ready `SpendingPageDto`. Do not send raw payload JSON to the renderer.

- [ ] **Step 4: Implement override upsert/delete**

```ts
export function updateSpendingTransactionOverride(
  input: SpendingOverrideUpdate,
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  // state === null: DELETE by statement_row_id (restore automatic)
  // otherwise validate, confirm source row exists, and UPSERT state/category/
  // automatic snapshot/updated_at.
}
```

Use `new Date().toISOString()` in the store. Persist `automaticState` and `automaticReason` from the row currently shown to explain what the user overrode; classification still recalculates on load.

- [ ] **Step 5: Re-run the focused store check**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/spending/server/store.ts src/lib/spending/server/store.check.ts
git commit -m "feat: load and override account spending"
```

---

### Task 4: Expose override updates through Electron

**Files:**
- Modify: `src/lib/desktop/api.ts:1-102`
- Modify: `src/lib/desktop/api.check.ts:1-34`
- Modify: `electron/preload.ts:27-31`
- Modify: `electron/ipc.ts:20-67`

- [ ] **Step 1: Make the desktop API channel check fail**

Add `"spending:updateTransactionOverride"` immediately after `spending:updateItemCategory` in the expected channel list.

- [ ] **Step 2: Run the focused check**

```bash
node --no-warnings --experimental-strip-types --test src/lib/desktop/api.check.ts
```

Expected: channel array mismatch.

- [ ] **Step 3: Add one typed bridge method**

In `OctopusBeakApi.spending` add:

```ts
updateTransactionOverride(input: SpendingOverrideUpdate): Promise<{ ok: true }>;
```

Add the channel constant, preload invocation, store import, and IPC handler. Keep validation in the store so direct IPC callers cannot bypass it.

- [ ] **Step 4: Run the check and typecheck**

```bash
node --no-warnings --experimental-strip-types --test src/lib/desktop/api.check.ts
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/desktop/api.ts src/lib/desktop/api.check.ts electron/preload.ts electron/ipc.ts
git commit -m "feat: expose spending overrides to renderer"
```

---

### Task 5: Render paired rounded category bars

**Files:**
- Modify: `src/lib/spending/components/SpendingBarChart.svelte:1-340`
- Modify: `src/lib/spending/components/DailySpendingModal.svelte:1-110`
- Modify: `src/lib/spending/SpendingDashboard.svelte:338-370`
- Modify: `src/lib/i18n/i18n.ts` spending dictionaries near lines 97 and 491

- [ ] **Step 1: Flatten each period into two chart buckets**

Inside `SpendingBarChart`, derive:

```ts
type SourceBucket = SpendingCategoryAmounts & {
  bucketKey: string;
  periodKey: string;
  source: "invoice" | "account";
};

$: buckets = rows.flatMap((row) => ([
  { ...row.invoice, bucketKey: `${rowKey(row)}:invoice`, periodKey: rowKey(row), source: "invoice" },
  { ...row.account, bucketKey: `${rowKey(row)}:account`, periodKey: rowKey(row), source: "account" },
] satisfies SourceBucket[]));
```

Feed `buckets` to the existing stacked `BarChart`. Keep category series and category toggling unchanged.

- [ ] **Step 2: Apply the approved palette and rounding**

Replace the bright spending colors with the established low-chroma sequence:

```ts
food: "oklch(52% 0.11 250)",
daily: "oklch(52% 0.09 170)",
transport: "oklch(56% 0.10 70)",
shopping: "oklch(53% 0.08 320)",
home: "oklch(50% 0.07 35)",
leisure: "oklch(49% 0.06 215)",
other: "oklch(46% 0.035 250)",
```

Use narrow bands and visibly rounded outer silhouettes (`radius` around 8-10). Retain the one-pixel surface separator between stacked segments. If LayerChart rounds internal segment corners, apply an SVG clip path per bucket rather than reducing the approved rounding.

- [ ] **Step 3: Make selection and tooltips period-aware**

Compute the selected outline from the invoice bucket x-position through the account bucket's right edge. Set `rx` to match the more rounded bars. Clicking either source bucket calls `onBarClick(periodKey)`.

Tooltip content must show:

- period label;
- invoice subtotal;
- account subtotal;
- combined confirmed total;
- visible category breakdown.

Add a short source key below the chart: `左：電子發票` and `右：帳戶支出`. Keep the existing category legend.

- [ ] **Step 4: Reuse the same component in the daily modal**

Only update prop types and wording in `DailySpendingModal`; do not embed another chart in the records card.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS with no Svelte accessibility warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/spending/components/SpendingBarChart.svelte src/lib/spending/components/DailySpendingModal.svelte src/lib/spending/SpendingDashboard.svelte src/lib/i18n/i18n.ts
git commit -m "feat: show paired spending source bars"
```

---

### Task 6: Replace the invoice-only list with reversible daily records

**Files:**
- Modify: `src/lib/spending/SpendingDashboard.svelte:1-700`
- Modify: `src/lib/i18n/i18n.ts` spending dictionaries near lines 97 and 491

- [ ] **Step 1: Derive the selected-month record view from the DTO**

Replace `invoiceRows` with the server-provided `recordsByDate`. Preserve `selectedInvoiceKey` and `InvoiceDetailModal` for invoice rows. Add saving/error sets keyed by account `statementRowId`.

- [ ] **Step 2: Add optimistic override actions**

Implement one action handler:

```ts
async function updateTransactionState(
  record: SpendingAccountRecordDto,
  state: SpendingState | null,
  category: SpendingCategory | null = record.category,
) {
  // snapshot current `spending`, update row/model optimistically,
  // persist through window.octopusBeak.spending,
  // reload or reconcile returned state; restore snapshot on error.
}
```

Actions:

- excluded -> `改回支出`;
- pending -> choose category then `計入支出` or `排除`;
- manually changed -> `還原自動判斷` (`state: null`).

Do not create merchant-wide rules.

- [ ] **Step 3: Put the excluded disclosure above date groups**

Immediately after `.category-filters`, render:

```svelte
{#if model.excludedRecords.length > 0}
  <div class="excluded-disclosure">
    <span>{$t.spending.excludedDisclosure(model.excludedRecords.length)}</span>
    <button type="button" onclick={toggleExcludedRecords}>
      {$t.spending.reviewExcluded}
    </button>
  </div>
{/if}
```

Expansion filters/reveals excluded rows inside the same selected-month records area. It does not add a modal or append the disclosure to the bottom.

- [ ] **Step 4: Render newest-first date groups with sticky headers**

Within the existing scroll container:

```svelte
{#each model.recordsByDate as group (group.date)}
  <section class="record-day">
    <header class="date-head">
      <strong>{formatRecordDate(group.date)}</strong>
      <span>{$t.spending.daySummary(group.total, group.excludedCount, group.pendingCount)}</span>
    </header>
    <!-- invoice and account rows -->
  </section>
{/each}
```

CSS:

```css
.record-list { max-height: 620px; overflow-y: auto; }
.date-head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--surface-soft);
  border-block: 1px solid var(--border);
}
```

Sticky headers are informational and not focusable. Account rows show source, reason/status chip, amount, and inline action. Invoice rows retain their detail-modal behavior.

- [ ] **Step 5: Update summary wording without adding metadata blocks**

Change invoice-only labels to combined records (`23 筆已確認`, `每日記錄`) while preserving the same card title positions. The side panel shows selected-month included total and included-record count. Do not add a summary above the monthly card.

- [ ] **Step 6: Run typecheck and the full test suite**

```bash
npm run typecheck
npm test
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/spending/SpendingDashboard.svelte src/lib/i18n/i18n.ts
git commit -m "feat: show reversible daily spending records"
```

---

### Task 7: Verify the approved behavior in Electron

**Files:**
- Modify if fixture coverage is missing: `src/ledger/seed-mock-ledger-db.ts`
- Modify if fixture coverage is missing: its existing focused check

- [ ] **Step 1: Ensure mock data exposes every state**

Only if current mock data cannot show the UI, add the smallest coherent set of account rows: one included direct purchase, one explicit card payment, one mirrored transfer, and one pending transfer. Do not add a separate spending-only seed path.

- [ ] **Step 2: Re-run final automated checks**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 3: Start the desktop mock app and connect through its printed CDP port**

```bash
npm run desktop:dev:mock
npx libretto connect http://127.0.0.1:9222 --session electron-cdp
npx libretto exec --session electron-cdp "await page.evaluate(() => { location.hash = '/spending'; })"
npx libretto snapshot --session electron-cdp
```

If Electron prints a port other than 9222, use that port.

- [ ] **Step 4: Visually and interactively verify**

Confirm at desktop and compact widths:

- no new meta block exists above the monthly card;
- each month has two narrow, rounded, category-stacked bars using muted colors;
- the selected outline spans both bars;
- daily chart exists only in the modal and uses the same paired treatment;
- excluded disclosure is above the date groups;
- date headers remain sticky while the record list scrolls;
- an excluded card payment can be changed to included and totals update;
- `還原自動判斷` returns it to excluded;
- pending and excluded amounts never enter totals until explicitly included;
- no console, Svelte accessibility, or invalid-SVG errors appear.

- [ ] **Step 5: Close the CDP session and commit any necessary fixture changes**

```bash
npx libretto close --session electron-cdp
git add src/ledger/seed-mock-ledger-db.ts
git commit -m "test: cover account spending states in mock ledger"
```

Skip the commit when no fixture change was needed.

---

## Final Review Checklist

- [ ] Every approved requirement in `docs/superpowers/specs/2026-07-16-asset-account-spending-design.md` maps to a task above.
- [ ] No placeholder text, TODO, fake matcher, or unimplemented action remains.
- [ ] DTOs use the same `SpendingState`, `SpendingReason`, and `SpendingCategory` types across model, store, desktop bridge, and Svelte.
- [ ] Generic `繳費`, `轉帳`, and cash withdrawals are not high-confidence exclusions or purchases.
- [ ] Manual overrides survive reload and restoring automatic classification deletes the override.
- [ ] Source-separated totals reconcile to combined totals in both monthly and daily rows.
- [ ] Only included records affect totals.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass before completion is claimed.
