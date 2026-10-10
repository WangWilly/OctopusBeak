import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalEInvoiceCaptureFromApp,
  canonicalOccurrence,
  mapCanonicalEInvoiceRecord,
  type InvoiceCaptureRecord,
} from "./einvoice-personal-invoices.ts";

const workflowSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "einvoice-personal-invoices.ts"),
  "utf8",
);
assert.doesNotMatch(workflowSource, /from\s+["']libretto["']|export\s+default\s+workflow\s*\(/u);
assert.doesNotMatch(workflowSource, /librettoAuthenticate|\bpause\(|npx libretto|emitAutomationProgress/u);
assert.doesNotMatch(workflowSource, /requirePGliteChildRpcClientFromEnv|pglite-child-rpc-client|createPGliteChildRpc/u);
assert.doesNotMatch(workflowSource, /node:fs|writeFile|appendFile|createWriteStream|process\.env|console\.(?:log|error)|logPath/u);
assert.match(workflowSource, /runEinvoiceProviderWorkflow/u);
assert.match(workflowSource, /financialCommit\.execute/u);

const credentials = {
  einvoice_phone_number: "0900000000",
  einvoice_password: "test-only-secret",
};
const month = { year: 2026, month: 9 };
const completeRecord = {
  month,
  listPageIndex: 0,
  entry: {
    token: "opaque-provider-row-a",
    invoiceNumber: "AA00000001",
    invoiceStrStatus: "INVOICE0003S",
    totalAmount: "120",
  },
  header: {
    invoiceDate: "20260910",
    invoiceTime: "13:14:15",
    totalAmount: "120",
    invoiceStrStatus: "INVOICE0003S",
    sellerId: "11112222",
    sellerName: "Deidentified Shop",
  },
  items: [{
    sequenceNumber: "1",
    item: "Deidentified item",
    quantity: "2",
    unitPrice: "60",
    amount: "120",
  }],
  itemCompleteness: "complete" as const,
};

assert.deepEqual(canonicalOccurrence(completeRecord.header), {
  value: "2026-09-10T13:14:15",
  precision: "second",
  timeZone: "Asia/Taipei",
  origin: "source-reported",
});
assert.throws(
  () => canonicalOccurrence({}),
  /did not provide a valid purchase date/,
  "the workflow must not invent a date from the queried month",
);

const mapped = mapCanonicalEInvoiceRecord(completeRecord);
assert.equal(mapped.revisionKind, "issued");
assert.equal(mapped.revisionNumber, 1);
assert.equal(mapped.items.length, 1);
assert.equal(mapped.items[0]?.completeness, "complete");
assert.deepEqual(mapped.items[0]?.quantity, { coefficient: "2", scale: 0 });
assert.doesNotMatch(JSON.stringify(mapped), /0900000000|test-only-secret/);
const normalizedDecimal = mapCanonicalEInvoiceRecord({
  ...completeRecord,
  items: [{
    ...completeRecord.items[0]!,
    quantity: "0.00",
    unitPrice: "-0.00",
    amount: "-0.5",
  }],
});
assert.deepEqual(normalizedDecimal.items[0]?.quantity, { coefficient: "0", scale: 2 });
assert.equal(normalizedDecimal.items[0]?.unitPrice?.coefficient, "0");
assert.equal(normalizedDecimal.items[0]?.unitPrice?.scale, 2);
assert.equal(normalizedDecimal.items[0]?.amount?.coefficient, "-5");
assert.equal(normalizedDecimal.items[0]?.amount?.scale, 1);
const normalizedOnePointFive = mapCanonicalEInvoiceRecord({
  ...completeRecord,
  items: [{ ...completeRecord.items[0]!, quantity: "1.5" }],
});
assert.deepEqual(
  normalizedOnePointFive.items[0]?.quantity,
  { coefficient: "15", scale: 1 },
);
assert.throws(
  () => mapCanonicalEInvoiceRecord({
    ...completeRecord,
    entry: { ...completeRecord.entry, invoiceStrStatus: "UNKNOWN" },
    header: { ...completeRecord.header, invoiceStrStatus: "UNKNOWN" },
  }),
  /status UNKNOWN is not admitted/,
  "unknown provider lifecycle values must not be guessed as issued or revised",
);
assert.throws(
  () => mapCanonicalEInvoiceRecord({
    ...completeRecord,
    header: { ...completeRecord.header, sellerId: null },
  }),
  /seller tax ID is required/,
);

// The App protocol reports an issued invoice as 開立已確認.
const appIssuedRecord = {
  ...completeRecord,
  entry: { ...completeRecord.entry, invoiceStrStatus: "開立已確認" },
  header: { ...completeRecord.header, invoiceStrStatus: "開立已確認", extStatus: "開立已確認" },
};
assert.equal(mapCanonicalEInvoiceRecord(appIssuedRecord).revisionKind, "issued");

const captureInput = (
  records: readonly InvoiceCaptureRecord[],
  captureId: string,
  observedAt: string,
) => buildCanonicalEInvoiceCaptureFromApp({
  records,
  pages: [{ month, pageIndex: 0, rowCount: records.length }],
  months: ["2026-09"],
}, credentials, { captureId, observedAt, today: new Date("2026-09-10T00:00:00Z") });

const commaDecimalRecord = {
  ...completeRecord,
  items: [{ ...completeRecord.items[0]!, quantity: "1,5" }],
};
assert.throws(
  () => captureInput(
    [commaDecimalRecord],
    "einvoice-workflow-comma-decimal",
    "2026-09-10T04:59:00Z",
  ),
  /E-Invoice item 1 quantity is not an exact decimal/,
  "comma-decimal quantities must not silently become fifteen",
);
for (const malformed of ["12,34", "1,23,456", "1,,000", "１,０００", "1，000", "1e3", "1 000"]) {
  assert.throws(
    () => captureInput(
      [{ ...completeRecord, items: [{ ...completeRecord.items[0]!, quantity: malformed }] }],
      `einvoice-workflow-invalid-decimal-${malformed}`,
      "2026-09-10T04:59:01Z",
    ),
    /E-Invoice item 1 quantity is not an exact decimal/,
    `malformed decimal ${malformed} must fail closed`,
  );
}
assert.throws(
  () => captureInput(
    [{ ...completeRecord, items: [{ ...completeRecord.items[0]!, unitPrice: "1,5" }] }],
    "einvoice-workflow-invalid-unit-price",
    "2026-09-10T04:59:02Z",
  ),
  /E-Invoice item 1 unit price is not an exact decimal/,
);
assert.throws(
  () => captureInput(
    [{ ...completeRecord, items: [{ ...completeRecord.items[0]!, amount: "1,5" }] }],
    "einvoice-workflow-invalid-amount",
    "2026-09-10T04:59:03Z",
  ),
  /E-Invoice item 1 amount is not an exact decimal/,
);
const groupedDecimal = mapCanonicalEInvoiceRecord({
  ...completeRecord,
  items: [{
    ...completeRecord.items[0]!,
    quantity: "+1,000",
    unitPrice: "-12,345.67",
    amount: "12,345.67",
  }],
});
assert.deepEqual(groupedDecimal.items[0]?.quantity, { coefficient: "1000", scale: 0 });
assert.equal(groupedDecimal.items[0]?.unitPrice?.coefficient, "-1234567");
assert.equal(groupedDecimal.items[0]?.unitPrice?.scale, 2);
assert.equal(groupedDecimal.items[0]?.amount?.coefficient, "1234567");
assert.equal(groupedDecimal.items[0]?.amount?.scale, 2);

const captureWithItems = (
  items: InvoiceCaptureRecord["items"],
  captureId: string,
) => captureInput([
  {
    ...completeRecord,
    items,
    itemCompleteness: "complete",
  },
], captureId, "2026-09-10T05:00:00Z");

const zeroSequenceCapture = captureWithItems([
  { ...completeRecord.items[0]!, sequenceNumber: "0" },
], "einvoice-workflow-sequence-zero");
assert.deepEqual(
  zeroSequenceCapture.invoices[0]?.items.map((item) => item.sequence),
  [1],
  "a non-positive provider sequence falls back to the API response ordinal",
);
assert.equal(
  zeroSequenceCapture.invoices[0]?.items[0]?.sourceFacts?.providerSequenceRaw,
  "0",
  "the invalid provider sequence remains as compact source evidence",
);

const malformedSequenceCapture = captureWithItems([
  { ...completeRecord.items[0]!, sequenceNumber: "1.0" },
], "einvoice-workflow-sequence-malformed");
assert.deepEqual(
  malformedSequenceCapture.invoices[0]?.items.map((item) => item.sequence),
  [1],
  "a malformed provider sequence falls back to the API response ordinal",
);
assert.equal(
  malformedSequenceCapture.invoices[0]?.items[0]?.sourceFacts?.providerSequenceRaw,
  "1.0",
);

const duplicateSequenceCapture = captureWithItems([
  { ...completeRecord.items[0]!, sequenceNumber: "3", item: "First item", amount: "60" },
  { ...completeRecord.items[0]!, sequenceNumber: "3", item: "Second item", amount: "60" },
], "einvoice-workflow-sequence-duplicate");
assert.deepEqual(
  duplicateSequenceCapture.invoices[0]?.items.map((item) => item.sequence),
  [1, 2],
  "duplicate provider sequences fall back for every item",
);
assert.deepEqual(
  duplicateSequenceCapture.invoices[0]?.items.map((item) => item.sourceFacts?.providerSequenceRaw),
  ["3", "3"],
);

const missingSequenceCapture = captureWithItems([
  { ...completeRecord.items[0]!, sequenceNumber: undefined },
], "einvoice-workflow-sequence-missing");
assert.deepEqual(
  missingSequenceCapture.invoices[0]?.items.map((item) => item.sequence),
  [1],
  "a missing provider sequence falls back to the API response ordinal",
);
assert.equal(
  "providerSequenceRaw" in (missingSequenceCapture.invoices[0]?.items[0]?.sourceFacts ?? {}),
  false,
  "missing provider sequence does not create a fabricated raw value",
);

const validNonContiguousCapture = captureWithItems([
  { ...completeRecord.items[0]!, sequenceNumber: " 4 ", item: "Fourth item", amount: "60" },
  { ...completeRecord.items[0]!, sequenceNumber: "9", item: "Ninth item", amount: "60" },
], "einvoice-workflow-sequence-valid");
assert.deepEqual(
  validNonContiguousCapture.invoices[0]?.items.map((item) => item.sequence),
  [4, 9],
  "unique positive provider sequences retain their source values after trimming",
);
assert.deepEqual(
  validNonContiguousCapture.invoices[0]?.items.map((item) => item.sourceFacts?.providerSequenceRaw),
  ["4", "9"],
);

const firstCapture = captureInput(
  [completeRecord],
  "einvoice-workflow-normal",
  "2026-09-10T05:00:00Z",
);
const duplicateCapture = captureInput(
  [completeRecord, {
    ...completeRecord,
    entry: { ...completeRecord.entry, token: "another-provider-row-token" },
  }],
  "einvoice-workflow-identical-duplicate",
  "2026-09-10T05:00:01Z",
);
assert.equal(duplicateCapture.invoices.length, 1, "identical provider rows represent one invoice revision");
assert.equal(duplicateCapture.pages[0]?.rowCount, 1, "source page row count tracks admitted unique records");
assert.equal(duplicateCapture.pages[0]?.metadata.providerRowCount, 2, "raw provider row count remains auditable");
const duplicateAcrossPages = buildCanonicalEInvoiceCaptureFromApp({
  records: [completeRecord, { ...completeRecord, listPageIndex: 1 }],
  pages: [
    { month, pageIndex: 0, rowCount: 1 },
    { month, pageIndex: 1, rowCount: 1 },
  ],
  months: ["2026-09"],
}, credentials, {
  captureId: "einvoice-workflow-identical-duplicate-pages",
  observedAt: "2026-09-10T05:00:03Z",
  today: new Date("2026-09-10T00:00:00Z"),
});
assert.deepEqual(duplicateAcrossPages.pages.map((page) => page.rowCount), [1, 0]);
assert.deepEqual(duplicateAcrossPages.pages.map((page) => page.metadata.providerRowCount), [1, 1]);
assert.throws(() => captureInput(
  [completeRecord, {
    ...completeRecord,
    header: { ...completeRecord.header, sellerName: "Different seller name" },
  }],
  "einvoice-workflow-conflicting-duplicate",
  "2026-09-10T05:00:02Z",
), /same invoice revision.*different facts/u);
assert.match(firstCapture.sourceConnectionKey, /^sha256:/u);
assert.match(firstCapture.subjectDigest, /^sha256:/u);
assert.doesNotMatch(JSON.stringify(firstCapture), /0900000000|test-only-secret/);

// The App protocol capture builder marks the final (empty) page terminal.
const appCapture = buildCanonicalEInvoiceCaptureFromApp({
  records: [completeRecord],
  pages: [
    { month, pageIndex: 0, rowCount: 1 },
    { month, pageIndex: 1, rowCount: 0 },
  ],
  months: ["2026-09"],
}, credentials, {
  captureId: "einvoice-app-protocol-capture",
  observedAt: "2026-09-10T05:00:04Z",
  today: new Date("2026-09-10T00:00:00Z"),
});
assert.equal(appCapture.invoices.length, 1);
assert.equal(appCapture.scope.completeness, "complete-range");
assert.deepEqual(appCapture.pages.map((page) => page.rowCount), [1, 0]);
assert.deepEqual(appCapture.pages.map((page) => page.terminal), [false, true]);
assert.deepEqual(appCapture.pages.map((page) => page.responseCode), ["200", "200"]);
assert.equal(appCapture.pages[0]?.metadata.providerRowCount, 1);
