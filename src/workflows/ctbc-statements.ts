import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import { taipeiInstant } from "../lib/time/timezone.ts";
import type { Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitCtbcDomesticDepositCaptureEvidence,
  admitCtbcDomesticDepositFinancialCapture,
  createCtbcDomesticDepositSourceEvidence,
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  deriveCtbcDomesticDepositAccountNumberEvidence,
  type CtbcDomesticDepositCaptureEvidence,
  type CtbcDomesticDepositValidatedEvidence,
} from "../ledger/canonical/ctbc-domestic-deposit-admission.ts";
import {
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
} from "../ledger/canonical/ctbc-human-attestation-contract.ts";
import {
  CTBC_CURRENT_DEPOSIT_BALANCE_HOST,
  CTBC_CURRENT_DEPOSIT_RESPONSE,
  parseCtbcCurrentDepositBalanceSnapshot,
  readCtbcCurrentDepositBalanceResponse,
  type CtbcCurrentDepositBalanceRow,
  type CtbcCurrentDepositResponse,
} from "./ctbc-current-deposit-balances.ts";
import {
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionSummary,
  ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { CTBC_CREDENTIAL_FIELDS, CTBC_PRODUCTS, CTBC_SOURCE } from "../lib/automation/server/sources/ctbc.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import { SourceUnavailableError } from "../lib/automation/source-access.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import {
  captureCurrentStateSnapshots,
  type CurrentBalanceCaptureMatching,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

const LOGIN_URL = "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010";
const DOMESTIC_DETAILS_URL =
  "https://www.ctbcbank.com/twrbc/twrbc-deposit/qu002/010";
const EBMW_RESOURCE_PATH = "/IB/api/adapters/IB_Adapter/resource/ebmwResource";
const NO_DATA_CODE = "9201";

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const ctbcInputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).optional(),
});

type CtbcVerifiedInput = VerifiedRunInput<typeof CTBC_CREDENTIAL_FIELDS, typeof CTBC_PRODUCTS>;
type CtbcCredentials = CtbcVerifiedInput["credentials"];
export type CtbcStatementsInput = CtbcVerifiedInput & z.infer<typeof ctbcInputSchema>;

/** One deposit product run: read the source, then build and stage from it. */
export type CtbcDepositRunner = (
  page: Page,
  input: CtbcStatementsInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
) => Promise<ProductCollectionSummary>;

/** Observe the current-summary response; the snapshot module decodes and parses it. */
export type CtbcReadCurrentDepositBalanceResponse = () => Promise<CtbcCurrentDepositResponse>;

type CtbcResourceResponse<T> = {
  code?: string;
  message?: string;
  msg?: string;
  rsData?: T | null;
};

type CtbcAccount = {
  accountId: string;
  label: string;
  nickname?: string;
  optionIndex?: number;
};

type CtbcRawAccount = {
  accountId?: string;
  accountNickName?: string;
  accountType?: string;
  acctType?: string;
};

type CtbcDateRange = {
  firstDateYYYYMMDD?: string;
  lastDateYYYYMMDD?: string;
  currMonthYYYYMM?: string;
};

type CtbcBootstrapData = {
  accountId?: string;
  accountInfoList?: CtbcRawAccount[];
  dateRanges?: CtbcDateRange[];
};

export type CtbcDetailRow = {
  actDtFull?: string;
  trnDtFull?: string;
  actDtTm?: string;
  sortActDtTm?: string;
  memo1?: string;
  memo2?: string;
  passBookMemo?: string;
  dbAmt?: string;
  dbAmtDisplay?: string;
  crAmt?: string;
  crAmtDisplay?: string;
  balanceAmt?: string;
};

type CtbcDetailData = {
  detailList?: CtbcDetailRow[];
  nextKey?: string;
};

type CtbcResourceCapture<T> = {
  body: CtbcResourceResponse<T>;
};

export type CtbcResponseShapeEvidence = {
  hasRsData: boolean;
  rsDataKind: "object" | "null" | "other";
  hasDetailList: boolean;
  detailListIsArray: boolean;
  detailListRowCount: number | null;
  nextKeyPresent: boolean;
};

export type CtbcObservedRangeResponse = {
  rangeOrdinal: number;
  startDate: string;
  endDate: string;
  code: "0000" | "9201";
  nextKey: string | null;
  terminal: boolean;
  rows: CtbcStatementRow[];
  responseShape: CtbcResponseShapeEvidence;
};

export type CtbcObservedAccountCapture = {
  accountId: string;
  queryPeriods: string[];
  expectedRangeCount: number;
  responses: CtbcObservedRangeResponse[];
};

/** What the domestic-details page returned for every selected account. */
export type CtbcDepositSourceSnapshot = {
  output: Readonly<{ count: number; rowCount: number }>;
  captures: CtbcObservedAccountCapture[];
};

