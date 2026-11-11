import { createHash } from "node:crypto";
import { taipeiInstant } from "../lib/time/timezone.ts";
import type { Frame, Locator, Page, Route } from "playwright";
import { z } from "zod";
import { parseHtmlTableMatrices } from "../lib/tabular-text.ts";
import {
  deriveHncbDomesticDepositAccountNumberEvidence,
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  type HncbDomesticDepositCaptureEvidence,
  type HncbDomesticDepositValidatedEvidence,
} from "../ledger/canonical/hncb-domestic-deposit-admission.ts";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
} from "../ledger/canonical/hncb-human-attestation-contract.ts";
import { HNCB_CREDENTIAL_FIELDS, HNCB_PRODUCTS, HNCB_SOURCE } from "../lib/automation/server/sources/hncb.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import {
  hncbCurrentBalanceSnapshot,
  readHncbCurrentDepositDetailTable,
  readHncbCurrentDepositOverviewTable,
  type ExistingHncbFinancialCapture,
  type HncbCurrentDepositTable,
} from "./hncb-current-deposit-balances.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionSummary,
  ProductCollectOptions,
} from "../lib/automation/product-collection.ts";
import type { CollectionPeriod } from "../lib/automation/collection-period.ts";
import { ifFound, type FrameScope } from "./frame-scope.ts";
import {
  HNCB_NETBANK_ORIGIN,
  HNCB_TRX_DISPATCHER_PATH,
  hncbNetbankSite,
  isHncbTrxDispatcherUrl,
  type HncbNetbankSite,
  type HncbRoute,
} from "./hncb-netbank-site.ts";
import type { ProviderResponseDeclaration } from "./provider-response.ts";
import { collectHncbCreditCards, playwrightHncbCardPages } from "./hncb-credit-card.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import { admitDeposit, stageCanonicalDeposits, type DepositAdmission } from "./canonical-deposit-staging.ts";

const BANK_ENTRY_URL =
  "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private";

const hncbInputSchema = z.object({
  accountFilters: z.array(z.string()).default([]),
});

type HncbVerifiedInput = VerifiedRunInput<typeof HNCB_CREDENTIAL_FIELDS, typeof HNCB_PRODUCTS>;
type HncbCredentials = HncbVerifiedInput["credentials"];
export type HncbWorkflowInput = HncbVerifiedInput & z.infer<typeof hncbInputSchema>;
export type HncbDepositInput = Pick<HncbWorkflowInput, "accountFilters">;
export type HncbDateRange = Readonly<{ startDate: string; endDate: string }>;
type DateParts = {
  year: number;
  month: number;
  day: number;
};

export type HncbDepositAccount = Readonly<{
  label: string;
  value: string;
}>;

type ParsedStatement = {
  account: string;
  accountId: string;
  queryPeriod: string;
  currency: string;
  rows: string[][];
};

export type HncbStatementDownload = ParsedStatement & {
  /** Synthetic source label retained only in in-memory admission evidence. */
  filename: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  sourceResponse?: Readonly<{ status: number; contentType: string }>;
};

const sourceTransactionHeaders = [
  "交易日期",
  "交易時間",
  "帳務日期",
  "幣別",
  "支出金額",
  "存入金額",
  "即時餘額",
  "摘要",
  "存款人代號",
  "備註",
  "補摺日期/票據號碼",
];

