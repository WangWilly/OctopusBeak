import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Locator, Page } from "playwright";
import { z } from "zod";

const LOGIN_URL = "https://accessibility.linebank.com.tw/login";
const TRANSACTION_URL = "https://accessibility.linebank.com.tw/transaction";
const ACCOUNTS_ENDPOINT = "/v1/account/common/payables?featureTypeCode=01";
const TRANSACTIONS_ENDPOINT = "/v1/account/history/transactions";
export const LINEBANK_MANUAL_LOGIN_TIMEOUT_MS = 120_000;

const statementHeaders = [
  "帳務日期",
  "交易日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
  "匯率",
];

const dateSchema = z.string().regex(/^\d{8}$/);

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
});

const downloadSchema = z.object({
  accountId: z.string(),
  account: z.string(),
  currency: z.string(),
  kind: z.enum(["domestic", "foreign"]),
  queryPeriods: z.array(z.string()),
  baseName: z.string(),
  csvFilename: z.string(),
  csvPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonFilename: z.string(),
  jsonPath: z.string(),
  jsonBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.object({
    startDate: dateSchema,
    endDate: dateSchema,
  }),
  count: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  downloads: z.array(downloadSchema),
});

type DateRange = {
  startDate: string;
  endDate: string;
};

type LineBankCredentials = {
  linebank_user_id?: string;
  linebank_account?: string;
  linebank_password?: string;
};

export type LineBankAccount = {
  acctNbr?: string;
  arrId?: string;
  acctNick?: string;
  pdNm?: string;
  currCd?: string;
  ccyCd?: string;
  crncyCd?: string;
  currency?: string;
};

/** The provider's account identity is a composite of the two source fields.
 * Keep the delimiter explicit so two different pairs cannot concatenate to the
 * same opaque key (for example, `12` + `3` versus `1` + `23`). */
export function linebankAccountKey(account: LineBankAccount): string {
  const accountNumber = cleanText(account.acctNbr);
  const arrangementId = cleanText(account.arrId);
  return accountNumber && arrangementId
    ? `${accountNumber}:${arrangementId}`
    : "";
}

type LineBankAccountsResponse = {
  code?: string;
  message?: string;
  content?: {
    dpstAcctList?: LineBankAccount[];
  } | null;
};

export type LineBankTransactionRow = {
  txSeqNbr?: number | string;
  txDt?: string;
  txTm?: string;
  /** Observed source type: epoch milliseconds. */
  txDtm?: number;
  dpstWdrwDsCd?: string;
  bizTxFuncTpCd?: string;
  bizTxFuncTpNm?: string;
  crrnDpstNthCnt?: number;
  ctptCustLineUid?: string | null;
  fxsTxId?: string | null;
  rltvTxArrId?: string | null;
  txCaseCd?: string;
  txAmt?: number | string;
  afTxBal?: number | string;
  cncdTxYn?: string;
  cnclTxYn?: string;
  txRmkCont?: string;
  txMemoVal?: string | null;
};

/** Scalar account/product/status fields observed in the transaction response. */
export type LineBankTransactionSourceEnvelope = {
  acctNbr?: string;
  arrId?: string;
  acctNick?: string;
  acctBal?: number;
  wdrwAvblAmt?: number;
  acctColrTpCd?: string;
  acctColrTpVal?: string;
  acctCardImgUrl?: string | null;
  pdCd?: string;
  pdNm?: string;
  simpAcctTpCd?: string | null;
  jntAcctMbrTpCd?: string;
  isSecuAcctBndg?: boolean;
  debitCardFundBlcknYn?: string;
  txBlcknYn?: string;
  opnDtm?: number;
  jntMbrListCnt?: number;
  totJntAcctMbrCnt?: number;
  rcntTxfrListCnt?: number;
};

