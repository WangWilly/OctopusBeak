# E-Invoice System Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the e-invoice Libretto workflow into automation, then import its generated CSV into normalized SQLite tables for personal invoices and invoice items.

**Architecture:** The workflow remains a one-shot crawler that fetches every invoice the government site exposes and writes a self-owned CSV under `downloads/einvoice-personal-invoices/`. The CSV importer detects `einvoice/personal-invoices`, derives stable invoice and item keys, and writes one row to `personal_invoices` plus one row to `personal_invoice_items` per CSV item row. Duplicate protection lives in SQLite unique keys and targeted upserts, not in a timestamp cursor.

**Tech Stack:** TypeScript, Libretto, Playwright, Node `--experimental-strip-types`, SQLite `DatabaseSync`, existing CSV import pipeline.

## Global Constraints

- Use physical normalized SQLite tables named `personal_invoices` and `personal_invoice_items`.
- Keep the e-invoice crawler as a one-shot workflow: fetch all currently fetchable site invoices, starting from the earliest available month.
- Do not add `lastFetchedInvoiceTimestamp` as a correctness dependency; use deterministic unique keys and upserts to prevent duplicates.
- Do not download the site-provided export file; continue parsing page/API responses and writing the project-owned CSV.
- Write future e-invoice CSV output under `downloads/einvoice-personal-invoices/` so importer context is `bank=einvoice`, `product=personal-invoices`.
- Store `issued_at` in SQLite as a Unix timestamp integer.
- Keep e-invoice automation headed because the CAPTCHA flow uses manual browser input plus `pause(session)`.
- Add no new npm dependencies.

---

## File Structure

- Modify `src/ledger/source-csv-parsers.ts`: add typed table names, deterministic e-invoice key helpers, field mappers, and parser binding for `einvoice/personal-invoices`.
- Modify `src/ledger/source-csv-parsers.check.ts`: cover the new parser binding and e-invoice field/key normalization.
- Modify `src/ledger/db/migrations.ts`: create `personal_invoices` and `personal_invoice_items` for fresh and existing databases.
- Modify `src/ledger/import-downloads-csv.ts`: export `importDownloadsCsv`, add targeted upsert support, and special-case e-invoice rows into the two normalized tables.
- Create `src/ledger/import-downloads-csv.check.ts`: integration check that imports duplicate e-invoice CSVs and confirms one invoice, one item, and a refreshed invoice status.
- Modify `src/workflows/einvoice-personal-invoices.ts`: add `item_sequence_number` to CSV rows and write into the e-invoice import folder.
- Modify `src/lib/automation/server/tasks.ts`: add e-invoice credential group, crawler task, and import dependency.
- Modify `src/lib/automation/server/automation-core.check.ts`: update stale dependency assertions and add e-invoice automation coverage.
- Modify `.env.example`: add `LIBRETTO_CLOUD_EINVOICE_ENABLED=true`.

---

### Task 1: E-Invoice Parser Keys And Field Mapping

**Files:**
- Modify: `src/ledger/source-csv-parsers.ts`
- Modify: `src/ledger/source-csv-parsers.check.ts`

**Interfaces:**
- Consumes: e-invoice CSV payload fields from `src/workflows/einvoice-personal-invoices.ts`.
- Produces:
  - `personalInvoiceKey(rawPayload: Record<string, string>): string`
  - `personalInvoiceItemKey(rawPayload: Record<string, string>): string`
  - `personalInvoiceFields(rawPayload: Record<string, string>): Record<string, unknown>`
  - `personalInvoiceItemFields(rawPayload: Record<string, string>): Record<string, unknown>`
  - `createSourceCsvParser({ bank: "einvoice", product: "personal-invoices", ... }).table === "personal_invoice_items"`

- [ ] **Step 1: Write the failing parser check**

Add these imports in `src/ledger/source-csv-parsers.check.ts`:

```ts
import {
  createSourceCsvParser,
  normalizeCurrencyCode,
  personalInvoiceFields,
  personalInvoiceItemFields,
  personalInvoiceItemKey,
  personalInvoiceKey,
  sqliteAmount,
} from "./source-csv-parsers.ts";
```

Append this check block to the same file:

