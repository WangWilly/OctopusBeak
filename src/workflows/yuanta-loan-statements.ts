import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  clickAndWaitForNavigation,
  hasAttachedLocator,
} from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { canonicalSqlitePath } from "../ledger/canonical/canonical-source-store.ts";
import {
  createCanonicalLoanStore,
  type LoanCapturePage,
  type LoanSourceCompletenessEvidence,
} from "../ledger/canonical/loan-financial.ts";
import {
  buildYuantaLoanCapture,
  persistYuantaLoanCapture,
  type YuantaLoanCaptureBuildInput,
  type YuantaLoanStatementRow,
} from "../ledger/canonical/yuanta-loan.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  authenticateYuantaBank as sharedAuthenticateYuantaBank,
  yuantaSourceConnectionScope,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  persistCounterpartyAccountEvidence,
  resolveLoanRepaymentRelations,
  type LoanRepaymentRelationResolutionResult,
  type TransactionCounterpartyAccountEvidenceInput,
} from "../ledger/canonical/loan-repayment-relations.ts";
import {
  deriveSourceConnectionIdentityKey,
  requireSourceConnectionIdentity,
} from "../ledger/canonical/source-connection-identity.ts";
import { resolveLoanRelationsAfterCapture } from "./safe-loan-relation-resolution.ts";
import type { YuantaCounterpartyAccountEvidence } from "./yuanta-statements.ts";

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";

type BrowserScope = Page | Frame;

export type LoanAccountOption = {
  label: string;
  value: string;
};

export const YUANTA_LOAN_SELECTOR_ACCOUNT_MANDATE_CONTRACT_VERSION =
  "yuanta/loan-statement-selector-account/v1" as const;

export type StatementRow = {
  accountLabel: string;
  transactionDate: string;
  postingDate: string;
  paymentItem: string;
  interestStartDate: string;
  interestEndDate: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
  overpayment: string;
  sortTime: number | null;
};

const YUANTA_LOAN_MAX_PAGES = 10_000;

export type YuantaLoanPaginationSignal = {
  nextPageTarget: string | null;
  terminal: boolean;
  evidence: "next-page" | "terminal-no-next" | null;
};

type ParsedYuantaLoanPage = {
  rows: StatementRow[];
  pageOrdinal: number;
  pagination: YuantaLoanPaginationSignal;
};

const quickDateRangeSchema = z.enum(["three_months", "six_months", "one_year"]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("one_year"),
  customDateRange: customDateRangeSchema.optional(),
  loanAccountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
});