export type LineBankTransactionResponseContent =
  LineBankTransactionSourceEnvelope & {
    pageNbr?: number;
    pageCnt?: number;
    totTxCnt?: number;
    txCnt?: number;
    txLst?: LineBankTransactionRow[];
  };

export type LineBankTransactionsResponse = {
  code?: string;
  message?: string;
  content?: LineBankTransactionResponseContent | null;
};

/** A page preserves the source response envelope instead of reducing it to
 * rendered CSV rows. The canonical contract uses these counts to prove that
 * the requested range was completely collected before admitting any record. */
export type LineBankTransactionPage = {
  pageNbr: number;
  pageCnt: number;
  totTxCnt: number;
  txCnt: number;
  rows: LineBankTransactionRow[];
  source?: LineBankTransactionSourceEnvelope;
  responseCode?: string;
  responseMessage?: string;
};

type LineBankDownload = z.infer<typeof downloadSchema>;

export type LineBankStatementRow = {
  sortKey: string;
  values: string[];
};

let lastTimestamp = 0;

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function nextTimestamp(): string {
  const timestamp = Date.now();
  lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
  return String(lastTimestamp);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function dateFromYYYYMMDD(value: string): Date {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}`);
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date;
}

function formatYYYYMMDD(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function defaultEndDate(): string {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
}

function resolveDateRange(input: z.infer<typeof inputSchema>): DateRange {
  const endDate = input.endDate ?? defaultEndDate();
  const startDate =
    input.startDate ??
    formatYYYYMMDD(addDays(addMonths(dateFromYYYYMMDD(endDate), -12), 1));
  if (dateFromYYYYMMDD(startDate) > dateFromYYYYMMDD(endDate)) {
    throw new Error("startDate must be on or before endDate.");
  }
  return { startDate, endDate };
}

export function linebankQueryWindows(dateRange: DateRange): DateRange[] {
  const firstStart = dateFromYYYYMMDD(dateRange.startDate);
  let end = dateFromYYYYMMDD(dateRange.endDate);
  if (firstStart > end)
    throw new Error("startDate must be on or before endDate.");
  const windows: DateRange[] = [];

  while (end >= firstStart) {
    const maxStart = addDays(addMonths(end, -12), 1);
    const start = maxStart > firstStart ? maxStart : firstStart;
    windows.push({
      startDate: formatYYYYMMDD(start),
      endDate: formatYYYYMMDD(end),
    });
    if (formatYYYYMMDD(start) === dateRange.startDate) break;
    end = addDays(start, -1);
  }

  return windows;
}

function formatSlashDate(value: string): string {
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
}

function formatTime(value: string | undefined): string {
  const raw = cleanText(value).padStart(6, "0");
  if (!/^\d{6}$/.test(raw)) return cleanText(value);
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4, 6)}`;
}

export const LINEBANK_OBSERVED_TIME_EVIDENCE_VERSION =
  "observed-time-v1" as const;

/** Reconstruct the source timestamp using Taiwan's fixed UTC+8 offset. */
export function linebankEpochMillisecondsFromSourceDateTime(
  txDt: string | undefined,
  txTm: string | undefined,
): number {
  const date = cleanText(txDt);
  const time = cleanText(txTm);
  const dateMatch = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = time.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    throw new Error("LINE Bank transaction source date/time is invalid.");
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error("LINE Bank transaction source date/time is invalid.");
  }
  const epochMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour - 8,
    minute,
    second,
  );
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new Error("LINE Bank transaction source time is out of range.");
  }
  return epochMilliseconds;
}

export function linebankValidateTransactionTime(
  row: LineBankTransactionRow,
): void {
  if (
    !cleanText(row.txDt) ||
    !cleanText(row.txTm) ||
    row.txDtm === undefined ||
    row.txDtm === null
  ) {
    throw new Error("LINE Bank transaction source time is incomplete.");
  }
  if (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0) {
    throw new Error(
      "LINE Bank transaction source txDtm must be a safe epoch-millisecond integer.",
    );
  }
  if (
    linebankEpochMillisecondsFromSourceDateTime(row.txDt, row.txTm) !==
    row.txDtm
  ) {
    throw new Error(
      "LINE Bank transaction source txDtm does not match txDt+txTm in Asia/Taipei.",
    );
  }
}

