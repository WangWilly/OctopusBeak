# Spending Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Track progress using the checkboxes below.

**Goal:** Add a top-level Spending page backed by normalized personal e-invoice data, with wireframe-matched charts and invoice details plus editable per-item categories persisted in SQLite.

**Architecture:** Store one validated category identifier on each `personal_invoice_items` row. A shared pure classifier handles migration backfill and first import; duplicate imports deliberately leave the category untouched. A small prepared-SQL store exposes confirmed invoice entities through two Electron IPC methods, while pure view-model helpers derive monthly, daily, and filtered UI data in `Asia/Taipei`.

**Tech Stack:** TypeScript, Node.js `assert`, SQLite `DatabaseSync`, Svelte 5, LayerChart `BarChart`, Electron IPC, existing OctopusBeak CSS and i18n stores

**Design:** `docs/superpowers/specs/2026-07-10-spending-dashboard-design.md`

## Global Constraints

- Add no dependency and no second category table.
- Persist exactly one of `food`, `daily`, `transport`, `shopping`, `home`, `leisure`, or `other` on every invoice item.
- Item-name keyword rules take precedence over seller-name/address rules.
- Automatic classification occurs only when an item is first inserted or migration 11 backfills an existing row.
- Duplicate CSV imports must not overwrite a user-edited category.
- Only confirmed invoices appear in spending views.
- Group Unix timestamps using `Asia/Taipei`, not the host timezone or UTC.
- Reconcile each invoice's category allocation to its stored invoice amount; keep negative item values.
- Reuse `DashboardShell`, global cards/filters/modals, existing money formatting, and installed LayerChart.
- Preserve keyboard operation, Escape/backdrop dismissal, focus restoration, and readable empty/error states.

---

### Task 1: Add The Shared Category Classifier

**Files:**
- Create: `src/lib/spending/categories.check.ts`
- Create: `src/lib/spending/categories.ts`

**Interfaces:**
- Produces: `SPENDING_CATEGORY_IDS` and `SpendingCategory`.
- Produces: `isSpendingCategory(value): value is SpendingCategory`.
- Produces: `classifyPersonalInvoiceItem({ productName, sellerName, sellerAddr }): SpendingCategory`.

- [ ] **Step 1: Write the failing category assertions**

Create `src/lib/spending/categories.check.ts` with assertions covering:

```ts
assert.equal(classifyPersonalInvoiceItem({
  productName: "咖啡",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "food");

assert.equal(classifyPersonalInvoiceItem({
  productName: "Unlabelled item",
  sellerName: "台灣中油股份有限公司",
  sellerAddr: "新北市",
}), "transport");

assert.equal(classifyPersonalInvoiceItem({
  productName: "電影票",
  sellerName: "台灣中油股份有限公司",
  sellerAddr: "新北市",
}), "leisure");

assert.equal(classifyPersonalInvoiceItem({
  productName: "Unknown",
  sellerName: "Unknown",
  sellerAddr: "Unknown",
}), "other");

assert.equal(isSpendingCategory("shopping"), true);
assert.equal(isSpendingCategory("invalid"), false);
```

Include one representative assertion for every category.

- [ ] **Step 2: Run the category check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/categories.check.ts
```

Expected: FAIL because `categories.ts` does not exist.

- [ ] **Step 3: Implement the smallest pure classifier**

Create `src/lib/spending/categories.ts` containing:

- The seven identifiers as a readonly tuple.
- The derived union type and set-based validator.
- The wireframe's `ITEM_CATEGORY_RULES` and `CATEGORY_RULES` keyword arrays.
- A case-insensitive substring matcher.
- `classifyPersonalInvoiceItem` with item, merchant, then `other` precedence.

Keep labels and colors out of this module; those belong to i18n and presentation.

- [ ] **Step 4: Rerun the category check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/categories.check.ts
```

Expected: exit code 0 with no assertion output.

- [ ] **Step 5: Commit the classifier**

```bash
git add src/lib/spending/categories.ts src/lib/spending/categories.check.ts
git commit -m "feat: classify personal invoice items"
```

---

### Task 2: Persist And Backfill Item Categories

**Files:**
- Modify: `src/ledger/db/migrations.check.ts:8-242`
- Modify: `src/ledger/db/migrations.ts:336-382, 760-809`