function textFromHncbHtml(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&#8203;|\u200b/g, "")
    .replace(/&nbsp;|\u00a0|\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoStatementDataText(
  value: string | null | undefined,
): boolean {
  return /查\s*無\s*資\s*料|無\s*資\s*料|無\s*交\s*易|查\s*無\s*符\s*合/u.test(
    textFromHncbHtml(value),
  );
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseDateString(value: string): DateParts {
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}`);

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (
    date.getFullYear() !== parts.year ||
    date.getMonth() !== parts.month - 1 ||
    date.getDate() !== parts.day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parts;
}

/** HNCB's YYYY/MM/DD form of a collection period. */
function hncbDateRange({ start, end }: CollectionPeriod): HncbDateRange {
  return { startDate: start.replaceAll("-", "/"), endDate: end.replaceAll("-", "/") };
}

function rocYearValue(year: number): string {
  return String(year - 1911).padStart(4, "0");
}

function metadataValue(rows: string[][], label: string): string {
  for (const row of rows) {
    for (let index = 0; index < row.length - 1; index += 1) {
      if (textFromHncbHtml(row[index]) === label) return textFromHncbHtml(row[index + 1]);
    }
  }
  return "";
}

function workbookSheetsFromHtml(content: string): string[][][] {
  return parseHtmlTableMatrices(content).map((rows) =>
    rows.map((row) => row.map((cell) => textFromHncbHtml(cell))),
  );
}

function findTransactionSheet(sheets: string[][][]): string[][] {
  for (const rows of sheets) {
    if (
      rows.some(
        (row) =>
          textFromHncbHtml(row[0]).startsWith("交易日期") &&
          row.some((cell) => textFromHncbHtml(cell) === "交易時間"),
      )
    ) {
      return rows;
    }
  }
  throw new Error("Downloaded HNCB statement is missing a transaction table.");
}

function findTransactionHeaderIndex(rows: string[][]): number {
  const index = rows.findIndex(
    (row) =>
      textFromHncbHtml(row[0]).startsWith("交易日期") &&
      row.some((cell) => textFromHncbHtml(cell) === "交易時間"),
  );
  if (index === -1) {
    throw new Error("Downloaded HNCB transaction table is missing headers.");
  }
  return index;
}

function normalizeHncbTransactionDate(value: string): string {
  const match = value.match(/^(\d{4})(\/\d{2}\/\d{2})$/);
  if (!match) return value;
  const year = Number(match[1]);
  return `${match[1].startsWith("0") ? year + 1911 : year}${match[2]}`;
}

export function normalizeHncbTransactionRows(rows: string[][]): string[][] {
  const headerIndex = findTransactionHeaderIndex(rows);
  return rows
    .slice(headerIndex + 1)
    .map((row) =>
      sourceTransactionHeaders.map((_, index) => textFromHncbHtml(row[index])),
    )
    .map((row) =>
      row.map((value, index) =>
        index === 0 || index === 2
          ? normalizeHncbTransactionDate(value)
          : value,
      ),
    )
    .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));
}

export function parseStatementExport(
  content: string,
  fallbackAccount: string,
): ParsedStatement {
  const sheets = workbookSheetsFromHtml(content);
  const metadataSheets = sheets.filter((rows) =>
    metadataValue(rows, "資料起訖日") && metadataValue(rows, "幣別")
  );
  if (metadataSheets.length > 1)
    throw new Error("HNCB export workbook has ambiguous metadata tables.");
  const metadataRows = metadataSheets[0] ?? [];
  const transactionRows = findTransactionSheet(sheets);
  const account = metadataValue(metadataRows, "帳號") || fallbackAccount;

  return {
    account,
    accountId: digitsOnly(account) || safeFilename(fallbackAccount),
    queryPeriod: metadataValue(metadataRows, "資料起訖日"),
    currency: metadataValue(metadataRows, "幣別"),
    rows: normalizeHncbTransactionRows(transactionRows),
  };
}

function matchesAccountFilter(
  account: HncbDepositAccount,
  filters: readonly string[],
): boolean {
  if (filters.length === 0) return true;
  const label = account.label.toLowerCase();
  const value = account.value.toLowerCase();
  const accountDigits = digitsOnly(`${account.label} ${account.value}`);

  return filters.some((filter) => {
    const normalized = filter.toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      label.includes(normalized) ||
      value.includes(normalized) ||
      (filterDigits.length > 0 && accountDigits.endsWith(filterDigits))
    );
  });
}

async function isSignedIn(scope: FrameScope): Promise<boolean> {
  const found = await ifFound(scope.scopeWith(
    (candidate) => candidate.locator('a[href*="Logout"]').filter({ hasText: "登出" }),
    "the HNCB logout link",
    { timeoutMs: 3_000 },
  ));
  return found !== null;
}

function normalizedPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

/**
 * Libretto preloads a workflow's `startUrl`. Query strings and fragments can
 * differ across bank shells, but a different origin or normalized path is a
 * different login document and must be opened explicitly.
 */
export function isHncbLoginEntryUrl(url: string): boolean {
  try {
    const expected = new URL(BANK_ENTRY_URL);
    const actual = new URL(url);
    return (
      actual.origin === expected.origin &&
      normalizedPathname(actual.pathname) ===
        normalizedPathname(expected.pathname)
    );
  } catch {
    return false;
  }
}

async function fillLoginForm(
  scope: FrameScope,
  credentials: HncbCredentials,
): Promise<void> {
  const { page } = scope;
  if (!isHncbLoginEntryUrl(page.url()))
    await scope.withSignal((signal) => page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded", signal }));
  await scope.withSignal((signal) => page.locator("#USERIDTEXT").fill(credentials.hncb_user_id, { signal }));
  await scope.withSignal((signal) => page.locator("#NICKNAME").fill(credentials.hncb_account, { signal }));
  await scope.withSignal((signal) => page.locator("#password").fill(credentials.hncb_password, { signal }));
  await scope.withSignal((signal) => page.locator("#TrxCaptchaKey").focus({ signal }));
}

export function hncbCaptchaAssistanceStage(
  page: Page,
): VerificationStage {
  return {
    stageId: "hncb-login-captcha",
    title: "Enter the HNCB CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "hncb.login.captcha-input",
        modes: ["click", "type"],
        locator: page.locator("#TrxCaptchaKey"),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "hncb.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-word",
    solverConfidenceThreshold: 0.8,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "hncb.login.captcha-image",
      locator: page.locator("#code_Cap"),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

export function hncbSignInPlan(credentials: HncbCredentials): FormPlan {
  return {
    signedIn: isSignedIn,
    fill: (scope) => fillLoginForm(scope, credentials),
    captcha: {
      stage: hncbCaptchaAssistanceStage,
      answer: (page) => page.locator("#TrxCaptchaKey"),
    },
    submit: async (scope) => {
      const accountField = scope.page.locator("#NICKNAME");
      if (!(await scope.withSignal((signal) => accountField.inputValue({ signal }))).trim())
        await scope.withSignal((signal) => accountField.fill(credentials.hncb_account, { signal }));
      await scope.withSignal((signal) => scope.page.locator("li#WannaLogin a").click({ signal }));
    },
    dialogs: "dismiss",
    session: isSignedIn,
  };
}

const STATEMENT_DETAIL_LINK = 'a[href*="trx=com.lb.wibc.trx.InqMain"][href*="acct="]';

/** 帳戶總覽, which lists each account's statement detail link. */
const ACCOUNT_OVERVIEW: HncbRoute = {
  description: "the HNCB statement detail link",
  via: { trx: "com.lb.wibc.trx.AcctInfoInq", state: "prompt" },
  ready: async (scope) => (await scope.locator(STATEMENT_DETAIL_LINK).count().catch(() => 0)) > 0,
};

async function openFirstStatementDetail(site: HncbNetbankSite): Promise<Frame> {
  await site.open(ACCOUNT_OVERVIEW);
  const mainFrame = await site.main();
  await site.frames.withSignal((signal) => mainFrame.locator(STATEMENT_DETAIL_LINK).first().click({ signal }));
  await site.settle();
  return await waitForStatementForm(site);
}

function querySubmitLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator('a[href="javascript:doSubmit()"]')
    .or(mainFrame.locator("a[href=\"javascript:doSubmit('0')\"]"))
    .first();
}

async function waitForStatementForm(
  site: HncbNetbankSite,
  timeoutMs = 60_000,
): Promise<Frame> {
  const mainFrame = await site.main();
  const attached = async (locator: Locator) => (await locator.count().catch(() => 0)) > 0;
  await site.frames.until(
    async () => await attached(mainFrame.locator('select[name="acct1"], #acct1').first()) &&
      await attached(querySubmitLink(mainFrame)),
    "Could not find the HNCB account selector and statement query link.",
    { timeoutMs },
  );
  return mainFrame;
}

/** The statement form already on the page, or the first account's form when it does not appear within 5 s. */
export async function ensureHncbStatementForm(
  site: HncbNetbankSite,
  waitForForm: (
    site: HncbNetbankSite,
    timeoutMs?: number,
  ) => Promise<Frame> = waitForStatementForm,
  reopenForm: (site: HncbNetbankSite) => Promise<Frame> = openFirstStatementDetail,
): Promise<Frame> {
  return (await ifFound(waitForForm(site, 5_000))) ?? await reopenForm(site);
}

export async function prepareHncbStatementQueryForm(
  mainFrame: Frame,
): Promise<void> {
  await mainFrame
    .locator('form[name="form1"]')
    .first()
    .evaluate((element) => {
      const form = element as HTMLFormElement;
      form.target = "_self";
      const excelDownload = form.elements.namedItem("excel_download");
      if (excelDownload instanceof HTMLInputElement) {
        excelDownload.value = "";
      }
    });
}

function statementDownloadLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator(
      'a[href*="doSubmit"][href*="5"], input[onclick*="doSubmit"][onclick*="5"]',
    )
    .first();
}

async function hasNoStatementData(mainFrame: Frame): Promise<boolean> {
  const text = await mainFrame
    .locator("body")
    .innerText({ timeout: 500 })
    .catch(() => "");
  return isNoStatementDataText(text);
}

/** The result frame once it offers the export, or null when HNCB answers with no data. */
async function waitForStatementResult(site: HncbNetbankSite): Promise<Frame | null> {
  const mainFrame = await site.main();
  const result = await site.frames.until(async () => {
    if ((await statementDownloadLink(mainFrame).count().catch(() => 0)) > 0)
      return { frame: mainFrame };
    if (await hasNoStatementData(mainFrame)) return { frame: null };
    return null;
  }, "Timed out waiting for HNCB statement result.", { timeoutMs: 60_000 });
  return result.frame;
}

async function readAccountOptions(
  mainFrame: Frame,
  filters: readonly string[],
): Promise<HncbDepositAccount[]> {
  const options = mainFrame.locator("#acct1 option");
  const count = await options.count();
  const accounts: HncbDepositAccount[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const label = textFromHncbHtml(await option.textContent());
    const value = textFromHncbHtml(await option.getAttribute("value")) || label;
    if (!label || !value) continue;
    const account = { label, value };
    if (matchesAccountFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No HNCB accounts matched the input filters.");
  }
  return accounts;
}

async function selectDate(
  scope: FrameScope,
  mainFrame: Frame,
  prefix: "S" | "E",
  date: DateParts,
) {
  const select = (field: string, value: string) => scope.withSignal((signal) =>
    mainFrame.locator(`select[name="${prefix}_${field}"]`).selectOption(value, { signal }));
  await select("Year", rocYearValue(date.year));
  await select("Month", String(date.month));
  await select("Date", String(date.day));
}

async function queryAccountStatements(
  site: HncbNetbankSite,
  account: HncbDepositAccount,
  dateRange: HncbDateRange,
): Promise<Frame | null> {
  const { frames } = site;
  const mainFrame = await ensureHncbStatementForm(site);
  await frames.race(prepareHncbStatementQueryForm(mainFrame));
  await frames.withSignal((signal) => mainFrame.locator("#acct1").selectOption(account.value, { signal }));
  await frames.withSignal((signal) => mainFrame.locator('input[name="inqtype"][value="3"]').check({
    force: true,
    signal,
  }));
  await selectDate(frames, mainFrame, "S", parseDateString(dateRange.startDate));
  await selectDate(frames, mainFrame, "E", parseDateString(dateRange.endDate));
  // The result probe cannot tell the previous account's page from the new one,
  // so it starts once the main frame has loaded the query's reply, when it does.
  await site.submit(querySubmitLink(mainFrame));
  await site.settle();
  return await waitForStatementResult(site);
}

/** HNCB's statement export reply: a Big5 workbook attachment from the TrxDispatcher. */
const HNCB_EXPORT_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "HNCB export",
  host: new URL(HNCB_NETBANK_ORIGIN).hostname,
  endpoints: [{
    path: HNCB_TRX_DISPATCHER_PATH,
    method: "POST",
    contentType:
      /^(?:application\/vnd\.ms-excel|application\/x-excel|application\/xls|application\/octet-stream|text\/html)\s*(?:;|$)/iu,
    // The export form's query was never captured from a live run, so any query is accepted.
    search: /^(?:\?.*)?$/u,
    charset: { decode: "big5", labels: ["cp950", "windows-950"] },
    attachment: true,
  }],
  cacheControl: [],
  providerDate: "optional",
  maxBytes: 64 * 1024 * 1024,
};

/** Parse one accepted export reply, its raw bytes and its Big5-decoded text, as HNCB's statement workbook. */
function parseHncbExport(bytes: Uint8Array, text: string, fallbackAccount: string): ParsedStatement {
  if (bytes.byteLength === 0)
    throw new Error("HNCB export response is empty.");
  const parsed = parseStatementExport(text, fallbackAccount);
  if (!parsed.queryPeriod || !parsed.currency)
    throw new Error("HNCB export workbook is incomplete.");
  return parsed;
}

/**
 * Capture HNCB's export response through Playwright routing so Chromium never
 * creates its managed download artifact. The paused browser request is fetched
 * exactly once with the page's cookies, decoded from the returned bytes, then
 * fulfilled with an empty response so attachment handling cannot write a file.
 * The product's reader checks the reply's transport before its body and
 * accepts it; the popup and the fetch are waits outside it.
 */
export async function downloadCurrentStatementInMemory(
  scope: FrameScope,
  fallbackAccount: string,
  resultFrame: Frame,
  product: Pick<ProductCollectionHandle, "reader" | "validate">,
  timeoutMs = 60_000,
): Promise<HncbStatementDownload> {
  const { page, signal } = scope;
  const { reader, validate } = product;
  const popupPromise = scope.withSignal((signal) => page.waitForEvent("popup", { timeout: 30_000, signal }));
  void popupPromise.catch(() => undefined);
  await scope.withSignal((signal) => statementDownloadLink(resultFrame).click({ signal }));
  const popup = await popupPromise;
  let intercepted = false;
  let resolveCapture!: (statement: HncbStatementDownload) => void;
  let rejectCapture!: (error: Error) => void;
  const capturePromise = new Promise<HncbStatementDownload>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  void capturePromise.catch(() => undefined);
  const captureError = (error: unknown): Error =>
    error instanceof Error ? error : new Error("HNCB export response could not be read.");
  const handleRoute = async (route: Route): Promise<void> => {
    const request = route.request();
    if (!isHncbTrxDispatcherUrl(request.url())) {
      await route.continue();
      return;
    }
    if (request.method() !== "POST") {
      const error = new Error("HNCB export did not use the expected POST request.");
      rejectCapture(error);
      await route.abort("failed").catch(() => undefined);
      return;
    }
    if (intercepted) {
      const error = new Error("HNCB export submitted more than once.");
      rejectCapture(error);
      await route.abort("failed").catch(() => undefined);
      return;
    }
    intercepted = true;
    try {
      const fetched = await route.fetch();
      const acquired = await reader.acquireFrom(scope, HNCB_EXPORT_RESPONSE, { reply: fetched, method: request.method() }, "text");
      const { response, evidence } = await reader.accept(HNCB_EXPORT_RESPONSE, acquired);
      const { bytes } = acquired.evidence;
      const parsed = await validate(() => parseHncbExport(bytes, evidence.text, fallbackAccount));
      await route.fulfill({ status: 204, body: "" });
      resolveCapture({
        ...parsed,
        filename: "hncb-domestic-deposit-export.xls",
        byteLength: bytes.byteLength,
        contentDigest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
        sourceResponse: { status: acquired.response.status, contentType: response.contentType },
      });
    } catch (error) {
      const failure = captureError(error);
      rejectCapture(failure);
      await route.abort("failed").catch(() => undefined);
    }
  };

  let settled = false;
  try {
    // Include setup and doSubmit() in the deadline: a native dialog or
    // stalled renderer can leave evaluate pending before response capture.
    const collection = (async () => {
      await popup
        .waitForLoadState("domcontentloaded", { timeout: 10_000, signal })
        .catch(() => signal.throwIfAborted());
      await popup.route("**/*", handleRoute);
      await popup.evaluate(() => {
        const popupWindow = window as typeof window & { doSubmit?: () => void };
        if (typeof popupWindow.doSubmit !== "function")
          throw new Error("HNCB export popup did not expose doSubmit().");
        popupWindow.doSubmit();
      });
      return await capturePromise;
    })().finally(() => {
      settled = true;
    });
    const deadline = scope.until(async () => settled, "Timed out waiting for the HNCB export response.", { timeoutMs });
    deadline.catch(() => undefined);
    return await scope.race(Promise.race([collection, deadline.then(() => collection)]));
  } finally {
    settled = true;
    await popup.unroute("**/*", handleRoute).catch(() => undefined);
    await popup.close().catch(() => undefined);
  }
}

function emptyDownloadDigest(): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("base64url")}`;
}

export function buildHncbCapture(
  account: HncbDepositAccount,
  dateRange: HncbDateRange,
  observedAt: string,
  statement?: HncbStatementDownload,
): HncbDomesticDepositCaptureEvidence {
  const noData = statement === undefined;
  const accountNumber = deriveHncbDomesticDepositAccountNumberEvidence(
    statement
      ? {
          selectorValue: account.value,
          workbookAccount: statement.account,
        }
      : {
          selectorValue: account.value,
          selectorLabel: account.label,
        },
  );
  return {
    evidenceVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "hncb",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: {
      value: account.value,
      label: account.label,
      ...(accountNumber ? { accountNumber } : {}),
    },
    queryRange: dateRange,
    downloads: [
      {
        filename: statement?.filename ?? "provider-no-data.xls",
        byteLength: statement?.byteLength ?? 0,
        contentDigest: statement?.contentDigest ?? emptyDownloadDigest(),
        columnNames: HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows:
          statement?.rows.map((values, rowOrdinal) => ({
            rowOrdinal,
            values,
          })) ?? [],
        terminal: true,
      },
    ],
    ...(noData
      ? { zeroResultAuthority: "provider-explicit-no-data" as const }
      : {}),
    provenance: {
      source: "hncb-ebank-domestic-deposit-html-workbook",
      encoding: "big5",
      responseBodyRetained: false,
      semantics: "unresolved",
      accountSelector: "select#acct1",
      queryFormSelector: 'form[name="form1"]',
      downloadSelector: 'input[name="excel_download"]',
    },
  };
}

function hncbCaptureId(observedAt: string): string {
  return `hncb-source-${createHash("sha256")
    .update(`hncb-source-capture-v1\0${observedAt}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}`;
}

/** HNCB's statement pages as the deposit read half sees them (ADR 0065). */
export type HncbDepositSource = Readonly<{
  /** The selectable accounts that match the filters; throws when none does. */
  accounts(filters: readonly string[]): Promise<readonly HncbDepositAccount[]>;
  /**
   * One account's statement query; null when HNCB answers with explicit no
   * data. Its download reads the export reply through the product's reader.
   */
  query(
    account: HncbDepositAccount,
    dateRange: HncbDateRange,
  ): Promise<Readonly<{
    download(product: Pick<ProductCollectionHandle, "reader" | "validate">): Promise<HncbStatementDownload>;
  }> | null>;
}>;

export type HncbDepositSourceSnapshot = Readonly<{
  observedAt: string;
  /** One structurally admitted capture per account, in HNCB's account order. */
  captures: readonly HncbDomesticDepositValidatedEvidence[];
}>;

/** Open one current-state table; the snapshot module decodes and parses it. */
export type HncbReadCurrentDepositBalanceTable = () => Promise<HncbCurrentDepositTable>;

type HncbDepositContext = Pick<WorkflowContext, "signal" | "text" | "now">;

/** The deposit product runner; checks replace it to drive the read half against a fake source. */
export type HncbDepositRunner = (
  page: Page,
  input: HncbDepositInput,
  context: HncbDepositContext,
  product: ProductCollectionHandle,
) => Promise<ProductCollectionSummary>;

function hncbDepositSource(site: HncbNetbankSite): HncbDepositSource {
  return {
    accounts: async (filters) =>
      await site.frames.race(readAccountOptions(await openFirstStatementDetail(site), filters)),
    query: async (account, dateRange) => {
      const resultFrame = await queryAccountStatements(site, account, dateRange);
      return resultFrame && {
        download: (product) => downloadCurrentStatementInMemory(
          site.frames,
          account.label,
          resultFrame,
          product,
        ),
      };
    },
  };
}

/**
 * Read the account overview first; it is authoritative when it yields rows.
 * The current-balance page is the fallback for older sessions and for an
 * overview without rows.
 */
export function hncbCurrentDepositBalanceTable(
  readOverview: HncbReadCurrentDepositBalanceTable,
  readDetail: HncbReadCurrentDepositBalanceTable,
): HncbReadCurrentDepositBalanceTable {
  return async () => {
    const overview = await readOverview();
    return overview.evidence.rows.length > 0 ? overview : await readDetail();
  };
}

/**
 * Read every listed account to a terminal export or explicit no-data result
 * and admit each capture's structure as it is read (ADR 0065).
 */
export async function readHncbDepositSource(
  source: HncbDepositSource,
  input: HncbDepositInput,
  context: Pick<WorkflowContext, "signal" | "now">,
  product: ProductCollectionHandle,
): Promise<HncbDepositSourceSnapshot> {
  const dateRange = hncbDateRange(product.collectionPeriod());
  const observedAt = taipeiInstant(context.now());
  const captures: HncbDomesticDepositValidatedEvidence[] = [];
  const admit = async (account: HncbDepositAccount, statement?: HncbStatementDownload) => {
    captures.push(await product.validate(() => {
      const structural = admitHncbDomesticDepositCaptureEvidence(
        buildHncbCapture(account, dateRange, observedAt, statement),
      );
      if (structural.status !== "admissible" || !structural.capture)
        throw new Error(
          `HNCB domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
        );
      return structural.capture;
    }));
  };

  const accounts = await source.accounts(input.accountFilters);
  await product.event("collection", "started", "collection-started", {
    completed: 0,
    total: accounts.length,
  });
  for (const [accountIndex, account] of accounts.entries()) {
    context.signal.throwIfAborted();
    const result = await source.query(account, dateRange);
    if (!result) {
      await product.event("collection", "advanced", "account-no-data", {
        completed: accountIndex + 1,
        total: accounts.length,
      });
      await admit(account);
      await product.event("validation", "advanced", "source-validation-completed", {
        completed: accountIndex + 1,
        total: accounts.length,
      });
      continue;
    }
    await product.event("decoding", "started", "source-decoding-started", {
      completed: accountIndex,
      total: accounts.length,
    });
    const statement = await result.download(product);
    context.signal.throwIfAborted();
    await product.event("decoding", "advanced", "source-decoding-completed", {
      completed: accountIndex + 1,
      total: accounts.length,
    });
    await admit(account, statement);
    await product.event("validation", "advanced", "source-validation-completed", {
      completed: accountIndex + 1,
      total: accounts.length,
    });
  }
  return { observedAt, captures };
}