const sourceTableSchema = z.object({
  account: z.string(),
  rowCount: z.number().int().nonnegative(),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.literal("loan-statements"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  accounts: z.array(z.string()),
  dateRange: z.string(),
  sourceTables: z.array(sourceTableSchema),
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.string(),
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
  relationResolution: z
    .object({
      status: z.literal("canonical-live"),
      outcome: z.enum(["changed", "unchanged", "no-admission"]),
      resolutionId: z.string().nullable(),
      exactRelationIds: z.array(z.string()),
      settlementGroupIds: z.array(z.string()),
      reason: z.string().optional(),
    })
    .optional(),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;
type SourceTable = z.infer<typeof sourceTableSchema>;
type YuantaLoanStatementsOutput = z.infer<typeof outputSchema>;

export type YuantaLoanStatementsRunDependencies = Partial<{
  canonicalLedgerDir: string;
  canonicalFinancialLedgerDir: string;
  sourceConnectionScope: string;
  sourceConnectionKey: string;
  observedAt: () => string;
  createLoanStore: typeof createCanonicalLoanStore;
  /** Test/live-adapter seams; production uses the provider page functions. */
  openLoanStatementPage: (page: Page) => Promise<unknown>;
  readLoanAccountOptions: typeof readYuantaLoanAccountOptions;
  queryLoanAccount: (
    page: Page,
    input: WorkflowInput,
    account: LoanAccountOption,
  ) => Promise<void>;
  traverseLoanStatementPages: (
    page: Page,
    accountLabel: string,
  ) => Promise<ReturnType<typeof assembleYuantaLoanStatement>>;
  writeLoanStatementsFile: typeof writeLoanStatementsFile;
  /**
   * Optional live-page adapter for exact source-provided repayment-account or
   * mandate evidence.  The default Yuanta loan page exposes no such field,
   * so the production path leaves it empty instead of guessing from dates or
   * amounts.
   */
  readCounterpartyAccountEvidence: (
    page: Page,
    account: LoanAccountOption,
    rows: readonly StatementRow[],
  ) =>
    | readonly YuantaCounterpartyAccountEvidence[]
    | Promise<readonly YuantaCounterpartyAccountEvidence[]>;
  /** Optional provider-explicit transaction links supplied by a live adapter. */
  explicitRelationLinks: Parameters<typeof resolveLoanRepaymentRelations>[1]["explicitLinks"];
  resolveRelations: typeof resolveLoanRepaymentRelations;
  persistLoanCapture: (
    store: ReturnType<typeof createCanonicalLoanStore>,
    input: YuantaLoanCaptureBuildInput,
  ) => ReturnType<typeof persistYuantaLoanCapture>;
}>;

const dateRangeLabels: Record<z.infer<typeof quickDateRangeSchema>, string> = {
  three_months: "三個月",
  six_months: "六個月",
  one_year: "一年",
};

const statementHeaders = [
  "貸款帳戶",
  "交易日",
  "記帳日",
  "繳款項目",
  "提息起日",
  "提息迄日",
  "交易金額",
  "交易後餘額",
  "溢繳款",
] as const;

const sourceStatementColumnCount = 6;

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string): string {
  return cleanText(value.replace(/<[^>]*>/gu, " "));
}

function htmlAttribute(openingTag: string, name: string): string {
  const match = [
    ...openingTag.matchAll(
      /\s([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu,
    ),
  ].find((entry) => entry[1]?.toLowerCase() === name.toLowerCase());
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? "";
}

function htmlControlOpeningTag(controlHtml: string): string {
  return (
    controlHtml.match(/^<(?:a|button|input)\b[^>]*>/iu)?.[0] ?? controlHtml
  );
}

function htmlControlLabel(controlHtml: string): string {
  const opening = htmlControlOpeningTag(controlHtml);
  return (
    stripHtml(controlHtml) ||
    cleanText(htmlAttribute(opening, "value")) ||
    cleanText(htmlAttribute(opening, "aria-label"))
  );
}

function isDisabledHtmlControl(openingTag: string): boolean {
  return (
    hasHtmlBooleanAttribute(openingTag, "disabled") ||
    htmlAttribute(openingTag, "aria-disabled").trim().toLowerCase() ===
      "true" ||
    hasHtmlClassToken(openingTag, "disabled")
  );
}

function hasHtmlBooleanAttribute(openingTag: string, name: string): boolean {
  return [
    ...openingTag.matchAll(
      /\s([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gu,
    ),
  ].some((entry) => entry[1]?.toLowerCase() === name.toLowerCase());
}

function hasHtmlClassToken(openingTag: string, token: string): boolean {
  return htmlAttribute(openingTag, "class")
    .split(/\s+/u)
    .some((value) => value.toLowerCase() === token.toLowerCase());
}

function hasHtmlClassOrIdToken(openingTag: string, token: string): boolean {
  return [htmlAttribute(openingTag, "class"), htmlAttribute(openingTag, "id")]
    .flatMap((value) => value.split(/\s+/u))
    .some((value) => value.toLowerCase() === token.toLowerCase());
}

function extractBalancedHtmlElement(
  html: string,
  openingStart: number,
  openingTag: string,
): string {
  const tagName = openingTag.match(/^<([a-z][\w:-]*)\b/iu)?.[1];
  if (!tagName || /\/>$/u.test(openingTag)) return openingTag;
  const tokens = [
    ...html.slice(openingStart).matchAll(
      new RegExp("<\\/?" + tagName + "\\b[^>]*>", "giu"),
    ),
  ];
  let depth = 0;
  for (const token of tokens) {
    const value = token[0];
    if (/^<\//u.test(value)) {
      depth -= 1;
      if (depth === 0) {
        const end = (token.index ?? 0) + value.length;
        return html.slice(openingStart, openingStart + end);
      }
    } else if (!/\/>$/u.test(value)) {
      depth += 1;
    }
  }
  return html.slice(openingStart);
}

function yuantaLoanResultMarkup(html: string): string {
  const candidates: string[] = [];
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu)) {
    const opening = match[0];
    const tagName = match[1]?.toLowerCase();
    if (!tagName || /^(?:input|meta|link|br|hr|img)$/u.test(tagName)) continue;
    if (htmlAttribute(opening, "id").toLowerCase() !== "resultdiv") continue;
    candidates.push(
      extractBalancedHtmlElement(html, match.index ?? 0, opening),
    );
  }
  return candidates.sort((left, right) => left.length - right.length)[0] ?? "";
}

function loanPagerTarget(controlHtml: string): string | null {
  const opening = htmlControlOpeningTag(controlHtml);
  if (isDisabledHtmlControl(opening)) return null;
  const action = `${htmlAttribute(opening, "onclick")} ${htmlAttribute(opening, "href")}`;
  const pageNumber = action.match(
    /(?:goPage|setPage|currentPage|pageIndex|pageNo|pageNumber)\s*\([^)]*?(\d+)\s*\)?/iu,
  )?.[1];
  if (pageNumber) return `page:${pageNumber}`;
  const queryPage = action.match(
    /[?&#](?:page|pageNo|pageIndex)=([^&#"']+)/iu,
  )?.[1];
  if (queryPage) return `page:${queryPage}`;
  return null;
}

function isLoanNextControl(controlHtml: string): boolean {
  const opening = htmlControlOpeningTag(controlHtml);
  if (isDisabledHtmlControl(opening)) return false;
  const text = htmlControlLabel(controlHtml);
  if (!/^(?:下一頁|下頁|next(?:\s*page)?)$/iu.test(text)) return false;
  const haystack = `${opening} ${text}`;
  if (/queryMonth|menuaction/iu.test(haystack)) return false;
  const pagerTokens = [
    htmlAttribute(opening, "class"),
    htmlAttribute(opening, "id"),
  ]
    .flatMap((value) => value.split(/\s+/u))
    .map((value) => value.toLowerCase());
  return (
    loanPagerTarget(controlHtml) !== null ||
    pagerTokens.some((value) => value === "pager" || value === "pagination")
  );
}

/**
 * The Yuanta loan page is server-rendered and its terminal shape is not
 * exposed by the row parser. Keep the live probe deliberately structural:
 * this records only counts/flags needed to review pagination, never source
 * rows, account labels, or control values.
 */
const YUANTA_LOAN_TERMINAL_RULE_VERSION = "yuanta-loan-terminal-v2";

function logYuantaLoanPaginationObservation(observation: {
  resultContext: boolean;
  providerResultTable?: boolean;
  rowCount?: number;
  tableCount?: number;
  headerCellCount?: number;
  pageSize?: number | null;
  currentPageFieldCount?: number;
  pageSizeControlPresent?: boolean;
  nextControlCount?: number;
  activeNextControlCount?: number;
  disabledNextControlCount?: number;
  providerPager?: boolean;
  explicitNoNext?: boolean;
  terminal?: boolean;
  evidence?: YuantaLoanPaginationSignal["evidence"];
}): void {
  console.log("yuanta-loan-pagination-observation", {
    ruleVersion: YUANTA_LOAN_TERMINAL_RULE_VERSION,
    ...observation,
  });
}

function htmlControls(html: string): string[] {
  return [
    ...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu),
    ...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/giu),
    ...html.matchAll(/<input\b[^>]*>/giu),
  ].map((match) => match[0]);
}

function providerResultTableOpenings(html: string): string[] {
  return [...html.matchAll(/<table\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((opening) => hasHtmlClassToken(opening, "normalTable"));
}

function providerCurrentPageFieldCount(html: string): number {
  return [...html.matchAll(/<(?:input|select)\b[^>]*>/giu)].filter((match) =>
    [htmlAttribute(match[0], "id"), htmlAttribute(match[0], "name")].some(
      (value) =>
        /(?:currentPage|page(?:Index|No|Number)?|pager)/iu.test(value),
    ),
  ).length;
}

function providerPageSizeControl(html: string): {
  present: boolean;
  value: number | null;
} {
  const controls = [...html.matchAll(/<(?:input|select)\b[^>]*>/giu)].map(
    (match) => match[0],
  );
  const control = controls.find((opening) =>
    [htmlAttribute(opening, "id"), htmlAttribute(opening, "name")].some(
      (value) => /page(?:[-_:]?size)|(?:^|[-_:])size(?:$|[-_:])/iu.test(value),
    ),
  );
  if (!control) return { present: false, value: null };
  const raw = htmlAttribute(control, "value");
  return {
    present: true,
    value: /^\d+$/u.test(raw) ? Number(raw) : null,
  };
}

function providerPagerPresent(html: string): boolean {
  return [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu)].some((match) => {
    const tagName = match[1]?.toLowerCase();
    return (
      tagName !== undefined &&
      /^(?:div|span|nav|ul|ol)$/u.test(tagName) &&
      (hasHtmlClassOrIdToken(match[0], "pager") ||
        hasHtmlClassOrIdToken(match[0], "pagination"))
    );
  });
}

function explicitNoNextPresent(html: string): boolean {
  return /(?:data-(?:has-)?next|data-next-page|data-next)\s*=\s*["']?(?:false|0|none|empty)["']?/iu.test(
    html,
  );
}

/**
 * Yuanta loan results use the same pager vocabulary as the existing
 * credit-card result adapter (`下一頁`, `goPage(...)`, and page query
 * parameters).  We retain only structural page signals: an active next
 * control requests traversal, while a pager with no active next control is a
 * provider terminal signal. A result table with no pager evidence is
 * ambiguous and cannot be admitted as a complete range.
 */
export function parseYuantaLoanPaginationSignal(
  html: string,
  rowCount?: number,
  structural?: {
    providerResultTable?: boolean;
    tableCount?: number;
    headerCellCount?: number;
  },
): YuantaLoanPaginationSignal {
  const providerMarkup = yuantaLoanResultMarkup(html);
  if (!providerMarkup) {
    logYuantaLoanPaginationObservation({ resultContext: false });
    return {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    };
  }
  const controls = htmlControls(providerMarkup);
  const providerResultTableCount = providerResultTableOpenings(providerMarkup).length;
  const tableCount = structural?.tableCount ?? providerResultTableCount;
  const headerCellCount =
    structural?.headerCellCount ??
    [...providerMarkup.matchAll(/<th\b[^>]*>/giu)].length;
  const hasProviderResultTable =
    structural?.providerResultTable ?? providerResultTableCount > 0;
  const pageSize = providerPageSizeControl(providerMarkup);
  const currentPageFieldCount = providerCurrentPageFieldCount(providerMarkup);
  const hasProviderPager = providerPagerPresent(providerMarkup);
  const hasExplicitNoNext = explicitNoNextPresent(providerMarkup);
  const nextControls = controls.filter((control) =>
    /^(?:下一頁|下頁|next(?:\s*page)?)$/iu.test(htmlControlLabel(control)),
  );
  const activeNextControlCount = nextControls.filter((control) =>
    isLoanNextControl(control),
  ).length;
  const disabledNextControlCount = nextControls.filter((control) =>
    isDisabledHtmlControl(htmlControlOpeningTag(control)),
  ).length;
  const observationBase = {
    resultContext: true,
    providerResultTable: hasProviderResultTable,
    ...(rowCount === undefined ? {} : { rowCount }),
    tableCount,
    ...(headerCellCount === undefined ? {} : { headerCellCount }),
    pageSize: pageSize.value,
    currentPageFieldCount,
    pageSizeControlPresent: pageSize.present,
    nextControlCount: nextControls.length,
    activeNextControlCount,
    disabledNextControlCount,
    providerPager: hasProviderPager,
    explicitNoNext: hasExplicitNoNext,
  };
  const nextControl = controls.find((control) => isLoanNextControl(control));
  if (nextControl) {
    const nextPageTarget = loanPagerTarget(nextControl);
    logYuantaLoanPaginationObservation({
      ...observationBase,
      terminal: false,
      evidence: nextPageTarget ? "next-page" : null,
    });
    return {
      nextPageTarget,
      terminal: false,
      evidence: nextPageTarget ? "next-page" : null,
    };
  }

  const hasDisabledNext = disabledNextControlCount > 0;
  const hasProviderCurrentPage = currentPageFieldCount > 0;
  /**
   * Live Yuanta loan responses use a single six-column `normalTable` result
   * with no pager or page controls. This is a provider-specific terminal
   * contract: the parser has already validated every data row against the
   * six-cell loan layout, and an empty table is deliberately not complete.
   */
  const hasYuantaStaticResultTerminal =
    hasProviderResultTable &&
    tableCount > 0 &&
    rowCount !== undefined &&
    rowCount > 0 &&
    headerCellCount === 6 &&
    !pageSize.present &&
    currentPageFieldCount === 0 &&
    nextControls.length === 0 &&
    !hasProviderPager &&
    !hasExplicitNoNext;
  if (
    hasDisabledNext ||
    hasExplicitNoNext ||
    (hasProviderPager && hasProviderCurrentPage && nextControls.length === 0) ||
    hasYuantaStaticResultTerminal
  ) {
    logYuantaLoanPaginationObservation({
      ...observationBase,
      terminal: true,
      evidence: "terminal-no-next",
    });
    return {
      nextPageTarget: null,
      terminal: true,
      evidence: "terminal-no-next",
    };
  }

  logYuantaLoanPaginationObservation({
    ...observationBase,
    terminal: false,
    evidence: null,
  });

  return {
    nextPageTarget: null,
    terminal: false,
    evidence: null,
  };
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function maskAccountLabel(value: string): string {
  return cleanText(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
}

function isUnavailableAccountOption(value: string, label: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedLabel = cleanText(label).toLowerCase();
  if (
    !normalizedValue ||
    ["0", "-1", "none", "null", "undefined"].includes(normalizedValue)
  ) {
    return true;
  }
  return (
    /^(?:請|请)?選擇(?:貸款)?帳戶$/.test(normalizedLabel) ||
    /^(?:無|无)(?:可用)?(?:貸款)?帳戶$/.test(normalizedLabel)
  );
}

function describeDateRange(input: WorkflowInput): string {
  if (input.customDateRange) {
    return `${input.customDateRange.startDate}-${input.customDateRange.endDate}`;
  }
  return dateRangeLabels[input.dateRange];
}

function addMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), lastDay));
}

function canonicalLoanDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
} {
  if (input.customDateRange) {
    return {
      startDate: input.customDateRange.startDate.replaceAll("/", "-"),
      endDate: input.customDateRange.endDate.replaceAll("/", "-"),
    };
  }

  const months = {
    three_months: 3,
    six_months: 6,
    one_year: 12,
  }[input.dateRange];
  const today = new Date();
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = addMonthsClamped(endDate, -months);
  const format = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { startDate: format(startDate), endDate: format(endDate) };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function splitDatePair(value: string): [string, string] {
  const normalized = toAsciiDigits(cleanText(value));
  const dates = normalized.match(/\d{4}\/\d{2}\/\d{2}/g) ?? [];
  return [dates[0] ?? normalized, dates[1] ?? ""];
}

function parseDateSortValue(value: string): number | null {
  const match = toAsciiDigits(cleanText(value)).match(
    /^(\d{4})\/(\d{2})\/(\d{2})$/,
  );
  if (!match) return null;

  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isFinite(time) ? time : null;
}

/** Convert the six source cells into typed workflow rows only after enforcing
 * the exact result-row shape. Empty six-cell layout rows are ignored; a
 * non-empty row with any other shape fails closed instead of disappearing. */
export function parseYuantaLoanStatementRows(
  accountLabel: string,
  sourceRows: readonly string[][],
): StatementRow[] {
  return sourceRows.flatMap((sourceRow) => {
    const values = sourceRow.map((value) => cleanText(value));
    if (values.every((value) => value.length === 0)) return [];
    if (values.length !== sourceStatementColumnCount)
      throw new Error("Unexpected Yuanta loan result row.");

    const [transactionDate, postingDate] = splitDatePair(values[0] ?? "");
    if (
      !/^\d{4}\/\d{2}\/\d{2}$/.test(transactionDate) ||
      (postingDate.length > 0 && !/^\d{4}\/\d{2}\/\d{2}$/.test(postingDate))
    )
      throw new Error("Unexpected Yuanta loan result row.");
    const [interestStartDate, interestEndDate] = splitDatePair(values[2] ?? "");

    return [
      {
        accountLabel,
        transactionDate,
        postingDate,
        paymentItem: values[1] ?? "",
        interestStartDate,
        interestEndDate,
        transactionAmount: values[3] ?? "",
        balanceAfterTransaction: values[4] ?? "",
        overpayment: values[5] ?? "",
        sortTime: parseDateSortValue(transactionDate),
      },
    ];
  });
}

function sortedStatementRows(rows: StatementRow[]): StatementRow[] {
  return [...rows].sort((left, right) => {
    if (left.sortTime === null && right.sortTime === null) return 0;
    if (left.sortTime === null) return 1;
    if (right.sortTime === null) return -1;
    return right.sortTime - left.sortTime;
  });
}

function statementRowsToCsv(rows: StatementRow[]): string {
  return rowsToCsv([
    [...statementHeaders],
    ...sortedStatementRows(rows).map((row) => [
      row.accountLabel,
      row.transactionDate,
      row.postingDate,
      row.paymentItem,
      row.interestStartDate,
      row.interestEndDate,
      row.transactionAmount,
      row.balanceAfterTransaction,
      row.overpayment,
    ]),
  ]);
}

async function writeLoanStatementsFile(
  nextTimestamp: () => string,
  dateRange: string,
  rows: StatementRow[],
  sourceTables: SourceTable[],
): Promise<TableFile> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "yuanta-loan-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `loan-statements-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const accounts = [...new Set(sourceTables.map((source) => source.account))];

  await writeFile(csvPath, statementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaLoanStatements",
        kind: "loan-statements",
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: statementHeaders,
        accounts,
        dateRange,
        sourceTables,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    baseName,
    kind: "loan-statements",
    rowCount: rows.length,
    headers: [...statementHeaders],
    accounts,
    dateRange,
    sourceTables,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(scope.locator(selector))) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(locatorFor(scope))) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function firstVisibleLocator(
  locator: Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await locator.page().waitForTimeout(500);
  }

  throw new Error(`Could not find a visible ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function findLoanStatementForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
      const hasLoanRange = await hasAttachedLocator(
        scope.locator("#duration a").filter({ hasText: "一年" }),
      );
      if (hasAccount && hasLoanRange) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa loan statement form.");
}

async function openLoanStatementPage(page: Page): Promise<BrowserScope> {
  const existing = await findLoanStatementForm(page, 5_000).catch(() => null);
  if (existing) return existing;

  if (await clickLoanStatementLink(page, 5_000)) {
    return await findLoanStatementForm(page);
  }

  const cid = await readCurrentCid(page);
  const fmain = await waitForFrame(page, "fmain");
  await fmain.goto(
    `${BANK_ORIGIN}/nib/tx/loantransactiondetails?type=page&cid=${encodeURIComponent(
      cid,
    )}`,
    { waitUntil: "domcontentloaded" },
  );
  await settleAfterNavigation(page);

  return await findLoanStatementForm(page);
}

async function clickLoanStatementLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="loantransactiondetails"]').filter({
        hasText: /^(貸款)?繳款明細查詢$/,
      }),
    "YuanTa loan statement link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="loantransactiondetails"]').filter({
      hasText: /^(貸款)?繳款明細查詢$/,
    }),
    "YuanTa loan statement link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function readCurrentCid(page: Page): Promise<string> {
  const scope = await findScopeWithSelector(page, 'input[name="cid"]');
  const cid = await scope.locator('input[name="cid"]').first().inputValue();
  if (!cid) throw new Error("Could not read YuanTa session cid.");
  return cid;
}

async function chooseDateRange(
  page: Page,
  input: WorkflowInput,
): Promise<void> {
  const scope = await findLoanStatementForm(page);

  if (input.customDateRange) {
    const customLink = await firstVisibleLocator(
      scope.locator("#duration a").filter({ hasText: "自訂" }),
      'YuanTa loan date range link "自訂"',
    );
    await customLink.click({ force: true });
    await scope.locator("#sdate").fill(input.customDateRange.startDate);
    await scope.locator("#edate").fill(input.customDateRange.endDate);
    return;
  }

  const label = dateRangeLabels[input.dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa loan date range link "${label}"`,
  );
  await link.click({ force: true });
}