**Interfaces:**
- Produces: `personal_invoice_items.category TEXT NOT NULL DEFAULT 'other'` constrained to the seven identifiers.
- Produces: migration 11 named `personal_invoice_item_categories`.
- Consumes: Task 1's classifier for existing-row backfill.

- [ ] **Step 1: Write failing schema and backfill checks**

Extend `src/ledger/db/migrations.check.ts` to assert:

- Fresh databases report migrations `1` through `11`.
- `PRAGMA table_info(personal_invoice_items)` includes a non-null `category` column.
- A version-10-style row with product name `咖啡` migrates to `food`.
- A row whose item name does not match but whose seller is `台灣中油股份有限公司` migrates to `transport`.
- `UPDATE personal_invoice_items SET category = 'invalid'` fails its `CHECK` constraint.

Retain the existing sequence-number migration assertions.

- [ ] **Step 2: Run the migration check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: FAIL because migration 11 and the category column do not exist.

- [ ] **Step 3: Add the category column to new tables**

In `createPersonalInvoiceStatementTables`, append this field after `item_product_name`:

```sql
category TEXT NOT NULL DEFAULT 'other'
  CHECK (category IN ('food', 'daily', 'transport', 'shopping', 'home', 'leisure', 'other')),
```

- [ ] **Step 4: Add migration 11 with classifier backfill**

Import `classifyPersonalInvoiceItem` into `migrations.ts`. Add `addPersonalInvoiceItemCategories(db)` that:

1. Returns when `category` already exists.
2. Adds the constrained column with `other` as its temporary default.
3. Selects `item_key`, product name, seller name, and seller address by joining items to invoices.
4. Updates each row through one prepared statement using the shared classifier.

Register migration 11 after sequence normalization. Rely on the existing outer migration transaction for rollback.

- [ ] **Step 5: Rerun the migration check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: exit code 0; existing migration-10 checks and new category assertions pass.

- [ ] **Step 6: Commit category persistence**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: persist personal invoice categories"
```

---

### Task 3: Classify New Imports Without Overwriting Edits

**Files:**
- Modify: `src/ledger/import-downloads-csv.check.ts:32-253`
- Modify: `src/ledger/import-downloads-csv.ts:295-312, 455-488`

**Interfaces:**
- Consumes: Task 1's classifier and the existing raw invoice row.
- Preserves: `PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS` without `category`.

- [ ] **Step 1: Write the failing import-preservation assertions**

In `src/ledger/import-downloads-csv.check.ts`:

1. Select `category` with the initially imported item and expect `food` for `咖啡`.
2. Reopen the database read-write after the first import and set that item's category to `shopping`.
3. Reimport the same logical invoice with the existing status/source-field change.
4. Assert the invoice and ordinary item fields refresh while `category` remains `shopping`.

Also assert a newly inserted transport item receives `transport` through seller fallback.

- [ ] **Step 2: Run the import check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

Expected: FAIL because imported item records do not yet include `category`.

- [ ] **Step 3: Add category only to the insert record**

In `insertPersonalInvoiceStatementRow`, include:

```ts
category: classifyPersonalInvoiceItem({
  productName: row.rawPayload.item_product_name,
  sellerName: row.rawPayload.seller_name,
  sellerAddr: row.rawPayload.seller_addr,
}),
```

Do not add `category` to `PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS`. Add a short comment there only if needed to make preservation obvious.

- [ ] **Step 4: Rerun the import and category checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/categories.check.ts
```

Expected: both exit 0; the automatic value is inserted and the manual override survives reimport.

- [ ] **Step 5: Commit import classification**

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "feat: classify imported invoice items"
```

---

### Task 4: Build The Spending Model And SQLite Store

**Files:**
- Create: `src/lib/spending/model.check.ts`
- Create: `src/lib/spending/model.ts`
- Create: `src/lib/spending/server/store.check.ts`
- Create: `src/lib/spending/server/store.ts`

**Interfaces:**
- Produces: `SpendingItemDto`, `SpendingInvoiceDto`, `SpendingPageDto`, and derived chart/view types.
- Produces: `buildSpendingModel(invoices, selectedMonth?, selectedCategory?)`.
- Produces: `loadSpending(ledgerDir?)` and `updateSpendingItemCategory(input, ledgerDir?)`.

- [ ] **Step 1: Write failing pure-model assertions**

Create `model.check.ts` with a small invoice set proving:

- An epoch close to midnight groups by the Taipei calendar day and month.
- Month keys are chronological and the latest month is selected by default.
- Item category amounts stack correctly.
- A negative item reduces its category total.
- The invoice/item sum difference is assigned to the first item category, or `other` when there are no items, so totals equal the invoice amount.
- A category filter includes each matching invoice once.
- Present categories and daily rows contain only selected-month data.

- [ ] **Step 2: Run the model check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/model.check.ts
```