/**
 * Admit each read capture as financial data or a source assertion, read
 * current balances when at least one capture was admitted, and stage every
 * item before the deposit's single commit boundary.
 */
export async function stageHncbDeposit(
  snapshot: HncbDepositSourceSnapshot,
  product: ProductCollectionHandle,
  readCurrentBalanceTable: HncbReadCurrentDepositBalanceTable,
): Promise<ProductCollectionSummary> {
  const { captures } = snapshot;
  if (captures.length === 0)
    throw new Error("No HNCB accounts reached a terminal source result.");
  const captureId = hncbCaptureId(snapshot.observedAt);
  const admissions: DepositAdmission<ExistingHncbFinancialCapture>[] = [];
  for (const [index, capture] of captures.entries()) {
    admissions.push(await admitDeposit<ExistingHncbFinancialCapture>(product, () => {
      const verdict = admitHncbDomesticDepositFinancialCapture({
        capture,
        captureId: `hncb-financial-${captureId}-${index}`,
        sourceCaptureId: `hncb-source-${captureId}-${index}`,
        humanAttestation: HNCB_HUMAN_ATTESTED_V1_MANIFEST,
      });
      return verdict.sourceOnly
        ? { ...verdict, product: "domestic-deposit" }
        : { ...verdict, product: "domestic-deposit", balance: verdict.capture };
    }));
  }
  await stageCanonicalDeposits(product, admissions, {
    snapshot: hncbCurrentBalanceSnapshot,
    acquire: readCurrentBalanceTable,
  });
  return {
    counts: { accountCount: captures.length },
    sourceCaptureCount: captures.length,
    rowCount: captures.reduce((total, capture) => total + capture.downloads.reduce((sum, download) => sum + download.rows.length, 0), 0),
  };
}