export async function readYuantaLoanAccountOptions(
  page: Page,
  _filters: string[] = [],
): Promise<LoanAccountOption[]> {
  const scope = await findLoanStatementForm(page);
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const availableAccounts: LoanAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (isUnavailableAccountOption(value, label)) continue;

    const account = { label, value };
    availableAccounts.push(account);
  }

  if (availableAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa loan account is available for this login.",
    );
  }
  // Account filters are legacy persisted UI state. Yuanta loan capture
  // always includes every visible account; provider absence is the only skip.
  return availableAccounts;
}

/**
 * The live loan statement form exposes the full 14-digit loan account in
 * both the option label and option value.  Requiring both representations to
 * agree prevents an opaque query token from being mistaken for an account.
 */
export function yuantaLoanSelectorAccountEvidence(
  account: LoanAccountOption,
): YuantaCounterpartyAccountEvidence {
  const valueDigits = account.value;
  const labelRuns =
    toAsciiDigits(account.label).match(/(?<!\d)\d{14}(?!\d)/gu) ?? [];
  if (
    !/^\d{14}$/u.test(valueDigits) ||
    labelRuns.length !== 1 ||
    labelRuns[0] !== valueDigits
  ) {
    throw new Error(
      "Yuanta loan selector did not expose one matching full 14-digit account.",
    );
  }
  return {
    rowOrdinal: 0,
    accountValue: valueDigits,
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "loan_contract",
    evidenceKind: "repayment-mandate",
    sourceField: "貸款帳號",
    contractVersion: YUANTA_LOAN_SELECTOR_ACCOUNT_MANDATE_CONTRACT_VERSION,
  };
}

