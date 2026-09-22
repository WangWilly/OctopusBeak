import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { emitHumanAssistanceStage } from "./human-assistance.ts";
import {
  buildCanonicalEInvoiceCapture,
  canonicalOccurrence,
  closeInvoiceDetailModal,
  commitCanonicalCapture,
  einvoiceCaptchaAssistanceStage,
  mapCanonicalEInvoiceRecord,
  retryEinvoiceLoginNavigation,
  type InvoiceCaptureRecord,
  validatePaginationEnvelope,
  waitForEinvoiceLoginOutcome,
  waitForListResponse,
} from "./einvoice-personal-invoices.ts";
import { openCanonicalDatabaseHandle } from "../ledger/canonical/canonical-database.ts";
import { queryCanonicalEInvoiceCurrentFromDatabase } from "../ledger/canonical/einvoice.ts";

const workflowSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "einvoice-personal-invoices.ts"),
  "utf8",
);
assert.doesNotMatch(workflowSource, /writeInvoicesFile|purchased_invoice|rowsToCsv|csvPath/u);
assert.match(workflowSource, /const commit = await commitCanonicalCapture/u);
assert.match(workflowSource, /startUrl: LOGIN_URL/u);
assert.match(
  workflowSource,
  /executeCanonicalFinancialCommitRun[\s\S]*?commitCanonicalEInvoiceCaptureInTransaction/u,
);
assert.doesNotMatch(
  workflowSource,
  /createCanonicalSourceStore|canonicalDatabaseWriterKey|openCanonicalDatabaseHandle|OCTOPUSBEAK_CANONICAL_(?:SOURCE|FINANCIAL)_LEDGER_DIR/u,
);

let redirectAttempts = 0;
assert.equal(await retryEinvoiceLoginNavigation(async () => {
  redirectAttempts += 1;
  if (redirectAttempts === 1) throw new Error("Execution context was destroyed");
  return "login-form-ready";
}), "login-form-ready");
assert.equal(redirectAttempts, 2);
let unrelatedAttempts = 0;
await assert.rejects(retryEinvoiceLoginNavigation(async () => {
  unrelatedAttempts += 1;
  throw new Error("Invalid form field");
}), /Invalid form field/);
assert.equal(unrelatedAttempts, 1);

const browser = await chromium.launch();
try {
  const captchaPage = await browser.newPage();
  await captchaPage.setContent(`
    <input id="captcha" style="width: 120px; height: 32px" />
    <span class="input-group-text code_num">
      <img
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        style="width: 150px; height: 40px"
        alt="圖形驗證碼"
      />
    </span>
  `);
  const captchaContract = await emitHumanAssistanceStage(
    einvoiceCaptchaAssistanceStage(captchaPage),
    (contract) => contract,
  );
  assert.equal(captchaContract.stageId, "einvoice-login-captcha");
  assert.equal(captchaContract.challengeKind, "text-captcha");
  assert.equal(captchaContract.charset, "digits");
  assert.equal(captchaContract.imagePreprocessing, undefined);
  assert.equal(captchaContract.ocrPageSegmentationMode, "single-word");
  assert.deepEqual(captchaContract.ocrAttemptPlan, [
    { imagePreprocessing: ["mask-bottom-interference-band"] },
    { imagePreprocessing: ["suppress-horizontal-interference"] },
  ]);
  assert.deepEqual(captchaContract.solveAcceptancePolicy, {
    mode: "agreement-only",
  });
  assert.equal(captchaContract.expectedAnswerLength, 5);
  assert.equal(
    captchaContract.targets[0]?.semanticId,
    "einvoice.login.captcha-input",
  );
  assert.equal(
    captchaContract.challengeImageRegion?.semanticId,
    "einvoice.login.captcha-image",
  );
  assert.equal(captchaContract.challengeImageRegion?.rect?.width, 150);
  assert.equal(captchaContract.challengeImageRegion?.rect?.height, 40);
  await captchaPage.close();

  const outcomePage = await browser.newPage();
  await outcomePage.setContent('<div role="alert">圖形驗證碼錯誤，請重新輸入</div>');
  assert.equal(await waitForEinvoiceLoginOutcome(outcomePage, 50), "captcha-rejected");
  await outcomePage.setContent('<div role="alert">密碼不正確</div>');
  assert.equal(await waitForEinvoiceLoginOutcome(outcomePage, 50), "credentials-rejected");
  await outcomePage.setContent('<div>會員專區</div>');
  assert.equal(await waitForEinvoiceLoginOutcome(outcomePage, 50), "authenticated");
  await outcomePage.setContent('<div>登入中</div>');
  assert.equal(await waitForEinvoiceLoginOutcome(outcomePage, 25), "unconfirmed");
  await outcomePage.close();
} finally {
  await browser.close();
}

