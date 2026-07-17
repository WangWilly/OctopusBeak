# Spending Ledger and Account Review Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Spending page's daily cards and inline account controls with the approved continuous ledger and a detail-rich account review modal.

**Architecture:** Keep `SpendingDashboard` as the owner of filtering, optimistic override updates, and modal selection. Enrich the existing spending model with raw account detail fields plus a narrow note-derived destination, add one focused modal component, and reuse the current override IPC without changing the database schema.

**Tech Stack:** Svelte 5, TypeScript, SQLite, Playwright, Node test runner.

## Global constraints

- Do not change the database schema, CSV parsers, automatic spending rules, chart components, or invoice modal.
- Do not add an icon or modal dependency.
- Keep destination-account inference display-only and explicitly non-authoritative.
- Keep the existing optimistic update, reload, rollback, category filter, excluded-record toggle, and focus-return behavior.

---

### Task 1: Carry account transaction details through the spending model

**Files:**
- Modify: `src/lib/spending/model.ts`
- Modify: `src/lib/spending/model.check.ts`
- Modify: `src/lib/spending/server/store.ts`
- Modify: `src/lib/spending/server/store.check.ts`

**Interfaces:**
- `SpendingAccountTransactionInput` gains `time: string | null`.
- `SpendingAccountRecord` gains `bank`, `accountNumber`, `currency`, `time`, `note`, `destinationBankCode`, and `destinationAccountNumber`.
- `parseTransferDestination(note)` returns an inferred destination or `null`.

- [ ] **Step 1: Add failing model tests for destination parsing and detail preservation**

Import the new helper and assert the narrow accepted formats:

```ts
assert.deepEqual(parseTransferDestination(["0660", "0000", "1022", "8174", "0"].join("")), {
  bankCode: "066",
  accountNumber: ["0000", "0102", "2817", "40"].join(""),
});
assert.deepEqual(parseTransferDestination(["0022", "0160", "0008", "1100"].join("")), {
  bankCode: "002",
  accountNumber: ["2016", "0000", "8110", "0"].join(""),
});
assert.equal(parseTransferDestination("reference " + ["0660", "0000", "1022", "8174", "0"].join("")), null);
assert.equal(parseTransferDestination("066-short"), null);
assert.equal(parseTransferDestination(null), null);
```

Extend `accountRow` with `time: null`, create one transfer with time and note, then assert its built record preserves every field and exposes the inferred destination.

- [ ] **Step 2: Run the model check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/spending/model.check.ts
```

Expected: FAIL because `parseTransferDestination` and the detail fields do not exist.

- [ ] **Step 3: Implement the narrow parser and enriched record**

Add to `model.ts`:

```ts
export type SpendingTransferDestination = {
  bankCode: string;
  accountNumber: string;
};

export function parseTransferDestination(note: string | null): SpendingTransferDestination | null {
  const token = note?.trim().split(/\s+/u)[0];
  if (!token || !/^\d{16,17}$/u.test(token)) return null;
  return { bankCode: token.slice(0, 3), accountNumber: token.slice(3) };
}
```

In `buildSpendingModel`, calculate the destination once per account row and copy the raw details into `SpendingAccountRecord`. Do not alter `automaticAccountDecision`.

- [ ] **Step 4: Add a failing store test for transaction time**

Extend `insertAccountTransaction` with optional `transactionTime` and `note`, insert both columns, and assert `loadSpending` returns them on the account record.

- [ ] **Step 5: Select and map `transaction_time`**

Add `transaction_time` to `AccountRow`, the `account_transactions` select, and `accountTransaction`:

```sql
SELECT statement_row_id, bank, account_number, currency,
  COALESCE(transaction_date, accounting_date) AS date,
  transaction_time, description, note, withdrawal_amount, deposit_amount
```

```ts
time: row.transaction_time,
```

- [ ] **Step 6: Run focused data checks and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/spending/model.check.ts src/lib/spending/server/store.check.ts
```

Expected: both checks pass.

- [ ] **Step 7: Commit the data-contract change**

```bash
git add src/lib/spending/model.ts src/lib/spending/model.check.ts src/lib/spending/server/store.ts src/lib/spending/server/store.check.ts
git commit -m "feat: expose spending account details"
```

---

### Task 2: Build the account transaction review modal