Expected: FAIL because `model.ts` does not exist.

- [ ] **Step 3: Implement normalized DTOs and one derived model**

Create `model.ts` with:

- Serializable invoice and item DTOs using `itemKey`, `invoiceKey`, numeric amounts, and Unix `issuedAt`.
- A `formatToParts`-based Taipei date-key helper.
- One `buildSpendingModel` pass that derives months, monthly category rows, selected-month summary, daily category rows, present categories, and filtered invoice entities.

Do not add a class, store abstraction, or memoization; the current dataset is small enough to recompute after one category edit.

- [ ] **Step 4: Rerun the model check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/model.check.ts
```

Expected: exit code 0.

- [ ] **Step 5: Write failing SQLite store assertions**

Create `server/store.check.ts` using a temporary ledger directory. Seed:

- One confirmed invoice with two items.
- One voided invoice that must be excluded.

Assert `loadSpending` returns only the confirmed invoice and preserves its ordered items. Assert `updateSpendingItemCategory` changes a valid row, rejects an unknown category, rejects an empty key, and fails when no item matches.

- [ ] **Step 6: Run the store check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/server/store.check.ts
```

Expected: FAIL because `store.ts` does not exist.

- [ ] **Step 7: Implement the prepared-SQL store**

Create `server/store.ts` that:

- Opens the existing ledger client and always closes it in `finally`.
- Loads confirmed invoices and left-joined items with one prepared query ordered by issue time, invoice key, and sequence.
- Groups flat rows into normalized invoice DTOs without exposing raw payloads or provenance hashes.
- Validates category and item key before a prepared update.
- Requires `changes === 1`; otherwise throws an actionable missing-item error.

- [ ] **Step 8: Rerun model and store checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/model.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/server/store.check.ts
```

Expected: both exit 0.

- [ ] **Step 9: Commit the spending data layer**

```bash
git add src/lib/spending/model.ts src/lib/spending/model.check.ts src/lib/spending/server/store.ts src/lib/spending/server/store.check.ts
git commit -m "feat: load and aggregate invoice spending"
```

---

### Task 5: Expose Spending Through The Desktop API

**Files:**
- Modify: `src/lib/desktop/api.check.ts:1-18`
- Modify: `src/lib/desktop/api.ts:1-68`
- Modify: `electron/preload.ts:1-28`
- Modify: `electron/ipc.ts:1-59`

**Interfaces:**
- Adds: `spending:load`.
- Adds: `spending:updateItemCategory`.

- [ ] **Step 1: Write the failing channel contract**

Add the two spending channels to the expected list in `src/lib/desktop/api.check.ts` immediately after `liabilities:load`.

- [ ] **Step 2: Run the channel check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
```

Expected: FAIL because the API channel list does not contain the new entries.

- [ ] **Step 3: Add the typed bridge and handlers**

Update `OctopusBeakApi` with:

```ts
spending: {
  load(): Promise<SpendingPageDto>;
  updateItemCategory(input: {
    itemKey: string;
    category: SpendingCategory;
  }): Promise<{ ok: true }>;
};
```

Add matching preload invocations. Register IPC handlers that call Task 4's store functions and return `{ ok: true }` only after a successful update.

- [ ] **Step 4: Rerun the channel and type checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 5: Commit the desktop bridge**

```bash
git add src/lib/desktop/api.ts src/lib/desktop/api.check.ts electron/preload.ts electron/ipc.ts
git commit -m "feat: expose spending desktop API"
```

---

### Task 6: Add The Top-Level Page, Monthly Chart, And Invoice List