const actions: string[] = [];
let modalVisible = true;
let closeClicks = 0;
const closeButton = {
  async click() {
    actions.push("click-close");
    closeClicks += 1;
    if (closeClicks === 2) modalVisible = false;
  },
};
const modal = {
  first() {
    return this;
  },
  async isVisible() {
    actions.push("modal-visible");
    return modalVisible;
  },
  getByRole(role: string, options: { name: string }) {
    assert.equal(role, "button");
    assert.equal(options.name, "關閉視窗");
    return closeButton;
  },
  async waitFor(options: { state: string }) {
    actions.push(`wait-modal-${options.state}`);
    if (modalVisible) throw new Error("Modal is still visible");
  },
};
const backdrop = {
  first() {
    return this;
  },
  async waitFor(options: { state: string }) {
    actions.push(`wait-backdrop-${options.state}`);
  },
};
const page = {
  locator(selector: string) {
    if (selector === ".modal_barcode_detail.show") return modal;
    if (selector === ".simple-modal-backdrop") return backdrop;
    throw new Error(`Unexpected selector: ${selector}`);
  },
};

await closeInvoiceDetailModal(page as unknown as Page);

assert.deepEqual(actions, [
  "modal-visible",
  "click-close",
  "wait-modal-hidden",
  "modal-visible",
  "click-close",
  "wait-modal-hidden",
  "wait-backdrop-hidden",
]);

actions.length = 0;
modalVisible = false;
await closeInvoiceDetailModal(page as unknown as Page);
assert.deepEqual(actions, [
  "modal-visible",
  "wait-backdrop-hidden",
]);

const noContentListResponse = await waitForListResponse({
  async waitForResponse(
    predicate: (response: {
      url(): string;
      request(): { method(): string };
    }) => boolean,
  ) {
    const response = {
      url: () =>
        "https://www.einvoice.nat.gov.tw/btc/cloud/api/btc502w/searchCarrierInvoice",
      request: () => ({ method: () => "POST" }),
    };
    assert.equal(predicate(response), true);
    return {
      status: () => 204,
      json: async () => await new Response(null, { status: 204 }).json(),
    };
  },
} as unknown as Page);

assert.deepEqual(noContentListResponse, {
  httpStatus: 204,
  totalElements: 0,
  totalPages: 0,
  size: 0,
  content: [],
});
assert.doesNotThrow(() => validatePaginationEnvelope("empty fixture", noContentListResponse));
assert.throws(
  () => validatePaginationEnvelope("truncated fixture", {
    totalElements: 2,
    totalPages: 0,
    size: 0,
    content: [],
  }),
  /pagination metadata is incomplete/,
);

const populatedListResponse = {
  httpStatus: 200 as const,
  totalElements: 1,
  totalPages: 1,
  size: 1,
  content: [],
};
assert.deepEqual(
  await waitForListResponse({
    async waitForResponse() {
      return {
        status: () => 200,
        json: async () => populatedListResponse,
      };
    },
  } as unknown as Page),
  populatedListResponse,
);

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