**Files:**
- Create: `src/lib/spending/components/AccountTransactionReviewModal.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Create: `scripts/spending-ledger-review.check.mjs`

**Interfaces:**
- Props: `record`, `saving`, `error`, `onClose`, and `onSave(record, state: SpendingState | null, category: SpendingCategory | null): Promise<boolean>`.
- Emits no custom event; all behavior stays in explicit callbacks, matching existing modal components.

- [ ] **Step 1: Create a failing browser fixture for the modal contract**

Start a local Vite server with a Spending model containing one pending account transfer:

```js
{
  statementRowId: "pending-transfer",
  label: "行動轉出",
  date: "2026-07-13",
  time: "17:27:28",
  bank: "test-bank",
  accountNumber: ["2173", "2000", "0210", "51"].join(""),
  currency: "TWD",
  amount: 3761,
  note: [["0660", "0000", "1022", "8174", "0"].join(""), ["7097", "2302", "7990", "0200"].join("")].join(" "),
  destinationBankCode: "066",
  destinationAccountNumber: ["0000", "0102", "2817", "40"].join(""),
  state: "pending",
  category: "other"
}
```

Assert that clicking the account row opens a dialog containing the outgoing account, inferred destination, date, time, currency, amount, note, category selector, include/exclude choices, cancel, and confirm. Also assert the old row-level select and action links are absent.

- [ ] **Step 2: Run the browser check and verify RED**

Run:

```bash
node --test scripts/spending-ledger-review.check.mjs
```

Expected: FAIL because the modal and clickable account row do not exist.

- [ ] **Step 3: Add localized modal strings**

Add matching English and Traditional Chinese entries for:

- transaction details and review title;
- outgoing account and inferred destination account;
- inferred-from-note explanation;
- transfer date, transaction time, currency, amount, and note;
- include/exclude decision labels;
- cancel, confirm, restore automatic decision, review-row aria label, and close label.

Reuse existing category, state, saving, error, and unavailable strings where their meaning already matches.

- [ ] **Step 4: Implement the focused modal component**

Follow `InvoiceDetailModal.svelte` for backdrop, Escape dismissal, initial close-button focus, tab containment, and responsive sizing. Keep local draft state:

```ts
let selectedCategory = record.category;
let selectedState: SpendingState = record.state === "pending" ? "included" : record.state;

async function confirm() {
  if (await onSave(record, selectedState, selectedCategory)) await onClose();
}
```

Render inferred destination with an explicit localized hint. Render the original note separately. Show the restore-automatic action only for `record.manual` and route it through `onSave(record, null, null)`; type the callback state as `SpendingState | null`.

- [ ] **Step 5: Mount the modal and preserve focus in `SpendingDashboard`**

This integration is completed with Task 3's ledger markup. Keep the browser check RED until both tasks are present so no partial commit claims a working interaction.

- [ ] **Step 6: Commit the modal with the ledger integration in Task 3**

Do not commit a dead, unmounted component separately.

---

### Task 3: Replace the daily cards with the continuous ledger

**Files:**
- Modify: `src/lib/spending/SpendingDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Test: `scripts/spending-ledger-review.check.mjs`

**Interfaces:**
- Keeps `buildVisibleRecordGroups`, `showExcludedRecords`, `selectCategory`, and `updateTransactionState` as the state owners.
- Adds selected account row state plus open/close helpers parallel to the invoice modal helpers.
- Changes `updateTransactionState` to resolve `true` on save and `false` on guard/failure so the modal closes only after success.

- [ ] **Step 1: Add the selected-account modal state and focus lifecycle**

Track the statement row id instead of retaining a stale object:

```ts
let selectedAccountStatementRowId: string | undefined;
let accountModalTrigger: HTMLButtonElement | null = null;
$: selectedAccountRecord = selectedAccountStatementRowId
  ? model.accountRecords.find((record) => record.statementRowId === selectedAccountStatementRowId) ?? null
  : null;
```

Add `openAccountModal` and `closeAccountModal` alongside the invoice helpers. Restore the originating row when connected, then fall back to the current filter controls.

- [ ] **Step 2: Make override updates report success**

Return `false` when another save is active or the IPC/reload fails, and `true` after reload succeeds. Preserve the current optimistic `applySpendingAccountOverride`, rollback, saving set, and error set behavior.