```ts
const einvoicePayload = {
  carrier_customized_name: "mobile barcode",
  issued_at: "1783065600",
  invoice_id: "AB12345678",
  amount: "129",
  status: "confirmed",
  rebated: "false",
  seller_business_account_number: "24536806",
  seller_name: "Store",
  seller_addr: "Taipei",
  buyer_business_account_number: "",
  item_sequence_number: "1",
  item_quantity: "2",
  item_unit_price: "50",
  item_paid_amount: "100",
  item_product_name: "Coffee",
};

const einvoiceParser = createSourceCsvParser({
  bank: "einvoice",
  product: "personal-invoices",
  sourceRelativePath: "einvoice-personal-invoices/example.csv",
  metadata: null,
  headers: Object.keys(einvoicePayload),
});
assert.equal(einvoiceParser.table, "personal_invoice_items");
assert.equal(
  personalInvoiceKey(einvoicePayload),
  "AB12345678|1783065600|24536806",
);
assert.equal(
  personalInvoiceItemKey(einvoicePayload),
  "AB12345678|1783065600|24536806|1",
);
assert.deepEqual(personalInvoiceFields(einvoicePayload), {
  invoice_key: "AB12345678|1783065600|24536806",
  carrier_customized_name: "mobile barcode",
  issued_at: 1783065600,
  invoice_id: "AB12345678",
  amount: 129,
  status: "confirmed",
  rebated: 0,
  seller_business_account_number: "24536806",
  seller_name: "Store",
  seller_addr: "Taipei",
  buyer_business_account_number: "",
});
assert.deepEqual(personalInvoiceItemFields(einvoicePayload), {
  item_key: "AB12345678|1783065600|24536806|1",
  invoice_key: "AB12345678|1783065600|24536806",
  item_sequence_number: "1",
  item_quantity: 2,
  item_unit_price: 50,
  item_paid_amount: 100,
  item_product_name: "Coffee",
});
assert.deepEqual(einvoiceParser.parseRow(einvoicePayload), {
  item_key: "AB12345678|1783065600|24536806|1",
  invoice_key: "AB12345678|1783065600|24536806",
  item_sequence_number: "1",
  item_quantity: 2,
  item_unit_price: 50,
  item_paid_amount: 100,
  item_product_name: "Coffee",
});
```

- [ ] **Step 2: Run the parser check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
```

Expected: fail because the e-invoice exports and parser table do not exist yet.

- [ ] **Step 3: Add e-invoice typed tables to parser types**

In `src/ledger/source-csv-parsers.ts`, extend `TypedStatementTable`:

```ts
export type TypedStatementTable =
  | "account_transactions"
  | "foreign_currency_transactions"
  | "credit_card_statement_lines"
  | "loan_transactions"
  | "fund_holdings"
  | "fund_buy_transactions"
  | "fund_redemption_transactions"
  | "fund_cash_dividends"
  | "fund_conversion_transactions"
  | "brokerage_holdings"
  | "brokerage_asset_summaries"
  | "brokerage_trade_transactions"
  | "personal_invoices"
  | "personal_invoice_items"
  | "unsupported_statement_rows";