async function queryLoanAccount(
  page: Page,
  input: WorkflowInput,
  account: LoanAccountOption,
): Promise<void> {
  const scope = await findLoanStatementForm(page);
  await scope.locator("#acctno").selectOption(account.value);
  await chooseDateRange(page, input);
  await clickAndWaitForNavigation(scope, "#submitbutton");
  await findScopeWithSelector(page, "#resultdiv");
}

async function parseLoanStatementRows(
  page: Page,
  accountLabel: string,
  pageOrdinal: number,
): Promise<{
  rows: StatementRow[];
  pageOrdinal: number;
  pagination: YuantaLoanPaginationSignal;
}> {
  const scope = await findScopeWithSelector(page, "#resultdiv");
  const tables = scope.locator("table.normalTable");
  const tableCount = await tables.count();
  if (tableCount === 0)
    throw new Error("Yuanta loan result is missing the source table.");

  const resultTable = tables.nth(tableCount - 1);
  await resultTable.locator("th").first().waitFor({ state: "attached" });
  const headerCellCount = await resultTable.locator("th").count();

  const rows = resultTable.locator("tr");
  const rowCount = await rows.count();
  const sourceRows: string[][] = [];

  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("td");
    const cellCount = await cells.count();

    const values: string[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(cleanText(await cells.nth(cellIndex).innerText()));
    }
    sourceRows.push(values);
  }

  const parsedRows = parseYuantaLoanStatementRows(accountLabel, sourceRows);
  const renderedHtml = await scope.locator("body").innerHTML().catch(() => "");
  return {
    rows: parsedRows,
    pageOrdinal,
    pagination: parseYuantaLoanPaginationSignal(
      renderedHtml,
      parsedRows.length,
      {
        providerResultTable: tableCount > 0,
        tableCount,
        headerCellCount,
      },
    ),
  };
}