/** Preserve and validate the provider occurrence fields before any export. */
export function linebankValidateSourceOccurrenceFields(
  row: LineBankTransactionRow,
): void {
  const txSeqNbr = row.txSeqNbr;
  const validSequence =
    (typeof txSeqNbr === "number" &&
      Number.isSafeInteger(txSeqNbr) &&
      txSeqNbr > 0) ||
    (typeof txSeqNbr === "string" &&
      /^\d+$/.test(txSeqNbr.trim()) &&
      BigInt(txSeqNbr.trim()) > 0n);
  if (!validSequence) {
    throw new Error(
      "LINE Bank transaction source txSeqNbr must be a positive integer.",
    );
  }
  if (
    typeof row.crrnDpstNthCnt !== "number" ||
    !Number.isSafeInteger(row.crrnDpstNthCnt) ||
    row.crrnDpstNthCnt <= 0
  ) {
    throw new Error(
      "LINE Bank transaction source crrnDpstNthCnt must be a positive integer.",
    );
  }
  linebankValidateTransactionTime(row);
}

const DECIMAL_AMOUNT_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function transactionAmountLexeme(value: number | string | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Invalid LINE Bank transaction amount.");
    const lexeme = String(value);
    if (!DECIMAL_AMOUNT_RE.test(lexeme)) {
      throw new Error("Invalid LINE Bank transaction amount.");
    }
    return lexeme;
  }
  if (typeof value !== "string")
    throw new Error("Invalid LINE Bank transaction amount.");
  const lexeme = value.trim();
  if (lexeme === "" || !DECIMAL_AMOUNT_RE.test(lexeme)) {
    if (lexeme === "") return "";
    throw new Error("Invalid LINE Bank transaction amount.");
  }
  return lexeme;
}

function amountText(value: number | string | undefined): string {
  return transactionAmountLexeme(value).replace(/^-/, "");
}

function validateTransactionDirection(row: LineBankTransactionRow): string {
  if (row.dpstWdrwDsCd !== "1" && row.dpstWdrwDsCd !== "2") {
    throw new Error("Unsupported LINE Bank transaction direction.");
  }
  const rawAmount = transactionAmountLexeme(row.txAmt);
  if (rawAmount.startsWith("-")) {
    throw new Error(
      `LINE Bank transaction amount conflicts with ${
        row.dpstWdrwDsCd === "1" ? "deposit" : "withdrawal"
      } direction.`,
    );
  }
  return rawAmount;
}

function amountColumns(row: LineBankTransactionRow): [string, string] {
  const rawAmount = validateTransactionDirection(row);
  const amount = rawAmount.replace(/^-/, "");
  if (!amount) return ["", ""];
  return row.dpstWdrwDsCd === "1" ? ["", amount] : [amount, ""];
}

function compareRowsDesc(
  left: LineBankStatementRow,
  right: LineBankStatementRow,
) {
  return right.sortKey.localeCompare(left.sortKey);
}

export function linebankSortStatementRows(
  rows: LineBankStatementRow[],
): LineBankStatementRow[] {
  return [...rows].sort(compareRowsDesc);
}