const captureInput = (
  records: readonly InvoiceCaptureRecord[],
  captureId: string,
  observedAt: string,
) => buildCanonicalEInvoiceCapture({
  records,
  pages: [{
    month,
    pageIndex: 0,
    list: {
      httpStatus: 200,
      totalElements: records.length,
      totalPages: records.length === 0 ? 0 : 1,
      size: records.length,
      content: records.map((record) => record.entry),
    },
  }],
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

const workflowLedgerDir = await mkdtemp(join(tmpdir(), "einvoice-workflow-canonical-"));
try {
  const firstCapture = captureInput(
    [completeRecord],
    "einvoice-workflow-normal",
    "2026-09-10T05:00:00Z",
  );
  assert.match(firstCapture.sourceConnectionKey, /^sha256:/u);
  assert.match(firstCapture.subjectDigest, /^sha256:/u);
  assert.doesNotMatch(JSON.stringify(firstCapture), /0900000000|test-only-secret/);
  const committed = await commitCanonicalCapture(firstCapture, workflowLedgerDir);
  assert.equal(committed.status, "committed");
  assert.equal(committed.invoiceCount, 1);
  assert.equal(committed.itemCount, 1);

  const renewedRowTokenCapture = captureInput(
    [{
      ...completeRecord,
      entry: {
        ...completeRecord.entry,
        token: "opaque-provider-row-a-renewed",
      },
    }],
    "einvoice-workflow-renewed-row-token",
    "2026-09-10T05:00:15Z",
  );
  const renewedRowTokenCommit = await commitCanonicalCapture(
    renewedRowTokenCapture,
    workflowLedgerDir,
  );
  assert.equal(
    renewedRowTokenCommit.insertedRevisionCount,
    0,
    "a refreshed list-row token must not create or overwrite an invoice revision",
  );
  assert.equal(renewedRowTokenCommit.observedDuplicateCount, 1);

  const fractionalStringRecord = {
    ...completeRecord,
    entry: {
      ...completeRecord.entry,
      token: "opaque-provider-row-fractional-string",
      invoiceNumber: "AA00000003",
    },
    items: [{
      ...completeRecord.items[0]!,
      quantity: "0.5",
      unitPrice: "240",
    }],
  };
  const fractionalStringCapture = captureInput(
    [fractionalStringRecord],
    "einvoice-workflow-fractional-string",
    "2026-09-10T05:00:30Z",
  );
  const fractionalStringCommit = await commitCanonicalCapture(
    fractionalStringCapture,
    workflowLedgerDir,
  );
  assert.equal(fractionalStringCommit.itemCount, 1);
  assert.deepEqual(
    fractionalStringCapture.invoices[0]?.items[0]?.quantity,
    { coefficient: "5", scale: 1 },
    "fractional string quantities retain exact decimal scale without a leading zero",
  );

  const fractionalNumberRecord = {
    ...completeRecord,
    entry: {
      ...completeRecord.entry,
      token: "opaque-provider-row-fractional-number",
      invoiceNumber: "AA00000004",
    },
    items: [{
      ...completeRecord.items[0]!,
      quantity: 0.5,
      unitPrice: "240",
    }],
  };
  const fractionalNumberCapture = captureInput(
    [fractionalNumberRecord],
    "einvoice-workflow-fractional-number",
    "2026-09-10T05:00:31Z",
  );
  const fractionalNumberCommit = await commitCanonicalCapture(
    fractionalNumberCapture,
    workflowLedgerDir,
  );
  assert.equal(fractionalNumberCommit.itemCount, 1);
  assert.deepEqual(
    fractionalNumberCapture.invoices[0]?.items[0]?.quantity,
    { coefficient: "5", scale: 1 },
    "fractional numeric quantities use the same exact decimal normalization",
  );

  const incompleteRecord = {
    ...completeRecord,
    entry: {
      ...completeRecord.entry,
      token: "opaque-provider-row-b",
      invoiceNumber: "AA00000002",
      totalAmount: "75",
    },
    header: {
      ...completeRecord.header,
      totalAmount: "75",
    },
    items: [{ sequenceNumber: "1", item: "Partial item" }],
    itemCompleteness: "incomplete" as const,
  };
  const incompleteCapture = buildCanonicalEInvoiceCapture({
    records: [incompleteRecord],
    pages: [{
      month,
      pageIndex: 0,
      list: { httpStatus: 200, totalElements: 1, totalPages: 1, size: 1, content: [incompleteRecord.entry] },
    }],
    months: ["2026-09"],
  }, credentials, {
    captureId: "einvoice-workflow-incomplete",
    observedAt: "2026-09-10T05:01:00Z",
    today: new Date("2026-09-10T00:00:00Z"),
  });
  assert.equal(incompleteCapture.scope.itemCompleteness, "incomplete");
  await commitCanonicalCapture(incompleteCapture, workflowLedgerDir);

  const revokedRecord = {
    ...completeRecord,
    entry: {
      ...completeRecord.entry,
      token: "opaque-provider-row-a-revoked",
      invoiceStrStatus: "4",
    },
    header: {
      ...completeRecord.header,
      invoiceStrStatus: "4",
    },
    items: [],
  };
  const revokedCapture = buildCanonicalEInvoiceCapture({
    records: [revokedRecord],
    pages: [{
      month,
      pageIndex: 0,
      list: { httpStatus: 200, totalElements: 1, totalPages: 1, size: 1, content: [revokedRecord.entry] },
    }],
    months: ["2026-09"],
  }, credentials, {
    captureId: "einvoice-workflow-revoked",
    observedAt: "2026-09-10T05:02:00Z",
    today: new Date("2026-09-10T00:00:00Z"),
  });
  assert.equal(revokedCapture.invoices[0]?.revisionKind, "revoked");
  assert.equal(revokedCapture.invoices[0]?.total, null);
  await commitCanonicalCapture(revokedCapture, workflowLedgerDir);

  const store = openCanonicalDatabaseHandle(workflowLedgerDir);
  try {
    const current = queryCanonicalEInvoiceCurrentFromDatabase(store.db);
    const revoked = current.invoices.find((invoice) => invoice.stableInvoiceKey === mapped.stableInvoiceKey);
    assert.equal(revoked?.revision.state, "revoked");
    const fractionalString = current.invoices.find(
      (invoice) => invoice.revision.invoiceNumber === "AA00000003",
    );
    assert.deepEqual(fractionalString?.revision.items[0]?.quantity, {
      coefficient: "5",
      scale: 1,
    });
    const fractionalNumber = current.invoices.find(
      (invoice) => invoice.revision.invoiceNumber === "AA00000004",
    );
    assert.deepEqual(fractionalNumber?.revision.items[0]?.quantity, {
      coefficient: "5",
      scale: 1,
    });
    const incomplete = current.invoices.find((invoice) => invoice.revision.invoiceNumber === "AA00000002");
    assert.equal(incomplete?.revision.items[0]?.completeness, "incomplete");
    assert.equal(incomplete?.revision.items[0]?.amount, null);
  } finally {
    store.close();
  }

  const emptyDir = await mkdtemp(join(tmpdir(), "einvoice-workflow-empty-"));
  try {
    const emptyCommit = await commitCanonicalCapture(
      captureInput([], "einvoice-workflow-empty", "2026-09-10T05:03:00Z"),
      emptyDir,
    );
    assert.equal(emptyCommit.invoiceCount, 0);
    assert.equal(emptyCommit.itemCount, 0);
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }

  const failingDir = await mkdtemp(join(tmpdir(), "einvoice-workflow-failure-"));
  try {
    const missingTotal = {
      ...completeRecord,
      entry: { ...completeRecord.entry, totalAmount: null },
      header: { ...completeRecord.header, totalAmount: null },
    };
    await assert.rejects(
      commitCanonicalCapture(
        captureInput([missingTotal], "einvoice-workflow-missing-total", "2026-09-10T05:04:00Z"),
        failingDir,
      ),
      /canonical persistence failed/u,
      "workflow success must not be reported when canonical admission fails",
    );
    const failedStore = openCanonicalDatabaseHandle(failingDir);
    try {
      assert.equal(queryCanonicalEInvoiceCurrentFromDatabase(failedStore.db).invoices.length, 0);
    } finally {
      failedStore.close();
    }
  } finally {
    await rm(failingDir, { recursive: true, force: true });
  }
} finally {
  await rm(workflowLedgerDir, { recursive: true, force: true });
}