**Files:**
- Create: `src/lib/spending/components/SpendingBarChart.svelte`
- Create: `src/lib/spending/SpendingDashboard.svelte`
- Modify: `src/lib/i18n/i18n.check.ts:9-19`
- Modify: `src/lib/i18n/i18n.ts:13-627`
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte:7-64`
- Modify: `src/routes/+page.svelte:1-83`

**Interfaces:**
- Adds: `#/spending` and `active="spending"`.
- Consumes: Task 4's DTO/model and Task 5's load API.
- Reuses: LayerChart `BarChart` for both monthly and later daily datasets.

- [ ] **Step 1: Write the failing i18n/navigation assertions**

Extend `i18n.check.ts` to assert:

```ts
assert.equal(translations.en.nav.spending, "Spending");
assert.equal(translations["zh-TW"].nav.spending, "消費");
assert.equal(translations.en.spending.title, "Personal spending");
assert.equal(translations["zh-TW"].spending.title, "個人消費");
```

The existing recursive key check must continue proving English and Traditional Chinese parity.

- [ ] **Step 2: Run the i18n check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
```

Expected: FAIL because the spending keys do not exist.

- [ ] **Step 3: Add spending translations and sidebar navigation**

Add the spending navigation label and one `spending` dictionary to each locale. Include page headings, category labels, chart/list labels, totals, invoice/item counts, empty states, modal labels, category save/error text, and accessible names.

Add `spending` to `DashboardShell`'s active union and insert a receipt-style existing SVG path between Liabilities and Automation. Do not add an icon package.

- [ ] **Step 4: Build the reusable stacked bar component**

Create `SpendingBarChart.svelte` using installed LayerChart `BarChart` with:

- `seriesLayout="stack"` and the seven category series.
- Stable height and responsive width.
- Existing sparkline axis/tooltip styles where compatible.
- Locale-aware axis labels and TWD tooltips.
- `onBarClick` support for monthly selection.
- A nonblank empty state when no rows exist.
- Category legend buttons/labels matching the wireframe without introducing another shared chart abstraction.

- [ ] **Step 5: Build the main dashboard**

Create `SpendingDashboard.svelte` that:

- Wraps content in `DashboardShell active="spending"`.
- Keeps selected month and category as local state.
- Rebuilds Task 4's model after month/filter/data changes.
- Renders the monthly chart, horizontally scrollable month buttons, selected-month total/count, category filters, and invoice rows.
- Uses existing `.content`, `.card`, `.panel-title`, `.filter-btn`, and button styles.
- Shows the selected-month total and invoice count in the shell's existing side-status area.
- Uses a varied seven-category palette scoped to the feature.
- Avoids nested cards and keeps invoice rows stable at desktop and mobile widths.

- [ ] **Step 6: Wire the route loader**

Add `SpendingPageDto` state, `spending` route normalization, `window.octopusBeak.spending.load()`, error handling, and `SpendingDashboard` rendering to `src/routes/+page.svelte` following the existing assets/liabilities branches.

- [ ] **Step 7: Run i18n, type, and production-build checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
npm run typecheck
npm run build
```

Expected: all exit 0.

- [ ] **Step 8: Commit the spending page**

```bash
git add src/lib/spending/SpendingDashboard.svelte src/lib/spending/components/SpendingBarChart.svelte src/lib/i18n/i18n.ts src/lib/i18n/i18n.check.ts src/lib/shared-shell/components/DashboardShell.svelte src/routes/+page.svelte
git commit -m "feat: add spending dashboard"
```

---

### Task 7: Add Daily And Invoice Modals With Category Editing

**Files:**
- Create: `src/lib/spending/components/DailySpendingModal.svelte`
- Create: `src/lib/spending/components/InvoiceDetailModal.svelte`
- Modify: `src/lib/spending/SpendingDashboard.svelte`

**Interfaces:**
- Consumes: `window.octopusBeak.spending.updateItemCategory`.
- Reuses: `SpendingBarChart.svelte` and global modal classes.

- [ ] **Step 1: Implement the daily spending modal**

Create `DailySpendingModal.svelte` with the wireframe hierarchy:

- Selected month title, total, and invoice count.
- Seven-category legend.
- Daily stacked chart using `SpendingBarChart`.
- Existing modal backdrop/panel/head/body/close classes.
- Escape and backdrop dismissal.

- [ ] **Step 2: Implement the invoice detail modal**