function linebankSourceEnvelope(
  content: LineBankTransactionResponseContent,
): LineBankTransactionSourceEnvelope {
  return {
    acctNbr: content.acctNbr,
    arrId: content.arrId,
    acctNick: content.acctNick,
    acctBal: content.acctBal,
    wdrwAvblAmt: content.wdrwAvblAmt,
    acctColrTpCd: content.acctColrTpCd,
    acctColrTpVal: content.acctColrTpVal,
    acctCardImgUrl: content.acctCardImgUrl,
    pdCd: content.pdCd,
    pdNm: content.pdNm,
    simpAcctTpCd: content.simpAcctTpCd,
    jntAcctMbrTpCd: content.jntAcctMbrTpCd,
    isSecuAcctBndg: content.isSecuAcctBndg,
    debitCardFundBlcknYn: content.debitCardFundBlcknYn,
    txBlcknYn: content.txBlcknYn,
    opnDtm: content.opnDtm,
    jntMbrListCnt: content.jntMbrListCnt,
    totJntAcctMbrCnt: content.totJntAcctMbrCnt,
    rcntTxfrListCnt: content.rcntTxfrListCnt,
  };
}

/** Preserve the source response as a typed staged page without projecting it
 * into CSV fields. This helper is deliberately pure so its shape can be
 * checked without a browser or a live request. */
export function linebankTransactionPageFromResponse(
  response: LineBankTransactionsResponse,
): LineBankTransactionPage {
  if (response.code !== "200") {
    throw new Error("LINE Bank transactions failed.");
  }
  const content = response.content;
  const pageRows = content?.txLst;
  if (!content || !Array.isArray(pageRows)) {
    throw new Error("LINE Bank transaction response is missing its page rows.");
  }
  const pageNbr = content.pageNbr;
  const pageCnt = content.pageCnt;
  const totTxCnt = content.totTxCnt;
  const txCnt = content.txCnt;
  if (
    typeof pageNbr !== "number" ||
    typeof pageCnt !== "number" ||
    typeof totTxCnt !== "number" ||
    typeof txCnt !== "number" ||
    !Number.isInteger(pageNbr) ||
    !Number.isInteger(pageCnt) ||
    !Number.isInteger(totTxCnt) ||
    !Number.isInteger(txCnt) ||
    pageNbr < 1 ||
    pageCnt < 1 ||
    totTxCnt < 0 ||
    txCnt < 0 ||
    txCnt !== pageRows.length
  ) {
    throw new Error(
      "LINE Bank transaction response has invalid page/count metadata.",
    );
  }
  for (const balance of [content.acctBal, content.wdrwAvblAmt]) {
    if (balance !== undefined && balance !== null) {
      transactionAmountLexeme(balance);
    }
  }
  for (const row of pageRows) {
    linebankValidateSourceOccurrenceFields(row);
    if (row.txAmt !== undefined && row.txAmt !== null) {
      transactionAmountLexeme(row.txAmt);
    }
    if (row.afTxBal !== undefined && row.afTxBal !== null) {
      transactionAmountLexeme(row.afTxBal);
    }
    if (
      row.txDtm !== undefined &&
      (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0)
    ) {
      throw new Error("LINE Bank transaction response has invalid txDtm type.");
    }
  }
  return {
    pageNbr,
    pageCnt,
    totTxCnt,
    txCnt,
    rows: pageRows,
    source: linebankSourceEnvelope(content),
    responseCode: response.code,
    responseMessage: response.message,
  };
}