/** The deposit runner over the run's one HNCB site, shared with the attached card. */
function hncbDepositRunner(site: HncbNetbankSite): HncbDepositRunner {
  return async (_page, input, context, product) => {
    return await stageHncbDeposit(
      await readHncbDepositSource(hncbDepositSource(site), input, context, product),
      product,
      hncbCurrentDepositBalanceTable(
        () => readHncbCurrentDepositOverviewTable(site, product.reader),
        () => readHncbCurrentDepositDetailTable(site, product.reader),
      ),
    );
  };
}

export type HncbStatementsContext = Pick<WorkflowContextWith<"products">, "signal" | "text" | "now" | "products">;

/** The deposit runner, and the session check and Attached Preview Product collectors from sign-in. */
export type HncbStatementsRun = ProductCollectOptions & Readonly<{
  collectDeposit: HncbDepositRunner;
}>;

/**
 * Run one authenticated HNCB collection: the deposit, when selected, then the
 * selected Attached Preview Products. Every visible account reaches a terminal
 * export or explicit provider no-data result before the deposit's single
 * commit boundary is crossed.
 */
export async function runHncbStatements(
  page: Page,
  input: HncbDepositInput,
  context: HncbStatementsContext,
  run: HncbStatementsRun,
): Promise<WorkflowRunResult> {
  const { collectDeposit, ...collectOptions } = run;
  const summary = await context.products.collect({
    deposit: (product) => collectDeposit(page, input, context, product),
  }, collectOptions);
  return productRunResult(summary);
}

/** App-owned entry point for the HNCB domestic-deposit statement workflow. */
export const hncbWorkflow: VerifiedWorkflowEntry<
  "financialCommit" | "products",
  HncbWorkflowInput,
  WorkflowRunResult,
  "previewWrite",
  HncbVerifiedInput
> = {
  parseInput(verified, raw) {
    const parsed = hncbInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("HNCB workflow input is invalid.");
    return { ...verified, ...parsed.data };
  },
  run: runHncbWorkflow,
};

async function runHncbWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  input: HncbWorkflowInput,
): Promise<WorkflowRunResult> {
  return await context.browser.withPage(async (page) => {
    const { assertSession } = await signIn(context, page, HNCB_SOURCE, hncbSignInPlan(input.credentials));
    const site = hncbNetbankSite(page, context);
    return await runHncbStatements(page, input, context, {
      collectDeposit: hncbDepositRunner(site),
      ...(assertSession ? { assertSession } : {}),
      attached: {
        collectors: () => ({
          credit_card: ({ reader }) =>
            collectHncbCreditCards(playwrightHncbCardPages(site, reader), { now: context.now(), reader }),
        }),
        ...(assertSession ? { assertSession } : {}),
      },
    });
  });
}