Create `InvoiceDetailModal.svelte` with:

- Invoice number/date header and close control.
- Seller name, category summary, business number, and address.
- Ordered item rows showing product, quantity, unit price, paid amount, and category.
- A labelled native category `select` styled as a compact category chip.
- Per-item busy state and compact inline save failure.
- The invoice total footer.

The component emits category changes to the dashboard; it does not open SQLite directly.

- [ ] **Step 3: Add optimistic update and rollback in the dashboard**

In `SpendingDashboard.svelte`:

1. Save the previous category.
2. Update the local item immutably and rebuild the view immediately.
3. Await `updateItemCategory`.
4. On failure, restore the prior category and expose the translated inline error.
5. Disable only the item currently saving to prevent duplicate writes.

Keep the invoice modal open, and update monthly/daily totals, category filters, and invoice category chips in place.

- [ ] **Step 4: Add modal focus behavior**

Store the daily-chart or invoice-row trigger before opening. On close, clear modal state, await Svelte `tick`, then return focus to the trigger. Verify Escape and backdrop closure follow the same path.

- [ ] **Step 5: Run type and build checks**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both exit 0 with no Svelte accessibility warning.

- [ ] **Step 6: Commit modal interactions**

```bash
git add src/lib/spending/SpendingDashboard.svelte src/lib/spending/components/DailySpendingModal.svelte src/lib/spending/components/InvoiceDetailModal.svelte
git commit -m "feat: edit invoice item categories"
```

---

### Task 8: Run Full Verification And Inspect The Electron UI

**Files:**
- Modify only files required by failures discovered during verification.

- [ ] **Step 1: Run all focused checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/categories.check.ts
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/model.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/server/store.check.ts
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
```

Expected: every command exits 0.

- [ ] **Step 2: Run repository verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 3: Start or connect to the Electron development app**

Check the CDP endpoint first:

```bash
curl http://127.0.0.1:9222/json/version
```

Create a temporary copy of the ledger first so category-edit verification cannot modify the default ledger. Start and keep Electron alive with `LEDGER_DIR` pointing at that copy:

```bash
SPENDING_LEDGER_ROOT="$(mktemp -d /tmp/octopusbeak-spending-ledger.XXXXXX)"
cp -R data/ledger "$SPENDING_LEDGER_ROOT/ledger"
LEDGER_DIR="$SPENDING_LEDGER_ROOT/ledger" npm run desktop:dev
```

Use the port printed by Electron if it differs from `9222`.

- [ ] **Step 4: Verify the live desktop workflow through CDP**

Navigate to `#/spending` and inspect the accessibility tree, DOM, console, and screenshots. Verify:

1. The Spending sidebar item and route load.
2. Monthly stacked bars are nonblank and the latest month is selected.
3. A month button and monthly bar both change the selected month.
4. Category filters change the invoice list without duplicating invoices.
5. The daily chart modal opens, renders, closes by button/Escape/backdrop, and restores focus.
6. An invoice row opens the complete detail modal.
7. Changing one item category updates the chart/list immediately and remains after app reload.
8. Re-running the CSV importer does not overwrite that category.
9. No renderer console error appears.

Confirm the running process reports the temporary `LEDGER_DIR` before performing category edits. Never use the default ledger for mutation verification.

- [ ] **Step 5: Capture responsive evidence**

Capture screenshots at desktop and compact widths for:

- Main spending page.
- Daily chart modal.
- Invoice detail modal with category selector.
- Compact page with month controls and invoice rows visible.

Check that text, controls, chart labels, modal content, and the six-item mobile nav do not overlap or resize unpredictably.

- [ ] **Step 6: Commit any verification fixes**

If verification required changes:

```bash
git add <changed-files>
git commit -m "fix: polish spending dashboard"
```

If no changes were required, do not create an empty commit.

## Completion Criteria

- Migration 11 categorizes existing items and constrains future values.
- New imports classify items once; repeated imports preserve user changes.
- Spending is a top-level bilingual page using existing OctopusBeak components.
- Monthly, daily, filtered invoice, and detail views match the approved wireframe hierarchy.
- Category changes persist immediately, roll back visibly on failure, and survive reload/reimport.
- All focused checks, typecheck, build, and CDP visual/interactivity verification pass.