async function findYuantaLoanNextPageControl(
  scope: BrowserScope,
): Promise<Locator | null> {
  const result = scope.locator("#resultdiv").first();
  if ((await result.count().catch(() => 0)) === 0) return null;
  const controls = result.locator("a,button,input");
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const markup = await control
      .evaluate((element) => element.outerHTML)
      .catch(() => "");
    if (markup && isLoanNextControl(markup)) return control;
  }
  return null;
}

export function assembleYuantaLoanStatement(
  pages: readonly ParsedYuantaLoanPage[],
): {
  rows: StatementRow[];
  completeness: LoanSourceCompletenessEvidence | null;
  pages: readonly LoanCapturePage[];
} {
  const terminalPage = pages.at(-1);
  const complete =
    terminalPage?.pagination.terminal === true &&
    terminalPage.pagination.evidence === "terminal-no-next" &&
    pages.every((page, index) =>
      index === pages.length - 1
        ? page.pagination.terminal
        : page.pagination.evidence === "next-page" && !page.pagination.terminal,
    );
  return {
    rows: pages.flatMap((page) => page.rows),
    completeness: complete
      ? {
          pageCount: pages.length,
          terminal: true,
          proofKind: "source-declared-terminal-range",
        }
      : null,
    pages: pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: "200",
      terminal: page.pagination.terminal,
      rowCount: page.rows.length,
      proofKind: "source-declared-terminal-range",
    })),
  };
}