- [ ] **Step 3: Simplify the section header and add the excluded icon control**

Remove `confirmedCount` from the visible total summary and remove `newestFirst`. Keep only the visible record count on the right.

Move the excluded toggle into the right header and use an inline SVG:

```svelte
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M2 5h20"></path>
  <path d="M6 12h12"></path>
  <path d="M9 19h6"></path>
</svg>
```

The icon button has `aria-expanded`, a count-bearing `aria-label`, and a sibling `role="tooltip"` shown by `:hover` and `:focus-visible`. Delete `.excluded-disclosure` and its banner markup.

- [ ] **Step 4: Render the ledger column header and date groups**

Add one grid-aligned header row for date, transaction, and amount. Render each `record-day` as a labelled section whose summary comes before its transaction rows:

```svelte
<header class="day-summary" id={`spending-day-${group.date}`}>
  <span>{formatShortDate(group.date)}</span>
  <strong>{formatMoney({ currency: "TWD", value: group.includedTotal }, { locale: $locale })}</strong>
</header>
```

Do not call `daySummary`; do not display confirmed, excluded, or pending counts. Split the row date into compact date and weekday/time formatters.

- [ ] **Step 5: Convert both transaction variants to aligned native buttons**

Keep invoice rows wired to `openInvoiceModal`. Convert account rows from `<div>` to `<button>` and wire them to `openAccountModal`.

For account rows:

- show time when present and weekday otherwise;
- show source, account number when present, category, and pending status when applicable;
- remove the automatic-reason copy, inline select, inline action buttons, colored edge, and chevron;
- retain only a subtle background for pending records;
- expose saving and error state without making the row unusable to assistive technology.

- [ ] **Step 6: Mount `AccountTransactionReviewModal`**

Pass the reactive selected record, saving/error flags, close callback, and success-returning update callback. Ensure a successful state change updates the row and totals before closing.

- [ ] **Step 7: Complete browser assertions and verify GREEN**

The browser check must assert:

- column headings and date summary precede transaction rows;
- group summaries contain only date and total;
- confirmed count and newest-first copy are absent;
- excluded control is icon-only, has the correct accessible name, shows its tooltip on focus/hover, and toggles excluded rows;
- pending account row has no inline select, colored edge, or chevron;
- modal details and destination inference are rendered;
- include/exclude confirmation calls the existing IPC and changes the model;
- failed save keeps the modal open with an alert;
- Escape/cancel returns focus to the account row;
- invoice rows still open the invoice modal.

Run:

```bash
node --test scripts/spending-ledger-review.check.mjs
npm run typecheck
```

Expected: browser check PASS and Svelte reports zero errors and warnings.

- [ ] **Step 8: Commit the user interface**

```bash
git add src/lib/spending/components/AccountTransactionReviewModal.svelte src/lib/spending/SpendingDashboard.svelte src/lib/i18n/i18n.ts scripts/spending-ledger-review.check.mjs
git commit -m "feat: redesign spending transaction review"
```

---

### Task 4: Full regression and visual verification

**Files:**
- Verify: `src/lib/spending/SpendingDashboard.svelte`
- Verify: `src/lib/spending/components/AccountTransactionReviewModal.svelte`

- [ ] **Step 1: Run the full automated verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass, typecheck reports zero errors and warnings, both production builds complete, and no whitespace errors are reported.

- [ ] **Step 2: Verify the Electron Spending page**

Using the project's Electron debugging workflow, open `#/spending` with representative invoice, pending account, manual account, and excluded account records. Verify:

- sidebar transition remains smooth and unchanged;
- list scrolling and category filtering remain responsive;
- excluded icon and tooltip work with mouse and keyboard;
- every account row opens the modal and every invoice row opens invoice details;
- modal data matches the underlying record, including optional time and original note;
- include, exclude, restore automatic, cancel, backdrop, Escape, focus containment, and focus return work;
- no console error appears at desktop and narrow widths.

- [ ] **Step 3: Review the final diff for scope**

Confirm there is no schema migration, CSV-parser edit, dependency change, chart edit, or unrelated sidebar change.

- [ ] **Step 4: Commit verification fixes only if needed**

If verification requires a scoped correction, rerun the focused and full checks before committing it.