```

Extend `TYPED_STATEMENT_TABLES` in the same order:

```ts
export const TYPED_STATEMENT_TABLES: TypedStatementTable[] = [
  "account_transactions",
  "foreign_currency_transactions",
  "credit_card_statement_lines",
  "loan_transactions",
  "fund_holdings",
  "fund_buy_transactions",
  "fund_redemption_transactions",
  "fund_cash_dividends",
  "fund_conversion_transactions",
  "brokerage_holdings",
  "brokerage_asset_summaries",
  "brokerage_trade_transactions",
  "personal_invoices",
  "personal_invoice_items",
  "unsupported_statement_rows",
];
```

- [ ] **Step 4: Add e-invoice key and field helpers**

Add this code after `cleanTypedCell()` in `src/ledger/source-csv-parsers.ts`:

```ts
function sqliteInteger(value: string | number | null | undefined): number | null {
  const cleaned = cleanTypedCell(value);
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function sqliteBoolean(value: string | number | null | undefined): number {
  return ["1", "true", "y", "yes"].includes(cleanTypedCell(value).toLowerCase())
    ? 1
    : 0;
}

export function personalInvoiceKey(rawPayload: Record<string, string>): string {
  return [
    cleanTypedCell(rawPayload.invoice_id),
    cleanTypedCell(rawPayload.issued_at),
    cleanTypedCell(rawPayload.seller_business_account_number),
  ].join("|");
}

export function personalInvoiceItemKey(rawPayload: Record<string, string>): string {
  const invoiceKey = personalInvoiceKey(rawPayload);
  const sequenceNumber = cleanTypedCell(rawPayload.item_sequence_number);
  if (sequenceNumber) return `${invoiceKey}|${sequenceNumber}`;
  return [
    invoiceKey,
    cleanTypedCell(rawPayload.item_product_name),
    cleanTypedCell(rawPayload.item_quantity),
    cleanTypedCell(rawPayload.item_unit_price),
    cleanTypedCell(rawPayload.item_paid_amount),
  ].join("|");
}

export function personalInvoiceFields(rawPayload: Record<string, string>) {
  return {
    invoice_key: personalInvoiceKey(rawPayload),
    carrier_customized_name: cleanTypedCell(rawPayload.carrier_customized_name),
    issued_at: sqliteInteger(rawPayload.issued_at),
    invoice_id: cleanTypedCell(rawPayload.invoice_id),
    amount: sqliteAmount(rawPayload.amount),
    status: cleanTypedCell(rawPayload.status),
    rebated: sqliteBoolean(rawPayload.rebated),
    seller_business_account_number: cleanTypedCell(
      rawPayload.seller_business_account_number,
    ),
    seller_name: cleanTypedCell(rawPayload.seller_name),
    seller_addr: cleanTypedCell(rawPayload.seller_addr),
    buyer_business_account_number: cleanTypedCell(
      rawPayload.buyer_business_account_number,
    ),
  };
}

export function personalInvoiceItemFields(rawPayload: Record<string, string>) {
  return {
    item_key: personalInvoiceItemKey(rawPayload),
    invoice_key: personalInvoiceKey(rawPayload),
    item_sequence_number: cleanTypedCell(rawPayload.item_sequence_number),
    item_quantity: sqliteAmount(rawPayload.item_quantity),
    item_unit_price: sqliteAmount(rawPayload.item_unit_price),
    item_paid_amount: sqliteAmount(rawPayload.item_paid_amount),
    item_product_name: cleanTypedCell(rawPayload.item_product_name),
  };
}
```

- [ ] **Step 5: Bind the e-invoice parser**

In `createSourceCsvParser()`, add this branch before the final unsupported parser:

```ts
  if (bankProduct === "einvoice/personal-invoices") {
    return bind("personal_invoice_items", ({ rawPayload }) =>
      personalInvoiceItemFields(rawPayload),
    );
  }
```

- [ ] **Step 6: Run the parser check and verify it passes**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
```

Expected: no output and exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/ledger/source-csv-parsers.ts src/ledger/source-csv-parsers.check.ts
git commit -m "feat: add e-invoice csv parser fields"
```

---

### Task 2: Normalized SQLite Import

**Files:**
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/import-downloads-csv.ts`
- Create: `src/ledger/import-downloads-csv.check.ts`

**Interfaces:**
- Consumes:
  - `personalInvoiceFields(rawPayload)`
  - `personalInvoiceItemFields(rawPayload)`
  - `personalInvoiceKey(rawPayload)`
  - `personalInvoiceItemKey(rawPayload)`
- Produces:
  - `personal_invoices.invoice_key TEXT NOT NULL UNIQUE`
  - `personal_invoice_items.item_key TEXT NOT NULL UNIQUE`
  - `importDownloadsCsv(rawInput: Record<string, unknown>): Promise<Record<string, unknown>>`
  - E-invoice import behavior: one CSV row writes invoice metadata and one item row.

- [ ] **Step 1: Write the failing import check**

Create `src/ledger/import-downloads-csv.check.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "./db/client.ts";
import { importDownloadsCsv } from "./import-downloads-csv.ts";

const rootDir = await mkdtemp(join(tmpdir(), "einvoice-import-"));
const downloadsDir = join(rootDir, "downloads");
const outputDir = join(rootDir, "ledger");
const sourceDir = join(downloadsDir, "einvoice-personal-invoices");
await mkdir(sourceDir, { recursive: true });

const headers = [
  "carrier_customized_name",
  "issued_at",
  "invoice_id",
  "amount",
  "status",
  "rebated",
  "seller_business_account_number",
  "seller_name",
  "seller_addr",
  "buyer_business_account_number",
  "item_sequence_number",
  "item_quantity",
  "item_unit_price",
  "item_paid_amount",
  "item_product_name",
];

const confirmedRow = {
  carrier_customized_name: "mobile barcode",
  issued_at: "1783065600",
  invoice_id: "AB12345678",
  amount: "129",
  status: "confirmed",
  rebated: "false",
  seller_business_account_number: "24536806",
  seller_name: "Store",
  seller_addr: "Taipei",
  buyer_business_account_number: "",
  item_sequence_number: "1",
  item_quantity: "2",
  item_unit_price: "50",
  item_paid_amount: "100",
  item_product_name: "Coffee",
};

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function csv(rows: Array<Record<string, string>>): string {
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(","))
    .join("\n")}\n`;
}