type YuantaLoanCaptureForEvidence = {
  captureId: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    accountKey: string;
  };
  scope: {
    startDate: string;
    endDate: string;
  };
  records: readonly {
    sourceRecordKey: string;
    occurrenceIndex: number;
  }[];
};

function sourceRecordKeyForYuantaLoanEvidence(
  capture: YuantaLoanCaptureForEvidence,
  evidence: YuantaCounterpartyAccountEvidence,
): string {
  if (evidence.sourceRecordKey?.trim()) return evidence.sourceRecordKey.trim();
  if (evidence.rowOrdinal === undefined)
    throw new Error(
      "Yuanta loan counterparty evidence must identify a source record or row ordinal.",
    );
  if (!Number.isSafeInteger(evidence.rowOrdinal) || evidence.rowOrdinal < 0)
    throw new Error("Yuanta loan counterparty evidence row ordinal is invalid.");
  const rowOrdinal = evidence.rowOrdinal;
  const candidates = capture.records.filter(
    (record) => record.occurrenceIndex === rowOrdinal + 1,
  );
  if (candidates.length !== 1)
    throw new Error(
      "Yuanta loan counterparty evidence row does not identify exactly one canonical source record.",
    );
  return candidates[0]!.sourceRecordKey;
}

function materializeYuantaLoanCounterpartyEvidence(
  capture: YuantaLoanCaptureForEvidence,
  evidence: YuantaCounterpartyAccountEvidence,
): TransactionCounterpartyAccountEvidenceInput {
  return {
    ...evidence,
    ...(evidence.evidenceKind === "repayment-mandate" && !evidence.accountKey
      ? { accountKey: capture.identity.accountKey }
      : {}),
    ...(evidence.evidenceKind === "repayment-mandate" &&
    evidence.effectiveStartDate === undefined &&
    evidence.effectiveEndDate === undefined
      ? {
          effectiveStartDate: capture.scope.startDate,
          effectiveEndDate: capture.scope.endDate,
        }
      : {}),
    captureId: capture.captureId,
    sourceRecordKey: sourceRecordKeyForYuantaLoanEvidence(capture, evidence),
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpochKey: capture.identity.identityEpochKey,
  };
}