type ExistingCtbcFinancialCapture = Readonly<{
  authorityRoute: string;
  identity: Readonly<{
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    stream: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
    currency: string | null;
  }>;
}>;

export type CtbcStatementRow = {
  accountingDate: string;
  transactionDate: string;
  values: string[];
};


/** Decode provider JSON through the injected strict text port before use. */
export function decodeCtbcSourceJson<T>(
  bytes: Uint8Array,
  text: SourceTextPort,
): T {
  const decoded = text.decode(bytes, "utf-8");
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("CTBC provider response is not valid JSON.");
  }
  // JSON may encode U+FFFD as an escape, so check the parsed source fields too.
  text.assertIntact(JSON.stringify(value));
  return value as T;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function amountText(
  displayValue: string | undefined,
  rawValue: string | undefined,
) {
  return cleanText(displayValue) || cleanText(rawValue);
}

function slashDate(value: string | undefined): string {
  const clean = cleanText(value);
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(clean)) return clean;
  if (/^\d{8}$/.test(clean)) {
    return `${clean.slice(0, 4)}/${clean.slice(4, 6)}/${clean.slice(6, 8)}`;
  }
  return clean;
}

function dateKey(value: string): string {
  return digitsOnly(value).slice(0, 8);
}

function timeFromDetail(detail: CtbcDetailRow): string {
  const actDtTm = cleanText(detail.actDtTm);
  const dotted = actDtTm.match(/\d{4}-\d{2}-\d{2}-(\d{2})\.(\d{2})\.(\d{2})/);
  if (dotted) return `${dotted[1]}:${dotted[2]}:${dotted[3]}`;

  const sortActDtTm = cleanText(detail.sortActDtTm);
  const clock = sortActDtTm.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  return clock?.[1] ?? "";
}

function noteForDetail(detail: CtbcDetailRow): string {
  const parts = [
    cleanText(detail.passBookMemo),
    cleanText(detail.memo2),
  ].filter(Boolean);
  return [...new Set(parts)].join(" ");
}

export function ctbcDetailRowsToStatementRows(
  details: CtbcDetailRow[],
): CtbcStatementRow[] {
  return details.map((detail) => {
    const accountingDate = slashDate(detail.actDtFull);
    const transactionDate = slashDate(detail.trnDtFull);
    const row = [
      accountingDate,
      transactionDate,
      timeFromDetail(detail),
      cleanText(detail.memo1),
      amountText(detail.dbAmtDisplay, detail.dbAmt),
      amountText(detail.crAmtDisplay, detail.crAmt),
      cleanText(detail.balanceAmt),
      noteForDetail(detail),
    ];

    return {
      accountingDate,
      transactionDate,
      values: row,
    };
  });
}

function rowWithinDateRange(
  row: CtbcStatementRow,
  input: CtbcStatementsInput,
): boolean {
  const key = dateKey(row.accountingDate || row.transactionDate);
  if (!key) return true;
  if (input.startDate && key < dateKey(input.startDate)) return false;
  if (input.endDate && key > dateKey(input.endDate)) return false;
  return true;
}

async function isSignedIn(scope: FrameScope): Promise<boolean> {
  return await scope.race(scope.page
    .locator("#btnHeaderLogout")
    .isVisible()
    .catch(() => false));
}

async function waitForLoginForm(scope: FrameScope, initialHttpStatus?: number): Promise<void> {
  const { page } = scope;
  const firstField = page.locator("form input[type=text]").first();
  const unavailable = page.getByText(/系統忙碌中，請稍後再試/u).first();
  const startedAt = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    scope.signal.throwIfAborted();
    if (await scope.race(unavailable.isVisible().catch(() => false))) {
      throw new SourceUnavailableError();
    }
    if (await scope.race(firstField.isVisible().catch(() => false))) break;
    if (initialHttpStatus === 202 && Date.now() - startedAt >= 1_000) {
      throw new SourceUnavailableError();
    }
    await scope.pause(200);
  }
  await scope.withSignal((signal) => firstField.waitFor({
    state: "visible",
    timeout: Math.max(1, deadline - Date.now()),
    signal,
  }));
  await scope.withSignal((signal) => page.locator("form input[type=password]").nth(1).waitFor({
    state: "visible",
    timeout: 60_000,
    signal,
  }));
  await scope.withSignal((signal) => page.getByRole("button", { name: "登入" }).waitFor({
    state: "visible",
    timeout: 60_000,
    signal,
  }));
  await scope.pause(1_000);
}

async function openCtbcLoginForm(scope: FrameScope): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await scope.withSignal((signal) =>
      scope.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", signal }));
    try {
      await waitForLoginForm(scope, response?.status());
      return;
    } catch (error) {
      if (!(error instanceof SourceUnavailableError) || attempt === 2) throw error;
      await scope.pause(1_000);
    }
  }
}