function noteText(row: LineBankTransactionRow): string {
  return [row.txRmkCont, row.txMemoVal]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

export function linebankApiRowsToStatementRows(
  rows: LineBankTransactionRow[],
): LineBankStatementRow[] {
  for (const row of rows) {
    validateTransactionDirection(row);
    if (row.afTxBal !== undefined && row.afTxBal !== null) {
      transactionAmountLexeme(row.afTxBal);
    }
  }
  return rows
    .filter((row) => cleanText(row.txDt) || cleanText(row.bizTxFuncTpNm))
    .map((row) => {
      const [withdrawal, deposit] = amountColumns(row);
      const values = [
        formatSlashDate(cleanText(row.txDt)),
        formatSlashDate(cleanText(row.txDt)),
        formatTime(row.txTm),
        cleanText(row.bizTxFuncTpNm),
        withdrawal,
        deposit,
        amountText(row.afTxBal),
        noteText(row),
        "",
      ];
      return {
        sortKey: `${cleanText(row.txDt)} ${cleanText(row.txTm)} ${row.txSeqNbr ?? ""}`,
        values,
      };
    });
}

export function linebankValidateTransactionPageSequence(
  pages: readonly LineBankTransactionPage[],
  options: {
    requireComplete?: boolean;
    expectedAccount?: LineBankAccount;
  } = {},
): void {
  if (pages.length === 0)
    throw new Error("LINE Bank transaction pages are empty.");
  const first = pages[0];
  let collectedRows = 0;
  let sourceIdentity: string | undefined;
  const expectedIdentity = options.expectedAccount
    ? linebankAccountKey(options.expectedAccount)
    : "";
  const hasSourceEnvelope = pages.some((page) => page.source !== undefined);
  if (expectedIdentity && pages.some((page) => page.source === undefined)) {
    throw new Error(
      "LINE Bank source account identity metadata is missing for requested account.",
    );
  }
  if (hasSourceEnvelope && pages.some((page) => page.source === undefined)) {
    throw new Error("LINE Bank source account identity metadata is missing.");
  }
  for (const [index, page] of pages.entries()) {
    if (
      !Number.isInteger(page.pageNbr) ||
      page.pageNbr !== index + 1 ||
      !Number.isInteger(page.pageCnt) ||
      page.pageCnt < 1 ||
      !Number.isInteger(page.totTxCnt) ||
      page.totTxCnt < 0 ||
      !Number.isInteger(page.txCnt) ||
      page.txCnt < 0 ||
      page.txCnt !== page.rows.length
    ) {
      throw new Error("LINE Bank transaction page metadata is invalid.");
    }
    if (page.responseCode !== undefined && page.responseCode !== "200") {
      throw new Error("LINE Bank transaction response status is invalid.");
    }
    if (page.source !== undefined) {
      const acctNbr = cleanText(page.source.acctNbr);
      const arrId = cleanText(page.source.arrId);
      if (!acctNbr || !arrId) {
        throw new Error(
          "LINE Bank source account identity metadata is incomplete.",
        );
      }
      const pageSourceIdentity = `${acctNbr}:${arrId}`;
      if (expectedIdentity && pageSourceIdentity !== expectedIdentity) {
        throw new Error(
          "LINE Bank source account identity does not match requested account.",
        );
      }
      if (
        sourceIdentity !== undefined &&
        pageSourceIdentity !== sourceIdentity
      ) {
        throw new Error("LINE Bank source account identity drift detected.");
      }
      sourceIdentity = pageSourceIdentity;
    }
    if (page.pageCnt !== first.pageCnt)
      throw new Error("LINE Bank pageCnt drift detected.");
    if (page.totTxCnt !== first.totTxCnt)
      throw new Error("LINE Bank totTxCnt drift detected.");
    for (const row of page.rows) {
      if (
        row.txDtm !== undefined &&
        (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0)
      ) {
        throw new Error("LINE Bank transaction txDtm type is invalid.");
      }
    }
    collectedRows += page.rows.length;
  }
  if (options.requireComplete && collectedRows !== first.totTxCnt) {
    throw new Error("LINE Bank transaction total row count mismatch.");
  }
}

export function linebankStatementRowsToCsv(
  rows: LineBankStatementRow[],
): string {
  return rowsToCsv([statementHeaders, ...rows.map((row) => row.values)]);
}

function accountId(account: LineBankAccount): string {
  return cleanText(account.acctNbr);
}

function accountLabel(account: LineBankAccount): string {
  return (
    cleanText(account.acctNick) || cleanText(account.pdNm) || accountId(account)
  );
}

export function linebankAccountCurrency(account: LineBankAccount): string {
  return cleanText(
    account.currCd ??
      account.ccyCd ??
      account.crncyCd ??
      account.currency ??
      "TWD",
  ).toUpperCase();
}

function matchesFilters(account: LineBankAccount, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const haystack =
    `${accountLabel(account)} ${accountId(account)}`.toLowerCase();
  return filters.some((filter) => haystack.includes(filter.toLowerCase()));
}

function filterAccounts(
  accounts: LineBankAccount[],
  accountFilters: string[],
  currencyFilters: string[],
): LineBankAccount[] {
  const currencies = new Set(
    currencyFilters.map((currency) => currency.toUpperCase()),
  );
  return accounts.filter((account) => {
    const currency = linebankAccountCurrency(account);
    return (
      accountId(account) &&
      account.arrId &&
      matchesFilters(account, accountFilters) &&
      (currencies.size === 0 || currencies.has(currency))
    );
  });
}

function queryPeriod(dateRange: DateRange): string {
  return `${formatSlashDate(dateRange.startDate)} ~ ${formatSlashDate(dateRange.endDate)}`;
}

function transactionLinkLocator(page: Page): Locator {
  return page.getByRole("link", { name: "帳戶交易明細查詢" });
}

function authenticatedMarkerLocator(page: Page): Locator {
  return page.locator(
    'a[href="/transaction"]:visible, #account-dropdown:visible',
  );
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
  }
  return matches;
}