async function traverseYuantaLoanStatementPages(
  page: Page,
  accountLabel: string,
): Promise<ReturnType<typeof assembleYuantaLoanStatement>> {
  const pages: ParsedYuantaLoanPage[] = [];
  const fingerprints = new Set<string>();

  while (true) {
    if (pages.length >= YUANTA_LOAN_MAX_PAGES)
      throw new Error("Yuanta loan pagination exceeded the safe page limit.");
    const parsed = await parseLoanStatementRows(
      page,
      accountLabel,
      pages.length,
    );
    const fingerprint = JSON.stringify({
      rows: parsed.rows.map((row) => [
        row.transactionDate,
        row.postingDate,
        row.paymentItem,
        row.transactionAmount,
        row.balanceAfterTransaction,
      ]),
      nextPageTarget: parsed.pagination.nextPageTarget,
    });
    if (fingerprints.has(fingerprint))
      throw new Error("Yuanta loan pagination repeated a page.");
    fingerprints.add(fingerprint);
    pages.push(parsed);
    if (!parsed.pagination.nextPageTarget) break;

    const scope = await findScopeWithSelector(page, "#resultdiv");
    const nextControl = await findYuantaLoanNextPageControl(scope);
    if (!nextControl)
      throw new Error(
        "Yuanta loan pagination control disappeared before traversal.",
      );
    await nextControl.click({ force: true });
    await settleAfterNavigation(page);
    await findScopeWithSelector(page, "#resultdiv");
  }

  return assembleYuantaLoanStatement(pages);
}

