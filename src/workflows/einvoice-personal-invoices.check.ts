import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type { WorkflowContext, WorkflowRunEvent } from "../lib/automation/workflow-executor.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { classifyTypedWorkflowFailure } from "../lib/automation/server/typed-workflow-outcome.ts";
import { emitHumanAssistanceStage } from "./human-assistance.ts";
import {
  buildCanonicalEInvoiceCapture,
  canonicalOccurrence,
  closeInvoiceDetailModal,
  einvoiceCaptchaAssistanceStage,
  mapCanonicalEInvoiceRecord,
  retryEinvoiceLoginNavigation,
  runEinvoiceProviderWorkflow,
  type InvoiceCaptureRecord,
  validatePaginationEnvelope,
  waitForEinvoiceLoginOutcome,
  waitForEinvoiceLoginReady,
  waitForListResponse,
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
  const blockedPage = await browser.newPage();
  blockedPage.setDefaultTimeout(500);
  await blockedPage.route("https://www.einvoice.nat.gov.tw/accounts/login", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "text/html; charset=utf-8",
      body: '<html><body>正在執行安全驗證<input type="hidden" name="cf-turnstile-response"></body></html>',
    });
  });
  const blockedEvents: WorkflowRunEvent[] = [];
  const blockedContext: WorkflowContext = {
    runId: "blocked-login-fixture",
    signal: new AbortController().signal,
    now: () => "2026-09-26T00:00:00.000Z",
    browser: { withPage: (run) => run(blockedPage) },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("unexpected assistance"); } },
    financialCommit: { execute: async () => { throw new Error("unexpected commit"); } },
    event: async (stage, code) => {
      blockedEvents.push({ runId: "blocked-login-fixture", stage, code, occurredAt: "2026-09-26T00:00:00.000Z" });
    },
  };
  let blockedError: unknown;
  try {
    await runEinvoiceProviderWorkflow(blockedContext, {
      credentials: { einvoice_phone_number: "0900000000", einvoice_password: "fixture-only" },
    });
  } catch (error) {
    blockedError = error;
  }
  assert.ok(blockedError);
  assert.ok(blockedEvents.some((event) => event.code === "source-access-challenged"));
  assert.equal(classifyTypedWorkflowFailure(blockedError, blockedEvents), "source-access-challenged");
  await blockedPage.close();

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

  const stalledLoginPage = await browser.newPage();
  await stalledLoginPage.setContent("<div>載入中</div>");
  let stalledLoginError: unknown;
  try {
    await waitForEinvoiceLoginReady(stalledLoginPage, 50);
  } catch (error) {
    stalledLoginError = error;
  }
  assert.equal(
    classifyTypedWorkflowFailure(stalledLoginError, [
      { runId: "stalled-login-fixture", stage: "authentication", code: "authentication-started", occurredAt: "2026-09-26T00:00:00.000Z" },
    ]),
    "authentication-timeout",
  );
  await stalledLoginPage.close();

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
        body: async () => Buffer.from(JSON.stringify(populatedListResponse), "utf8"),
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
const duplicateAcrossPages = buildCanonicalEInvoiceCapture({
  records: [completeRecord, { ...completeRecord, listPageIndex: 1 }],
  pages: [0, 1].map((pageIndex) => ({
    month,
    pageIndex,
    list: {
      httpStatus: 200 as const,
      totalElements: 2,
      totalPages: 2,
      size: 1,
      content: [completeRecord.entry],
    },
  })),
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