async function handleCtbcPasswordReminder(scope: FrameScope): Promise<boolean> {
  const { page } = scope;
  const reminder = page.getByText("密碼變更提醒", { exact: true });
  if (!await scope.race(reminder.isVisible().catch(() => false))) return false;
  await scope.withSignal((signal) => page.getByText("下次再提醒", { exact: true }).click({ signal }));
  await scope.pause(1_000);
  return true;
}

async function fillCtbcLoginForm(scope: FrameScope, credentials: CtbcCredentials): Promise<void> {
  await openCtbcLoginForm(scope);
  const { page } = scope;
  await scope.withSignal((signal) =>
    page.locator("form input[type=text]").first().fill(credentials.ctbc_user_id, { signal }));
  const passwordFields = page.locator("form input[type=password]");
  await scope.withSignal((signal) => passwordFields.nth(0).fill(credentials.ctbc_account, { signal }));
  await scope.withSignal((signal) => passwordFields.nth(1).fill(credentials.ctbc_password, { signal }));
}

export function ctbcSignInPlan(credentials: CtbcCredentials): FormPlan {
  return {
    signedIn: isSignedIn,
    fill: (scope) => fillCtbcLoginForm(scope, credentials),
    submit: (scope) => scope.withSignal((signal) => scope.page.getByRole("button", { name: "登入" }).click({ signal })),
    prompts: handleCtbcPasswordReminder,
    dialogs: "accept-for-page",
    session: { none: "needs live verification" },
    timeoutMs: 180_000,
  };
}

function requireCtbcOk<T>(
  response: CtbcResourceResponse<T>,
  resource: string,
): void {
  if (response.code === "0000") return;
  const code = response.code ?? "unknown";
  throw new Error(`CTBC resource ${resource} returned ${code}.`);
}

function isCtbcResourceResponse(resource: string) {
  return (response: Response): boolean => {
    const request = response.request();
    const postData = request.postData() ?? "";
    return (
      request.method() === "POST" &&
      response.url().includes(EBMW_RESOURCE_PATH) &&
      postData.includes(`"resource":"${resource}"`)
    );
  };
}

/** How the read half checks each provider reply: decoded by `text`, checked inside `validate`. */
type CtbcReplyCheck = Readonly<{
  text: SourceTextPort;
  validate: ProductCollectionHandle["validate"];
}>;