export async function runYuantaLoanStatements(
  page: Page,
  input: WorkflowInput,
  overrides: YuantaLoanStatementsRunDependencies = {},
): Promise<Omit<YuantaLoanStatementsOutput, "usedExistingSession" | "replacedActiveSession">> {
  const openStatementPage =
    overrides.openLoanStatementPage ?? openLoanStatementPage;
  const readAccounts =
    overrides.readLoanAccountOptions ?? readYuantaLoanAccountOptions;
  const queryAccount = overrides.queryLoanAccount ?? queryLoanAccount;
  const traversePages =
    overrides.traverseLoanStatementPages ?? traverseYuantaLoanStatementPages;
  const write = overrides.writeLoanStatementsFile ?? writeLoanStatementsFile;
  const { sourceConnectionScope, sourceConnectionKey } =
    requireSourceConnectionIdentity("yuanta", "Yuanta loan", overrides);
  const ledgerDir =
    overrides.canonicalFinancialLedgerDir ??
    overrides.canonicalLedgerDir ??
    DEFAULT_LEDGER_DIR;
  const store = (overrides.createLoanStore ?? createCanonicalLoanStore)(
    canonicalSqlitePath(ledgerDir),
  );
  const persist = overrides.persistLoanCapture ?? persistYuantaLoanCapture;
  const observedAt = overrides.observedAt ?? (() => new Date().toISOString());
  const resolveRelations =
    overrides.resolveRelations ?? resolveLoanRepaymentRelations;
  let relationResolution: LoanRepaymentRelationResolutionResult | null = null;

  try {
    await openStatementPage(page);
    const accounts = await readAccounts(
      page,
      input.loanAccountFilters,
    );
    const rows: StatementRow[] = [];
    const sourceTables: SourceTable[] = [];
    const nextTimestamp = createTimestampGenerator();
    const dateRange = describeDateRange(input);
    const canonicalRange = canonicalLoanDateRange(input);

    for (const account of accounts) {
      const maskedAccount = maskAccountLabel(account.label);
      await queryAccount(page, input, account);
      const parsed = await traversePages(page, maskedAccount);
      if (
        !parsed.completeness ||
        parsed.pages.length !== parsed.completeness.pageCount
      ) {
        throw new Error(
          "Yuanta loan result lacks explicit complete terminal page evidence.",
        );
      }
      const accountRows = parsed.rows;
      rows.push(...accountRows);
      sourceTables.push({
        account: maskedAccount,
        rowCount: accountRows.length,
      });
      const captureInput: YuantaLoanCaptureBuildInput = {
        accountValue: account.value,
        sourceConnectionScope,
        observedAt: observedAt(),
        startDate: canonicalRange.startDate,
        endDate: canonicalRange.endDate,
        scope: {
          startDate: canonicalRange.startDate,
          endDate: canonicalRange.endDate,
          completeness: "complete-range",
          completenessBasis: "source-declared-terminal-range",
          completenessRuleVersion: "loan/canonical/v1.yuanta",
          pageCount: parsed.completeness.pageCount,
          terminal: parsed.completeness.terminal,
        },
        pages: parsed.pages,
        // The loan result has no source-linked deposit-side transaction.
        // Empty linkage arrays are therefore explicitly not asserted as
        // complete relation coverage.
        relationCoverage: "not-asserted",
        counterpartTransactions: [],
        relations: [],
        rows: accountRows.map<YuantaLoanStatementRow>((row) => ({
          transactionDate: row.transactionDate,
          postingDate: row.postingDate,
          paymentItem: row.paymentItem,
          transactionAmount: row.transactionAmount,
          balanceAfterTransaction: row.balanceAfterTransaction,
        })),
      };
      // Build once before commit so optional source evidence can refer to the
      // exact immutable source-record keys that the Yuanta adapter will
      // persist.  The core writer still owns admission and commit.
      const capture = buildYuantaLoanCapture(captureInput);
      await persist(store, captureInput);

      const sourceEvidence = overrides.readCounterpartyAccountEvidence
        ? await overrides.readCounterpartyAccountEvidence(
            page,
            account,
            accountRows,
          )
        : [yuantaLoanSelectorAccountEvidence(account)];
      for (const evidence of sourceEvidence) {
        await persistCounterpartyAccountEvidence(
          store,
          materializeYuantaLoanCounterpartyEvidence(capture, evidence),
        );
      }
      relationResolution = await resolveLoanRelationsAfterCapture(
        store,
        resolveRelations,
        {
          sourceConnectionKey,
          integrationNamespace: "yuanta",
          observedAt: capture.observedAt,
          failureEvent: "yuanta-loan-relation-resolution-failed",
          explicitLinks: overrides.explicitRelationLinks,
        },
      );
    }

    const file = await write(
      nextTimestamp,
      dateRange,
      rows,
      sourceTables,
    );

    return {
      dateRange,
      count: 1,
      files: [file],
      ...(relationResolution
        ? {
            relationResolution: {
              ...relationResolution,
              exactRelationIds: [...relationResolution.exactRelationIds],
              settlementGroupIds: [...relationResolution.settlementGroupIds],
            },
          }
        : {}),
    };
  } finally {
    store.close();
  }
}

export default workflow("yuantaLoanStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (
      input as typeof input & { credentials: YuantaCredentials }
    ).credentials;
    const sourceConnectionScope = yuantaSourceConnectionScope(credentials);
    const authResult = await sharedAuthenticateYuantaBank(
      ctx,
      credentials,
      input.replaceActiveSession,
    );
    const output = await runYuantaLoanStatements(page, input, {
      canonicalLedgerDir:
        process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
        process.env.LEDGER_DIR ??
        DEFAULT_LEDGER_DIR,
      canonicalFinancialLedgerDir:
        process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR ??
        process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR ??
        process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
        process.env.LEDGER_DIR ??
        DEFAULT_LEDGER_DIR,
      sourceConnectionScope,
      sourceConnectionKey: deriveSourceConnectionIdentityKey(
        "yuanta",
        sourceConnectionScope,
      ),
    });
    return {
      ...output,
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession: authResult.replacedActiveSession,
    };
  },
});