async function firstVisibleMatch(locator: Locator): Promise<Locator | null> {
  return (await visibleMatches(locator))[0] ?? null;
}

/**
 * Close only the explicitly approved, non-form dismissal button on one
 * visible alertdialog. Never inspect dialog text, click unknown controls, or
 * force a click; anything ambiguous remains a hard pre-query blocker.
 */
export async function linebankAutoDismissApprovedAlert(
  page: Page,
): Promise<void> {
  const dialogs = page.getByRole("alertdialog");
  const visibleDialogs = await visibleMatches(dialogs);
  if (visibleDialogs.length === 0) return;
  if (visibleDialogs.length !== 1) {
    throw new Error(
      "LINE Bank requires exactly one visible alert dialog before navigation.",
    );
  }

  const dialog = visibleDialogs[0];
  const approvedButtons = dialog.getByRole("button", {
    name: /^(?:確定|關閉|知道了)$/,
  });
  if ((await approvedButtons.count()) !== 1) {
    throw new Error(
      "LINE Bank alert dialog requires exactly one approved dismissal button.",
    );
  }
  const button = approvedButtons.nth(0);
  if (!(await button.isVisible().catch(() => false))) {
    throw new Error("LINE Bank approved dismissal button is not visible.");
  }
  await button.click();
  await dialog.waitFor({
    state: "hidden",
    timeout: LINEBANK_MANUAL_LOGIN_TIMEOUT_MS,
  });
  if ((await visibleMatches(dialogs)).length !== 0) {
    throw new Error("LINE Bank alert dialog remained visible after dismissal.");
  }
}

export async function linebankIsSignedIn(page: Page): Promise<boolean> {
  const pathname = new URL(page.url()).pathname;
  if (pathname === "/login") return false;
  if (pathname === "/transaction") {
    return (
      (await firstVisibleMatch(page.locator("#account-dropdown"))) !== null
    );
  }
  return (await firstVisibleMatch(transactionLinkLocator(page))) !== null;
}

/**
 * Wait for the person to complete LINE Bank login and any CAPTCHA in the
 * visible browser. Credentials remain a declared workflow contract, but this
 * callback never reads, fills, logs, or submits them.
 */