async function runImport() {
  await importDownloadsCsv({
    downloadsDir,
    outputDir,
    bankFilters: ["einvoice"],
    productFilters: ["personal-invoices"],
  });
}

await writeFile(join(sourceDir, "first.csv"), csv([confirmedRow]), "utf8");
await runImport();

await writeFile(
  join(sourceDir, "second.csv"),
  csv([{ ...confirmedRow, status: "voided" }]),
  "utf8",
);
await runImport();

const db = openLedgerDatabase(outputDir, { readOnly: true });
const invoiceCount = db.prepare(
  "SELECT COUNT(*) AS count FROM personal_invoices",
).get() as { count: number };
const itemCount = db.prepare(
  "SELECT COUNT(*) AS count FROM personal_invoice_items",
).get() as { count: number };
const invoice = db.prepare(
  "SELECT invoice_id, issued_at, status, rebated FROM personal_invoices",
).get() as {
  invoice_id: string;
  issued_at: number;
  status: string;
  rebated: number;
};
const item = db.prepare(
  "SELECT item_sequence_number, item_product_name, item_paid_amount FROM personal_invoice_items",
).get() as {
  item_sequence_number: string;
  item_product_name: string;
  item_paid_amount: number;
};
db.close();

assert.equal(invoiceCount.count, 1);
assert.equal(itemCount.count, 1);
assert.deepEqual(invoice, {
  invoice_id: "AB12345678",
  issued_at: 1783065600,
  status: "voided",
  rebated: 0,
});
assert.deepEqual(item, {
  item_sequence_number: "1",
  item_product_name: "Coffee",
  item_paid_amount: 100,
});
```

- [ ] **Step 2: Run the import check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

Expected: fail because `importDownloadsCsv` is not exported, or because the normalized tables do not exist yet.

- [ ] **Step 3: Add normalized e-invoice schema helpers**

In `src/ledger/db/migrations.ts`, add this helper after `createTypedStatementSchema()`:

```ts
function createTypedStatementIndexesFor(db: LedgerDatabase, table: string) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source_file_id ON ${table}(source_file_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_import_run_id ON ${table}(import_run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table}(source_relative_path, source_row_index)`);
}

function createPersonalInvoiceStatementTables(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_invoices (
      ${COMMON_ROW_COLUMNS},
      invoice_key TEXT NOT NULL UNIQUE,
      carrier_customized_name TEXT,
      issued_at INTEGER,
      invoice_id TEXT NOT NULL,
      amount REAL,
      status TEXT,
      rebated INTEGER NOT NULL DEFAULT 0,
      seller_business_account_number TEXT,
      seller_name TEXT,
      seller_addr TEXT,
      buyer_business_account_number TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_personal_invoices_invoice_id
      ON personal_invoices(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_personal_invoices_issued_at
      ON personal_invoices(issued_at);
    CREATE INDEX IF NOT EXISTS idx_personal_invoices_seller
      ON personal_invoices(seller_business_account_number);

    CREATE TABLE IF NOT EXISTS personal_invoice_items (
      ${COMMON_ROW_COLUMNS},
      item_key TEXT NOT NULL UNIQUE,
      invoice_key TEXT NOT NULL,
      item_sequence_number TEXT,
      item_quantity REAL,
      item_unit_price REAL,
      item_paid_amount REAL,
      item_product_name TEXT,
      FOREIGN KEY (invoice_key) REFERENCES personal_invoices(invoice_key)
    );
    CREATE INDEX IF NOT EXISTS idx_personal_invoice_items_invoice_key
      ON personal_invoice_items(invoice_key);
    CREATE INDEX IF NOT EXISTS idx_personal_invoice_items_product_name
      ON personal_invoice_items(item_product_name);
  `);
}