async function nextCtbcResource<T>(
  scope: FrameScope,
  resource: string,
  options: { allowNoData?: boolean; reply: CtbcReplyCheck },
): Promise<CtbcResourceCapture<T>> {
  const response = await scope.withSignal((signal) => scope.page.waitForResponse(
    isCtbcResourceResponse(resource),
    { timeout: 60_000, signal },
  ));
  const bytes = await scope.race(response.body());
  const body = await options.reply.validate(() => {
    const value = decodeCtbcSourceJson<CtbcResourceResponse<T>>(
      bytes,
      options.reply.text,
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("CTBC provider response shape is invalid.");
    return value;
  });
  // A provider error code is the source refusing the read, not a malformed reply.
  if (!(body.code === NO_DATA_CODE && options.allowNoData)) {
    requireCtbcOk(body, resource);
  }
  return { body };
}

function detailsFromCapture(capture: CtbcResourceCapture<CtbcDetailData>) {
  if (capture.body.code === NO_DATA_CODE) return [];
  if (
    !capture.body.rsData ||
    typeof capture.body.rsData !== "object" ||
    !Array.isArray(capture.body.rsData.detailList)
  )
    throw new Error(
      "CTBC successful detail response lacks an explicit detailList array.",
    );
  return capture.body.rsData.detailList;
}

export function ctbcResponseShape(
  body: CtbcResourceResponse<CtbcDetailData>,
): CtbcResponseShapeEvidence {
  const hasRsData = Object.prototype.hasOwnProperty.call(body, "rsData");
  const rsData = body.rsData;
  const rsDataKind =
    rsData === null
      ? ("null" as const)
      : rsData && typeof rsData === "object" && !Array.isArray(rsData)
        ? ("object" as const)
        : ("other" as const);
  const hasDetailList =
    rsDataKind === "object" &&
    Object.prototype.hasOwnProperty.call(rsData, "detailList");
  const detailListIsArray = Array.isArray(rsData?.detailList);
  return {
    hasRsData,
    rsDataKind,
    hasDetailList,
    detailListIsArray,
    detailListRowCount: detailListIsArray ? rsData.detailList!.length : null,
    nextKeyPresent:
      typeof rsData?.nextKey === "string" && rsData.nextKey.trim().length > 0,
  };
}

async function openDomesticDetailsPage(
  scope: FrameScope,
  reply: CtbcReplyCheck,
) {
  const bootstrapPromise = nextCtbcResource<CtbcBootstrapData>(
    scope,
    "/twrbc-deposit/qu002/010",
    { reply },
  );
  const initialDetailsPromise = nextCtbcResource<CtbcDetailData>(
    scope,
    "/twrbc-deposit/qu002/011",
    { allowNoData: true, reply },
  );
  bootstrapPromise.catch(() => undefined);
  initialDetailsPromise.catch(() => undefined);

  await scope.withSignal((signal) => scope.page.goto(DOMESTIC_DETAILS_URL, { waitUntil: "domcontentloaded", signal }));
  const [bootstrap, initialDetails] = await Promise.all([
    bootstrapPromise,
    initialDetailsPromise,
  ]);
  return {
    data: bootstrap.body.rsData ?? {},
    initialCapture: initialDetails,
  };
}

function detailAccountDropdown(page: Page): Locator {
  return page.locator("div.btn.dropdown-toggle").first();
}

function detailAccountOptions(page: Page): Locator {
  return page.locator("a.dropdown-item").filter({ hasText: "帳戶餘額" });
}

function accountFromOptionText(
  text: string,
  optionIndex: number,
): CtbcAccount | null {
  const accountId = text.match(/\d{10,16}/)?.[0] ?? "";
  if (!accountId) return null;
  return {
    accountId,
    optionIndex,
    label: `新臺幣-${accountId}`,
  };
}

async function readDetailAccountOptions(
  scope: FrameScope,
  fallbackAccounts: CtbcAccount[],
): Promise<CtbcAccount[]> {
  const { page } = scope;
  const dropdown = detailAccountDropdown(page);
  if (!(await scope.race(dropdown.isVisible().catch(() => false)))) {
    return resolveCtbcAccountScope([], fallbackAccounts);
  }
  await scope.withSignal((signal) => dropdown.click({ signal }));
  const optionVisible = await scope.withSignal((signal) => detailAccountOptions(page)
    .first()
    .waitFor({ state: "visible", timeout: 10_000, signal }))
    .then(() => true, () => {
      scope.signal.throwIfAborted();
      return false;
    });
  if (!optionVisible) {
    await scope.race(page.keyboard.press("Escape").catch(() => undefined));
    return resolveCtbcAccountScope([], fallbackAccounts);
  }

  const count = await scope.race(detailAccountOptions(page).count());
  const accounts: CtbcAccount[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = cleanText(
      await scope.withSignal((signal) => detailAccountOptions(page).nth(index).textContent({ signal })),
    );
    const account = accountFromOptionText(text, index);
    if (account) accounts.push(account);
  }
  await scope.race(page.keyboard.press("Escape"));

  return resolveCtbcAccountScope(accounts, fallbackAccounts);
}

export function resolveCtbcAccountScope(
  uiAccounts: CtbcAccount[],
  fallbackAccounts: CtbcAccount[],
): CtbcAccount[] {
  if (uiAccounts.length > 0) return uiAccounts;
  if (fallbackAccounts.length <= 1) return fallbackAccounts;
  throw new Error(
    "CTBC account selector did not expose stable options for every account.",
  );
}

async function selectDetailAccount(
  scope: FrameScope,
  account: CtbcAccount,
  reply: CtbcReplyCheck,
) {
  if (account.optionIndex === undefined) {
    throw new Error(`No CTBC page option index for ${account.label}.`);
  }

  await scope.withSignal((signal) => detailAccountDropdown(scope.page).click({ signal }));
  const option = detailAccountOptions(scope.page).nth(account.optionIndex);
  await scope.withSignal((signal) => option.waitFor({ state: "visible", timeout: 60_000, signal }));

  const bootstrapPromise = nextCtbcResource<CtbcBootstrapData>(
    scope,
    "/twrbc-deposit/qu002/010",
    { reply },
  );
  const initialDetailsPromise = nextCtbcResource<CtbcDetailData>(
    scope,
    "/twrbc-deposit/qu002/011",
    { allowNoData: true, reply },
  );
  bootstrapPromise.catch(() => undefined);
  initialDetailsPromise.catch(() => undefined);
  await scope.withSignal((signal) => option.click({ signal }));
  const [bootstrap, initialDetails] = await Promise.all([
    bootstrapPromise,
    initialDetailsPromise,
  ]);

  return {
    data: bootstrap.body.rsData ?? {},
    initialCapture: initialDetails,
  };
}

function accountFromRaw(raw: CtbcRawAccount): CtbcAccount | null {
  const accountId = cleanText(raw.accountId);
  if (!accountId) return null;
  const nickname = cleanText(raw.accountNickName);
  return {
    accountId,
    nickname,
    label: nickname ? `新臺幣-${accountId} ${nickname}` : `新臺幣-${accountId}`,
  };
}

function accountsFromBootstrap(data: CtbcBootstrapData): CtbcAccount[] {
  const accounts = (data.accountInfoList ?? [])
    .map(accountFromRaw)
    .filter((account): account is CtbcAccount => account !== null);
  if (accounts.length === 0 && cleanText(data.accountId)) {
    accounts.push({
      accountId: cleanText(data.accountId),
      label: `新臺幣-${cleanText(data.accountId)}`,
    });
  }

  return [
    ...new Map(
      accounts.map((account) => [account.accountId, account]),
    ).values(),
  ];
}

function filterAccounts(
  accounts: CtbcAccount[],
  filters: string[] | undefined,
): CtbcAccount[] {
  const cleanFilters = filters?.map(cleanText).filter(Boolean) ?? [];
  if (cleanFilters.length === 0) return accounts;
  return accounts.filter((account) =>
    cleanFilters.some((filter) =>
      `${account.label} ${account.accountId}`.includes(filter),
    ),
  );
}

function queryPeriodForDateRange(dateRange: CtbcDateRange): string {
  const startDate = slashDate(dateRange.firstDateYYYYMMDD);
  const endDate = slashDate(dateRange.lastDateYYYYMMDD);
  if (startDate && endDate) return `${startDate}~${endDate}`;
  return cleanText(dateRange.currMonthYYYYMM);
}

function queryPeriodsForBootstrap(
  bootstrap: CtbcBootstrapData,
  input: CtbcStatementsInput,
): string[] {
  if (input.startDate || input.endDate) {
    return [`${input.startDate ?? ""}~${input.endDate ?? ""}`];
  }

  return (bootstrap.dateRanges ?? [])
    .map(queryPeriodForDateRange)
    .filter(Boolean);
}

function monthTabs(page: Page): Locator {
  return page.locator("a.nav-link").filter({ hasText: /\d{4}\/\d{2}/ });
}

async function captureVisibleMonthDetails(
  scope: FrameScope,
  initialCapture: CtbcResourceCapture<CtbcDetailData>,
  reply: CtbcReplyCheck,
): Promise<Array<CtbcResourceCapture<CtbcDetailData>>> {
  const tabs = monthTabs(scope.page);
  await scope.withSignal((signal) => tabs.first().waitFor({ state: "visible", timeout: 60_000, signal }));
  const captures = [initialCapture];
  await reply.validate(() => detailsFromCapture(initialCapture));

  const count = await scope.race(tabs.count());
  for (let index = 1; index < count; index += 1) {
    scope.signal.throwIfAborted();
    const detailPromise = nextCtbcResource<CtbcDetailData>(
      scope,
      "/twrbc-deposit/qu002/011",
      { allowNoData: true, reply },
    );
    detailPromise.catch(() => undefined);
    await scope.withSignal((signal) => tabs.nth(index).click({ signal }));
    const capture = await detailPromise;
    await reply.validate(() => detailsFromCapture(capture));
    captures.push(capture);
  }

  return captures;
}

async function accountRowsFromCurrentPage(
  scope: FrameScope,
  account: CtbcAccount,
  bootstrap: CtbcBootstrapData,
  initialCapture: CtbcResourceCapture<CtbcDetailData>,
  input: CtbcStatementsInput,
  reply: CtbcReplyCheck,
): Promise<{
  queryPeriods: string[];
  rows: CtbcStatementRow[];
  responses: CtbcObservedRangeResponse[];
}> {
  const captures = await captureVisibleMonthDetails(scope, initialCapture, reply);
  const ranges = bootstrap.dateRanges ?? [];
  const queryPeriods = queryPeriodsForBootstrap(bootstrap, input);
  const responses = await reply.validate(() => captures.map((capture, rangeOrdinal) => {
    const code = capture.body.code === NO_DATA_CODE ? NO_DATA_CODE : "0000";
    const nextKey = cleanText(capture.body.rsData?.nextKey) || null;
    const range = ranges[rangeOrdinal];
    return {
      rangeOrdinal,
      startDate: slashDate(range?.firstDateYYYYMMDD),
      endDate: slashDate(range?.lastDateYYYYMMDD),
      code,
      nextKey,
      terminal: nextKey === null,
      rows: ctbcDetailRowsToStatementRows(detailsFromCapture(capture)),
      responseShape: ctbcResponseShape(capture.body),
    } satisfies CtbcObservedRangeResponse;
  }));
  const rows = responses
    .flatMap((response) => response.rows)
    .filter((row) => rowWithinDateRange(row, input));
  return {
    queryPeriods,
    rows,
    responses,
  };
}

/** Read every selected account's month responses from the domestic-details page (ADR 0065). */
export async function readCtbcDepositSource(
  page: Page,
  input: CtbcStatementsInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<CtbcDepositSourceSnapshot> {
  const scope = frameScope(page, context.signal);
  const reply: CtbcReplyCheck = { text: context.text, validate: product.validate };
  const opened = await openDomesticDetailsPage(scope, reply);
  const allAccounts = await readDetailAccountOptions(
    scope,
    accountsFromBootstrap(opened.data),
  );
  const accounts = filterAccounts(allAccounts, input.accountFilters);

  if (accounts.length === 0) {
    return {
      output: { count: 0, rowCount: 0 },
      captures: [],
    };
  }

  const captures: CtbcObservedAccountCapture[] = [];
  let currentOptionIndex = 0;
  let rowCount = 0;
  for (const account of accounts) {
    context.signal.throwIfAborted();
    let bootstrap = opened.data;
    let initialCapture = opened.initialCapture;

    if (
      account.optionIndex !== undefined &&
      account.optionIndex !== currentOptionIndex
    ) {
      const selected = await selectDetailAccount(
        scope,
        account,
        reply,
      );
      bootstrap = selected.data;
      initialCapture = selected.initialCapture;
      currentOptionIndex = account.optionIndex;
    }

    const { queryPeriods, rows, responses } = await accountRowsFromCurrentPage(
      scope,
      account,
      bootstrap,
      initialCapture,
      input,
      reply,
    );
    rowCount += rows.length;
    captures.push({
      accountId: account.accountId,
      queryPeriods,
      expectedRangeCount: bootstrap.dateRanges?.length ?? 0,
      responses,
    });
    await context.event("collection", "advanced", "account-collected", {
      completed: captures.length,
      total: accounts.length,
    });
  }

  return {
    output: {
      count: accounts.length,
      rowCount,
    },
    captures,
  };
}

function buildCtbcCapture(
  observed: CtbcObservedAccountCapture,
  observedAt: string,
): CtbcDomesticDepositCaptureEvidence {
  const starts = observed.responses
    .map((response) => response.startDate)
    .sort();
  const ends = observed.responses.map((response) => response.endDate).sort();
  const accountNumber = deriveCtbcDomesticDepositAccountNumberEvidence(
    observed.accountId,
  );
  return {
    evidenceVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "ctbc",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: {
      accountId: observed.accountId,
      ...(accountNumber ? { accountNumber } : {}),
    },
    queryRange: {
      startDate: starts[0] ?? "",
      endDate: ends.at(-1) ?? "",
    },
    responses: observed.responses.map((response) => ({
      rangeOrdinal: response.rangeOrdinal,
      startDate: response.startDate,
      endDate: response.endDate,
      code: response.code,
      nextKey: response.nextKey,
      terminal: response.terminal,
      responseShape: response.responseShape,
      rows: response.rows.map((row, rowOrdinal) => ({
        rowOrdinal,
        values: row.values,
      })),
    })),
    provenance: {
      source: "ctbc-ebmw-qu002-011-natural-response",
      rangeInventorySource: "ctbc-ebmw-qu002-010-dateRanges",
      expectedRangeCount: observed.expectedRangeCount,
      responseBodyRetained: false,
      authority: "personal-main",
    },
  };
}

/**
 * Join the current summary to an already admitted CTBC statement identity.
 * The provider accountId is retained as exact evidence, including leading
 * zeroes; no current-summary row can create a new canonical account.
 */
export function buildCtbcCurrentDepositBalanceCapture(
  row: CtbcCurrentDepositBalanceRow,
  financialCapture: ExistingCtbcFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (
    financialCapture.authorityRoute !== "ctbc/domestic-deposit/human-attested-v1" ||
    identity.integrationNamespace !== "ctbc" ||
    identity.stream !== "domestic-deposit" ||
    identity.currency !== "TWD"
  )
    throw new Error("CTBC current deposit identity is not an admitted TWD CTBC account.");
  if (
    identity.accountNo !== row.accountNumber ||
    sourceAccountKey !== row.sourceAccountKey ||
    identity.accountNumber?.value !== row.accountNumber
  )
    throw new Error(
      "CTBC current deposit accountId does not exactly match existing account evidence.",
    );

  const contractVersion = row.sourceEvidence.contractVersion;
  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const sourceField = "balance";
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-system-time" as const,
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "serverTime",
    sourceValue: String(row.providerServerTime),
    contractVersion,
  };
  const sourceRecordKey = canonicalDigest(
    "ctbc-current-deposit-source-record-v1",
    sourceAccountKey,
    row.effectiveAt,
    balance.coefficient,
    String(balance.scale),
  );
  const compact = {
    source: "ctbc",
    accountId: row.accountNumber,
    sourceAccountKey,
    currency: row.currency,
    sourceLexeme: row.ledger.sourceLexeme,
    providerFields: { ...row.providerFields },
    providerServerTime: row.providerServerTime,
    providerDataTime: row.providerDataTime,
    providerHttpDate: row.providerHttpDate,
    requestResource: row.sourceEvidence.requestResource,
    sourceEvidence: { ...row.sourceEvidence },
  };
  const provisional = currentDepositSourceRecord({
    sourceRecordKey,
    providerKey: canonicalDigest(
      "ctbc-current-deposit-provider-record-v1",
      sourceAccountKey,
      row.effectiveAt,
    ),
    contentHash: "sha256:placeholder",
    sourceField,
    balanceKind: "ledger",
    currency: row.currency,
    value: balance,
    time,
    compact,
  });
  const record: CurrentDepositSourceRecordInput = {
    ...provisional,
    contentHash: currentDepositSourceRecordContentHash(provisional.compact),
  };
  const observation: CurrentDepositBalanceObservationInput = {
    observationKey: canonicalDigest(
      "ctbc-current-deposit-observation-v1",
      sourceAccountKey,
    ),
    balanceKind: "ledger",
    balance,
    currency: row.currency,
    time,
    sourceRecordKey,
    sourceField,
  };
  const scopeDate = row.providerDataTime.slice(0, 10).replaceAll("/", "-");
  const route = "ctbc/domestic-deposit/current-balance-v1";
  return {
    captureId: `ctbc-current-${randomUUID()}`,
    authorityRoute: route,
    contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "ctbc",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: scopeDate,
      endDate: scopeDate,
      contractFingerprint: canonicalDigest("ctbc-current-deposit-contract-v1", route),
      preflightFingerprint: canonicalDigest(
        "ctbc-current-deposit-preflight-v1",
        identity.subjectDigest,
        scopeDate,
      ),
    },
    providerResponse: {
      endpoint: `https://${CTBC_CURRENT_DEPOSIT_BALANCE_HOST}${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
      requestResource: row.sourceEvidence.requestResource,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: {
          source: "ctbc-current-deposit-summary",
          endpoint: row.sourceEvidence.endpoint,
          resource: row.sourceEvidence.requestResource,
          accountId: row.accountNumber,
          providerServerTime: row.providerServerTime,
          providerDataTime: row.providerDataTime,
          providerHttpDate: row.providerHttpDate,
        },
      },
    ],
    records: [record],
    observations: [observation],
  };
}

/**
 * CTBC keys a balance by each capture's own stream and source account key.
 * Every CTBC capture carries one constant source connection and the identity
 * epoch of the run's single human attestation manifest, so captures spanning
 * more than one connection or epoch fail closed before matching. A row with
 * no admitted capture fails the run. The first capture wins.
 */
export const ctbcCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ stream: string; sourceAccountKey: string }>,
  ExistingCtbcFinancialCapture
> = {
  captureKey: ({ identity }) =>
    `${identity.stream}\u0000${identity.sourceAccountKey ?? identity.accountNo}`,
  rowKey: (row) => `${row.stream}\u0000${row.sourceAccountKey}`,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.authorityRoute === candidate.authorityRoute &&
    kept.identity.accountNo === candidate.identity.accountNo &&
    kept.identity.accountNumber?.value === candidate.identity.accountNumber?.value &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest &&
    kept.identity.currency === candidate.identity.currency,
  ambiguousMessage: "CTBC current deposit identities are ambiguous across financial captures.",
  oneScope: {
    scope: ({ identity }) => `${identity.sourceConnectionKey}\u0000${identity.identityEpochKey}`,
    message:
      "CTBC current deposit captures span more than one source connection or identity epoch.",
  },
  unmatched: {
    kind: "throw",
    message: "CTBC current deposit snapshot has no admitted account identity.",
  },
};

const ctbcCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  CtbcCurrentDepositResponse,
  CtbcCurrentDepositBalanceRow,
  ExistingCtbcFinancialCapture
> = {
  product: "current-balance",
  response: CTBC_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response, acquired) => parseCtbcCurrentDepositBalanceSnapshot({
    payload: decoded.value,
    response,
    requestPostData: acquired.requestPostData,
  }),
  matching: ctbcCurrentBalanceCaptureMatching,
  build: buildCtbcCurrentDepositBalanceCapture,
};

/**
 * Build and stage domestic-deposit items from a read snapshot. Source admission
 * completes before any item is staged, and current balances are read only when
 * at least one capture was admitted as financial data.
 */
export async function stageCtbcDeposit(
  snapshot: CtbcDepositSourceSnapshot,
  _input: CtbcStatementsInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
  readCurrentBalanceResponse: CtbcReadCurrentDepositBalanceResponse,
): Promise<ProductCollectionSummary> {
  context.signal.throwIfAborted();
  await product.validate(() => {
    if (snapshot.captures.length === 0 ||
      snapshot.output.count !== snapshot.captures.length)
      throw new Error("CTBC source has no complete selected account capture.");
  });
  await product.event("validation", "started", "source-validation-started", {
    completed: 0,
    total: snapshot.captures.length,
  });
  const observedAt = taipeiInstant(context.now());
  const validatedCaptures: CtbcDomesticDepositValidatedEvidence[] = [];
  for (const observed of snapshot.captures) {
    context.signal.throwIfAborted();
    validatedCaptures.push(await product.validate(() => {
      const admission = admitCtbcDomesticDepositCaptureEvidence(
        buildCtbcCapture(observed, observedAt),
      );
      if (admission.status !== "admissible" || !admission.capture) {
        throw new Error(
          `CTBC domestic deposit source admission blocked: ${admission.diagnostics.join(", ")}`,
        );
      }
      return admission.capture;
    }));
  }

  const manifest = CTBC_HUMAN_ATTESTED_V1_MANIFEST;
  const financialCaptures: ExistingCtbcFinancialCapture[] = [];
  const items: ProductStageRequest[] = [];
  await product.event("validation", "started", "canonical-admission-started", {
    completed: 0,
    total: validatedCaptures.length,
  });
  for (const capture of validatedCaptures) {
    context.signal.throwIfAborted();
    const captureId = `ctbc-${randomUUID()}`;
    const source = createCtbcDomesticDepositSourceEvidence(capture, captureId);
    if (capture.responses.every((response) => response.rows.length === 0)) {
      items.push({
        product: "domestic-deposit",
        itemKey: captureId,
        command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: source },
      });
      continue;
    }
    const admitted = await product.validate(() => {
      const admission = admitCtbcDomesticDepositFinancialCapture({
        capture,
        captureId: `ctbc-financial-${captureId}`,
        humanAttestation: manifest,
      });
      if (admission.status !== "admitted" || !admission.capture) {
        throw new Error(
          `CTBC domestic deposit financial admission failed: ${admission.diagnostics.join(", ")}`,
        );
      }
      return admission.capture;
    });
    financialCaptures.push(admitted);
    items.push({
      product: "domestic-deposit",
      itemKey: captureId,
      command: {
        kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
        request: { steps: [
          { kind: "source", request: source },
          { kind: "deposit", request: { capture: admitted } },
        ] },
      },
    });
  }
  await product.event("validation", "completed", "canonical-admission-completed", {
    completed: validatedCaptures.length,
    total: validatedCaptures.length,
  });
  context.signal.throwIfAborted();
  const balances = await captureCurrentStateSnapshots(ctbcCurrentBalanceSnapshot, {
    captures: financialCaptures,
    acquire: readCurrentBalanceResponse,
    now: () => context.now(),
    product,
    text: context.text,
    signal: context.signal,
  });

  product.stage(...items, ...balances.items);
  return {
    sourceCaptureCount: validatedCaptures.length,
    rowCount: snapshot.output.rowCount,
  };
}

/** Collect domestic-deposit items for the App-owned financial commit. */
export const runCtbcDeposit: CtbcDepositRunner = async (page, input, context, product) => {
  const snapshot = await readCtbcDepositSource(page, input, context, product);
  return await stageCtbcDeposit(
    snapshot,
    input,
    context,
    product,
    () => readCtbcCurrentDepositBalanceResponse(page, context.signal),
  );
};

export type CtbcWorkflowDependencies = Readonly<{ collectDeposit?: CtbcDepositRunner }>;

export type CtbcWorkflowEntry = VerifiedWorkflowEntry<
  "financialCommit" | "products",
  CtbcStatementsInput,
  WorkflowRunResult,
  never,
  CtbcVerifiedInput
>;

/** CTBC's entry with its deposit runner replaced, for checks that run without a bank page. */
export function ctbcWorkflowWith(overrides: CtbcWorkflowDependencies): CtbcWorkflowEntry {
  return {
    parseInput(verified, raw) {
      const parsed = ctbcInputSchema.safeParse(raw);
      if (!parsed.success) throw new Error("CTBC workflow input is invalid.");
      return { ...verified, ...parsed.data };
    },
    run: (context, input) => runCtbcWorkflow(context, input, overrides),
  };
}

/** App-owned CTBC statement provider. Source admission completes before either commit. */
export const ctbcWorkflow = ctbcWorkflowWith({});

async function runCtbcWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products">,
  input: CtbcStatementsInput,
  overrides: CtbcWorkflowDependencies,
): Promise<WorkflowRunResult> {
  const collectDeposit = overrides.collectDeposit ?? runCtbcDeposit;

  return context.browser.withPage(async (page) => {
    await signIn(context, page, CTBC_SOURCE, ctbcSignInPlan(input.credentials));

    let count = 0;
    const summary = await context.products.collect({
      deposit: async (product): Promise<ProductCollectionSummary> => {
        const productContext: WorkflowContext = { ...context, event: product.event };
        await productContext.event("decoding", "started", "source-decoding-started");
        const collected = await collectDeposit(page, input, productContext, product);
        // stageCtbcDeposit admits only when every selected account was captured.
        count = collected.sourceCaptureCount;
        return collected;
      },
    });

    return productRunResult(summary, { counts: { count } });
  });
}