export async function linebankWaitForManualSignIn(page: Page): Promise<void> {
  if (await linebankIsSignedIn(page)) return;
  if (new URL(page.url()).pathname !== "/login") {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  }

  // Wait for human CAPTCHA/login completion; see https://libretto.sh/docs/libretto-cloud-hosting/stealth.
  const deadline = Date.now() + LINEBANK_MANUAL_LOGIN_TIMEOUT_MS;
  const remainingTimeout = () => Math.max(1, deadline - Date.now());
  await page.waitForURL((url) => url.pathname !== "/login", {
    timeout: remainingTimeout(),
  });
  if (!(await linebankIsSignedIn(page))) {
    const marker = authenticatedMarkerLocator(page).first();
    await marker.waitFor({
      state: "visible",
      timeout: remainingTimeout(),
    });
  }
  if (
    !(await linebankIsSignedIn(page)) ||
    new URL(page.url()).pathname === "/login"
  ) {
    throw new Error(
      "LINE Bank manual sign-in did not reach an authenticated page.",
    );
  }
}

/** Enter the transaction stage only after authentication has completed. */
export async function linebankEnsureTransactionPage(page: Page): Promise<void> {
  if (new URL(page.url()).pathname === "/transaction") {
    await page.locator("#account-dropdown").waitFor({
      state: "visible",
      timeout: LINEBANK_MANUAL_LOGIN_TIMEOUT_MS,
    });
    return;
  }

  const transactionLink = await firstVisibleMatch(transactionLinkLocator(page));
  if (transactionLink) {
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/transaction", {
        timeout: LINEBANK_MANUAL_LOGIN_TIMEOUT_MS,
      }),
      transactionLink.click(),
    ]);
  } else {
    await page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" });
  }
  await page.locator("#account-dropdown").waitFor({
    state: "visible",
    timeout: LINEBANK_MANUAL_LOGIN_TIMEOUT_MS,
  });
}

class LineBankApiClient {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  private async apiJson<T>(
    path: string,
    options?: { body?: unknown },
  ): Promise<T> {
    return (await this.page.evaluate(
      async ({ path, body }) => {
        const headers = {
          accept: "application/json",
          chnldscd: "IBK",
          lclcd: "zh-TW",
        };
        const init: RequestInit = {
          credentials: "include",
          headers,
        };
        if (body) {
          init.method = "POST";
          init.headers = {
            ...headers,
            "Content-Type": "application/json;charset=UTF-8",
          };
          init.body = JSON.stringify(body);
        }
        const response = await fetch(path, init);
        if (!response.ok) throw new Error(`${response.status} for ${path}`);
        return await response.json();
      },
      { path, body: options?.body },
    )) as T;
  }

  async fetchAccounts(): Promise<LineBankAccount[]> {
    const response =
      await this.apiJson<LineBankAccountsResponse>(ACCOUNTS_ENDPOINT);
    if (response.code !== "200") {
      throw new Error(
        `LINE Bank account list failed: ${response.message ?? "unknown"}`,
      );
    }
    return response.content?.dpstAcctList ?? [];
  }

  async fetchTransactionPages(
    account: LineBankAccount,
    dateRange: DateRange,
  ): Promise<LineBankTransactionPage[]> {
    const pages: LineBankTransactionPage[] = [];
    const rows: LineBankTransactionRow[] = [];
    const pageCnt = 1000;
    let pageNbr = 1;
    let total = Number.POSITIVE_INFINITY;

    while (rows.length < total) {
      const response = await this.apiJson<LineBankTransactionsResponse>(
        TRANSACTIONS_ENDPOINT,
        {
          body: {
            acctNbr: accountId(account),
            arrId: account.arrId,
            dpstWdrwDsCd: "",
            inqrStrtDt: dateRange.startDate,
            inqrEndDt: dateRange.endDate,
            sortTpCd: 2,
            pageNbr,
            pageCnt,
            totCnt: pageCnt,
            txDtlDsCd: "01",
          },
        },
      );
      const page = linebankTransactionPageFromResponse(response);
      if (page.pageNbr !== pageNbr) {
        throw new Error(
          "LINE Bank transaction page metadata does not match the requested page.",
        );
      }
      if (page.totTxCnt < rows.length + page.rows.length) {
        throw new Error(
          "LINE Bank transaction page rows exceed the reported total.",
        );
      }
      pages.push(page);
      linebankValidateTransactionPageSequence(pages, {
        expectedAccount: account,
      });
      rows.push(...page.rows);
      total = page.totTxCnt;
      if (page.rows.length === 0 && rows.length < total) {
        throw new Error(
          "LINE Bank transaction pagination ended before the reported total.",
        );
      }
      if (rows.length >= total) break;
      pageNbr += 1;
    }

    linebankValidateTransactionPageSequence(pages, {
      requireComplete: true,
      expectedAccount: account,
    });
    return pages;
  }