function addPersonalInvoiceStatementTables(db: LedgerDatabase) {
  createPersonalInvoiceStatementTables(db);
  createTypedStatementIndexesFor(db, "personal_invoices");
  createTypedStatementIndexesFor(db, "personal_invoice_items");
}
```

- [ ] **Step 4: Wire schema helpers into fresh and existing migrations**

In `createTypedStatementSchema()`, call `createPersonalInvoiceStatementTables(db);` after the main `db.exec(...)` block and before the typed table index loop:

```ts
  createPersonalInvoiceStatementTables(db);

  for (const table of TYPED_STATEMENT_TABLES) {
    createTypedStatementIndexesFor(db, table);
  }
```

Replace the existing index loop body:

```ts
  for (const table of TYPED_STATEMENT_TABLES) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source_file_id ON ${table}(source_file_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_import_run_id ON ${table}(import_run_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table}(source_relative_path, source_row_index)`);
  }
```

with:

```ts
  for (const table of TYPED_STATEMENT_TABLES) {
    createTypedStatementIndexesFor(db, table);
  }
```

Append migration version 9:

```ts
  {
    version: 9,
    name: "personal_invoice_statement_tables",
    up: addPersonalInvoiceStatementTables,
  },
```

- [ ] **Step 5: Export the importer, add a CLI guard, and add upsert support**

In `src/ledger/import-downloads-csv.ts`, add the URL import near the existing Node imports:

```ts
import { pathToFileURL } from "node:url";
```

Extend the parser imports:

```ts
import {
  TYPED_STATEMENT_TABLES,
  createSourceCsvParser,
  personalInvoiceFields,
  personalInvoiceItemFields,
  type SourceMetadata,
} from "./source-csv-parsers.ts";
```

Add these constants and helper after `insertRecord()`:

```ts
const PERSONAL_INVOICE_UPDATE_COLUMNS = [
  "carrier_customized_name",
  "issued_at",
  "invoice_id",
  "amount",
  "status",
  "rebated",
  "seller_business_account_number",
  "seller_name",
  "seller_addr",
  "buyer_business_account_number",
] as const;

const PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS = [
  "invoice_key",
  "item_sequence_number",
  "item_quantity",
  "item_unit_price",
  "item_paid_amount",
  "item_product_name",
] as const;

function upsertRecord(
  db: LedgerDatabase,
  table: string,
  record: Record<string, unknown>,
  conflictColumn: string,
  updateColumns: readonly string[],
) {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  const assignments = updateColumns
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${conflictColumn}) DO UPDATE SET ${assignments}`,
  ).run(...columns.map((column) => sqliteValue(record[column])));
}
```

Change the importer declaration from:

```ts
async function importDownloadsCsv(rawInput: Record<string, unknown>) {
```

to:

```ts
export async function importDownloadsCsv(rawInput: Record<string, unknown>) {
```

Replace the unconditional CLI call at the bottom:

```ts
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
```

with this entrypoint guard:

```ts
const isCliEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCliEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Special-case e-invoice row insertion**

Add this helper before `insertTypedStatementRow()`:

```ts
function insertPersonalInvoiceStatementRow(
  db: LedgerDatabase,
  sourceFileRecord: Record<string, unknown>,
  row: {
    sourceRowIndex: number;
    rawPayload: Record<string, string>;
    rawRowHash?: string;
    sourceHash?: string;
    contentHash?: string;
    dedupeStatus?: string;
  },
) {
  const commonFields = commonTypedRowFields(sourceFileRecord, row);
  upsertRecord(
    db,
    "personal_invoices",
    {
      ...commonFields,
      ...personalInvoiceFields(row.rawPayload),
    },
    "invoice_key",
    PERSONAL_INVOICE_UPDATE_COLUMNS,
  );
  upsertRecord(
    db,
    "personal_invoice_items",
    {
      ...commonFields,
      ...personalInvoiceItemFields(row.rawPayload),
    },
    "item_key",
    PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS,
  );
}
```

At the top of `insertTypedStatementRow()`, add this branch:

```ts
  const bank = String(sourceFileRecord.bank ?? "");
  const product = String(sourceFileRecord.product ?? "");
  if (bank === "einvoice" && product === "personal-invoices") {
    insertPersonalInvoiceStatementRow(db, sourceFileRecord, row);
    return;
  }
```

Then reuse `bank` and `product` in the existing parser context:

```ts
  const parser = createSourceCsvParser({
    bank,
    product,
    sourceRelativePath,
    metadata: (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    headers,
  });
```

- [ ] **Step 7: Run the import check and verify it passes**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

Expected: progress lines may print, then exit code 0.

- [ ] **Step 8: Re-run the parser check**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
```

Expected: no output and exit code 0.

- [ ] **Step 9: Commit**

```bash
git add src/ledger/db/migrations.ts src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "feat: import e-invoices into normalized tables"
```

---

### Task 3: Workflow CSV Shape For Import

**Files:**
- Modify: `src/workflows/einvoice-personal-invoices.ts`

**Interfaces:**
- Consumes: existing parsed invoice API responses.
- Produces: CSV files under `downloads/einvoice-personal-invoices/` with the `item_sequence_number` column.

- [ ] **Step 1: Add item sequence to the workflow row type**

In `src/workflows/einvoice-personal-invoices.ts`, extend `InvoiceItem`:

```ts
type InvoiceItem = {
  sequenceNumber?: string | null;
  item?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
};
```

Extend `PurchasedItemRow`:

```ts
type PurchasedItemRow = {
  carrier_customized_name: string;
  issued_at: string;
  invoice_id: string;
  amount: string;
  status: string;
  rebated: string;
  seller_business_account_number: string;
  seller_name: string;
  seller_addr: string;
  buyer_business_account_number: string;
  item_sequence_number: string;
  item_quantity: string;
  item_unit_price: string;
  item_paid_amount: string;
  item_product_name: string;
};
```

- [ ] **Step 2: Add item sequence to the CSV header**

Update `csvHeaders`:

```ts
const csvHeaders: (keyof PurchasedItemRow)[] = [
  "carrier_customized_name",
  "issued_at",
  "invoice_id",
  "amount",
  "status",
  "rebated",
  "seller_business_account_number",
  "seller_name",
  "seller_addr",
  "buyer_business_account_number",
  "item_sequence_number",
  "item_quantity",
  "item_unit_price",
  "item_paid_amount",
  "item_product_name",
];
```

- [ ] **Step 3: Populate item sequence deterministically**

Replace the row mapping in `purchasedItemRows()` with this block:

```ts
  return rows.map((item, index) => ({
    ...base,
    item_sequence_number: cleanText(item.sequenceNumber) || String(index + 1),
    item_quantity: cleanText(item.quantity),
    item_unit_price: cleanText(item.unitPrice),
    item_paid_amount: cleanText(item.amount),
    item_product_name: cleanText(item.item),
  }));
```

- [ ] **Step 4: Write e-invoice CSVs to the importer context folder**

In `writeInvoicesFile()`, replace:

```ts
  const dir = join(process.cwd(), "downloads");
```

with:

```ts
  const dir = join(process.cwd(), "downloads", "einvoice-personal-invoices");
```

- [ ] **Step 5: Run TypeScript verification**

Run:

```bash
npx tsc --noEmit
```

Expected: no output and exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/einvoice-personal-invoices.ts
git commit -m "feat: shape e-invoice csv for import"
```

---

### Task 4: Automation Registry Wiring

**Files:**
- Modify: `src/lib/automation/server/tasks.ts`
- Modify: `src/lib/automation/server/automation-core.check.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: package script `run:einvoice-personal-invoices`.
- Produces:
  - Credential group `einvoice`.
  - Automation crawler task `einvoice-personal-invoices`.
  - `import-downloads-csv` dependency on `einvoice-personal-invoices`.
  - Environment key `LIBRETTO_CLOUD_EINVOICE_ENABLED`.

- [ ] **Step 1: Update the automation check first**

In `src/lib/automation/server/automation-core.check.ts`, update the first `CSV_IMPORT_DEPENDENCY_IDS` assertion:

```ts
assert.deepEqual(
  CSV_IMPORT_DEPENDENCY_IDS,
  [
    "fubon-all-statements",
    "esun-credit-card-statements",
    "yuanta-all-statements",
    "yuanta-trade-statements",
    "cathay-all-statements",
    "hncb-statements",
    "ctbc-statements",
    "post-statements",
    "sinopac-statements",
    "linebank-statements",
    "einvoice-personal-invoices",
  ],
);
```

Add these assertions after the existing `post` credential assertion:

```ts
assert.equal(taskById("einvoice-personal-invoices")?.kind, "crawler");
assert.equal(taskById("einvoice-personal-invoices")?.credentialGroupId, "einvoice");
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "einvoice")
    ?.credentialKeys,
  [
    "LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER",
    "LIBRETTO_CLOUD_EINVOICE_PASSWORD",
  ],
);
assert.equal(
  AUTOMATION_ENABLED_KEYS.includes("LIBRETTO_CLOUD_EINVOICE_ENABLED"),
  true,
);
assert.equal(
  AUTOMATION_SECRET_KEYS.includes("LIBRETTO_CLOUD_EINVOICE_PASSWORD"),
  true,
);
```

Update the `enabledCsvImportDependencyIds(enabledGroups)` assertion:

```ts
assert.deepEqual(
  enabledCsvImportDependencyIds(enabledGroups),
  [
    "fubon-all-statements",
    "yuanta-all-statements",
    "yuanta-trade-statements",
    "cathay-all-statements",
    "hncb-statements",
    "ctbc-statements",
    "post-statements",
    "sinopac-statements",
    "linebank-statements",
    "einvoice-personal-invoices",
  ],
);
```

- [ ] **Step 2: Run the automation check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
```