  async fetchTransactions(
    account: LineBankAccount,
    dateRange: DateRange,
  ): Promise<LineBankTransactionRow[]> {
    const pages = await this.fetchTransactionPages(account, dateRange);
    return pages.flatMap((page) => page.rows);
  }
}

async function writeStatementFiles(
  account: LineBankAccount,
  queryPeriods: string[],
  rows: LineBankStatementRow[],
): Promise<LineBankDownload> {
  const currency = linebankAccountCurrency(account);
  const kind = currency === "TWD" ? "domestic" : "foreign";
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    kind === "domestic" ? "linebank-statements" : "linebank-foreign-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${safeFilename(accountId(account))}-${currency}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, linebankStatementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: `${accountId(account)} ${accountLabel(account)}`.trim(),
        查詢期間: queryPeriods,
        分行名稱: "LINE Bank",
        幣別: currency,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    accountId: accountId(account),
    account: accountLabel(account),
    currency,
    kind,
    queryPeriods,
    baseName,
    csvFilename,
    csvPath,
    csvBytes: csvStat.size,
    jsonFilename,
    jsonPath,
    jsonBytes: jsonStat.size,
    rowCount: rows.length,
  };
}

async function downloadLineBankStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
): Promise<z.infer<typeof outputSchema>> {
  const dateRange = resolveDateRange(input);
  const windows = linebankQueryWindows(dateRange);
  const apiClient = new LineBankApiClient(page);
  const accounts = filterAccounts(
    await apiClient.fetchAccounts(),
    input.accountFilters,
    input.currencyFilters,
  );

  if (accounts.length === 0) {
    throw new Error(
      "No LINE Bank accounts matched accountFilters/currencyFilters.",
    );
  }

  const downloads: LineBankDownload[] = [];
  for (const account of accounts) {
    const rows: LineBankStatementRow[] = [];
    for (const window of windows) {
      rows.push(
        ...linebankApiRowsToStatementRows(
          await apiClient.fetchTransactions(account, window),
        ),
      );
    }
    downloads.push(
      await writeStatementFiles(
        account,
        windows.map(queryPeriod),
        linebankSortStatementRows(rows),
      ),
    );
  }

  return {
    dateRange,
    count: downloads.length,
    rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
    downloads,
  };
}

/**
 * Manual-auth exception: librettoAuthenticate remains the authentication
 * boundary and the credential declaration is retained for workflow metadata
 * and runtime compatibility, but LINE Bank credentials are never read,
 * filled, submitted, or logged here. The human completes login/CAPTCHA; only
 * then does automation proceed from the visible authenticated state.
 */
export default workflow("linebankStatements", {
  startUrl: LOGIN_URL,
  credentials: ["linebank_user_id", "linebank_account", "linebank_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as z.infer<typeof inputSchema> & {
      credentials: LineBankCredentials;
    };
    const { page } = ctx;

    await librettoAuthenticate(ctx, {
      credentials: input.credentials,
      isSignedIn: async () => await linebankIsSignedIn(page),
      signIn: async (signInContext) => {
        await linebankWaitForManualSignIn(signInContext.page);
      },
    });

    await linebankAutoDismissApprovedAlert(page);
    console.log("automation-progress: 25");
    await linebankEnsureTransactionPage(page);
    const result = await downloadLineBankStatements(page, input);
    console.log("automation-progress: 100");
    return result;
  },
});