Expected: fail because the e-invoice task and credential group are not registered yet.

- [ ] **Step 3: Add the e-invoice import dependency**

In `src/lib/automation/server/tasks.ts`, append the task ID to `CSV_IMPORT_DEPENDENCY_IDS`:

```ts
export const CSV_IMPORT_DEPENDENCY_IDS = [
  "fubon-all-statements",
  "esun-credit-card-statements",
  "yuanta-all-statements",
  "yuanta-trade-statements",
  "cathay-all-statements",
  "hncb-statements",
  "ctbc-statements",
  "post-statements",
  "sinopac-statements",
  "linebank-statements",
  "einvoice-personal-invoices",
] as const;
```

- [ ] **Step 4: Add the e-invoice credential group**

Add this group after the `linebank` group and before `maicoin`:

```ts
  {
    id: "einvoice",
    label: "E-Invoice",
    enabledKey: "LIBRETTO_CLOUD_EINVOICE_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER",
      "LIBRETTO_CLOUD_EINVOICE_PASSWORD",
    ],
  },
```

- [ ] **Step 5: Add the e-invoice crawler task**

Add this task after the `linebank-statements` task and before `sync-maicoin`:

```ts
  {
    id: "einvoice-personal-invoices",
    label: "E-Invoice personal invoices",
    script: "run:einvoice-personal-invoices",
    command: ["libretto", "run", "src/workflows/einvoice-personal-invoices.ts"],
    kind: "crawler",
    credentialGroupId: "einvoice",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[10].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
```

Then update the existing MaiCoin task credential index from:

```ts
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[10].credentialKeys,
```

to:

```ts
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[11].credentialKeys,
```

- [ ] **Step 6: Add the e-invoice enabled flag to `.env.example`**

Add this line near the existing e-invoice credentials:

```dotenv
LIBRETTO_CLOUD_EINVOICE_ENABLED=true
```

- [ ] **Step 7: Run the automation check and verify it passes**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
```

Expected: no output and exit code 0.

- [ ] **Step 8: Run all focused checks and typecheck**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
npx tsc --noEmit
```

Expected: all commands exit 0. The import check may print automation progress lines.

- [ ] **Step 9: Commit**

```bash
git add src/lib/automation/server/tasks.ts src/lib/automation/server/automation-core.check.ts .env.example
git commit -m "feat: register e-invoice automation task"
```

---

## Acceptance Checks

- `src/workflows/einvoice-personal-invoices.ts` writes CSVs under `downloads/einvoice-personal-invoices/`.
- The generated CSV includes `item_sequence_number`.
- `personal_invoices` has one row per stable invoice key.
- `personal_invoice_items` has one row per stable invoice item key.
- Re-importing the same invoice from a second CSV does not create duplicate invoice or item rows.
- A later CSV with the same invoice key and a changed `status` refreshes `personal_invoices.status`.
- `import-downloads-csv` depends on `einvoice-personal-invoices` through `CSV_IMPORT_DEPENDENCY_IDS`.
- `node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts` exits 0.
- `node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts` exits 0.
- `node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts` exits 0.
- `npx tsc --noEmit` exits 0.
