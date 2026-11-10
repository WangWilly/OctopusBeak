import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { hasAttachedLocator } from "./browser-interaction.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
} from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { periodSpans, type CollectionPeriod } from "../lib/automation/collection-period.ts";
import type {
  LoanCapturePage,
  LoanSourceCompletenessEvidence,
} from "../ledger/canonical/loan-financial.ts";
import {
  YUANTA_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  assertYuantaLoanCaptureAccountNumberEvidence,
  buildYuantaLoanCapture,
} from "../ledger/canonical/yuanta-loan-admission.ts";
import type {
  YuantaLoanAccountNumberEvidence,
  YuantaLoanStatementRow,
} from "../ledger/canonical/yuanta-loan-admission.ts";
import { requireSourceConnectionIdentity } from "../ledger/canonical/source-connection-identity.ts";
import type { LoanCaptureInput } from "../ledger/canonical/loan-financial-contracts.ts";
import {
  admitLoan,
  stageCanonicalLoans,
  type LoanAdmission,
  type LoanDecision,
  type LoanRepaymentMandate,
} from "./canonical-loan-staging.ts";
import type { BrowserScope, FrameScope } from "./frame-scope.ts";
import { yuantaEbankSite, type YuantaEbankSite, type YuantaRoute } from "./yuanta-ebank-site.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";

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

export const yuantaLoanStatementsInputSchema = z.object({
  loanAccountFilters: z.array(z.string()).default([]),
});

type WorkflowInput = z.infer<typeof yuantaLoanStatementsInputSchema>;

export type YuantaLoanCollectionInput = WorkflowInput & Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: string;
}>;

/** Yuanta's quick loan ranges: the link text and the span it covers, both ends inclusive. */
const QUICK_LOAN_RANGES = [
  { label: "三個月", span: { months: 3, days: 1 } },
  { label: "六個月", span: { months: 6, days: 1 } },
  { label: "一年", span: { months: 12, days: 1 } },
] as const;

/** A loan query's dates as YYYY-MM-DD, and the quick link that covers them, if any. */
export type YuantaLoanQueryRange = Readonly<{ quickLabel?: string; startDate: string; endDate: string }>;

/** The loan query for the product's collection period; dates are entered when no quick link fits. */
export function yuantaLoanQueryRange(period: CollectionPeriod): YuantaLoanQueryRange {
  const quick = QUICK_LOAN_RANGES.find(({ span }) => periodSpans(period, span));
  return { ...(quick ? { quickLabel: quick.label } : {}), startDate: period.start, endDate: period.end };
}

const sourceStatementColumnCount = 6;

function stripHtml(value: string): string {
  return collapseSourceWhitespace(value.replace(/<[^>]*>/gu, " "));
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
    collapseSourceWhitespace(htmlAttribute(opening, "value")) ||
    collapseSourceWhitespace(htmlAttribute(opening, "aria-label"))
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
}, silent = false): void {
  if (silent) return;
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
    silent?: boolean;
  },
): YuantaLoanPaginationSignal {
  const providerMarkup = yuantaLoanResultMarkup(html);
  if (!providerMarkup) {
    logYuantaLoanPaginationObservation({ resultContext: false }, structural?.silent);
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
    }, structural?.silent);
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
    }, structural?.silent);
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
  }, structural?.silent);

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

function maskAccountLabel(value: string): string {
  return collapseSourceWhitespace(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
}

function isUnavailableAccountOption(value: string, label: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedLabel = collapseSourceWhitespace(label).toLowerCase();
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

function splitDatePair(value: string): [string, string] {
  const normalized = toAsciiDigits(collapseSourceWhitespace(value));
  const dates = normalized.match(/\d{4}\/\d{2}\/\d{2}/g) ?? [];
  return [dates[0] ?? normalized, dates[1] ?? ""];
}

function parseDateSortValue(value: string): number | null {
  const match = toAsciiDigits(collapseSourceWhitespace(value)).match(
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
    const values = sourceRow.map((value) => collapseSourceWhitespace(value));
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

/** The loan statement form: ready once one scope holds the account selector and the 一年 range link. */
async function isLoanStatementForm(scope: BrowserScope): Promise<boolean> {
  const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
  const hasLoanRange = await hasAttachedLocator(
    scope.locator("#duration a").filter({ hasText: "一年" }),
  );
  return hasAccount && hasLoanRange;
}

const LOAN_TRANSACTION_DETAILS_ROUTE: YuantaRoute = {
  path: "loantransactiondetails",
  description: "YuanTa loan statement form",
  ready: isLoanStatementForm,
};

async function findLoanStatementForm(
  site: YuantaEbankSite,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const { frames } = site;
  return await frames.until(async () => {
    for (const scope of frames.scopes()) {
      if (await isLoanStatementForm(scope)) return scope;
    }
    return null;
  }, "Could not find YuanTa loan statement form.", { timeoutMs });
}

async function chooseDateRange(
  site: YuantaEbankSite,
  { quickLabel, startDate, endDate }: YuantaLoanQueryRange,
): Promise<void> {
  const scope = await findLoanStatementForm(site);
  await site.chooseDuration(
    scope,
    quickLabel
      ? { label: quickLabel }
      : { customLabel: "自訂", startDate: startDate.replaceAll("-", "/"), endDate: endDate.replaceAll("-", "/") },
  );
}

export async function readYuantaLoanAccountOptions(
  site: YuantaEbankSite,
  _filters: string[] = [],
): Promise<LoanAccountOption[]> {
  const { frames } = site;
  const scope = await findLoanStatementForm(site);
  const options = scope.locator("#acctno option");
  const count = await frames.race(options.count());
  const availableAccounts: LoanAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await frames.withSignal((signal) => option.getAttribute("value", { signal }))) ?? "";
    const label = collapseSourceWhitespace(await frames.withSignal((signal) => option.textContent({ signal })));
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

export function deriveYuantaLoanAccountNumberEvidence(
  account: LoanAccountOption,
): YuantaLoanAccountNumberEvidence | null {
  const valueDigits = account.value.trim();
  const labelRuns =
    toAsciiDigits(account.label).match(/(?<!\d)\d{14}(?!\d)/gu) ?? [];
  if (
    !/^\d{14}$/u.test(valueDigits) ||
    labelRuns.length !== 1 ||
    labelRuns[0] !== valueDigits
  )
    return null;
  return {
    value: valueDigits,
    kind: "loan-account",
    evidenceVersion: YUANTA_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "#acctno option.value",
  };
}

/**
 * The live loan statement form exposes the full 14-digit loan account in
 * both the option label and option value.  Requiring both representations to
 * agree prevents an opaque query token from being mistaken for an account.
 */
export function yuantaLoanSelectorAccountEvidence(
  account: LoanAccountOption,
): Omit<LoanRepaymentMandate, "sourceRecordKey"> {
  const accountNumber = deriveYuantaLoanAccountNumberEvidence(account);
  if (!accountNumber) {
    throw new Error(
      "Yuanta loan selector did not expose one matching full 14-digit account.",
    );
  }
  return {
    accountValue: accountNumber.value,
    sourceField: "貸款帳號",
    contractVersion: YUANTA_LOAN_SELECTOR_ACCOUNT_MANDATE_CONTRACT_VERSION,
  };
}

async function queryLoanAccount(
  site: YuantaEbankSite,
  range: YuantaLoanQueryRange,
  account: LoanAccountOption,
): Promise<void> {
  const { frames } = site;
  const scope = await findLoanStatementForm(site);
  await frames.withSignal((signal) => scope.locator("#acctno").selectOption(account.value, { signal }));
  await chooseDateRange(site, range);
  await Promise.all([
    frames.withSignal((signal) =>
      scope.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000, signal }),
    ),
    frames.withSignal((signal) => scope.locator("#submitbutton").click({ signal })),
  ]);
  await frames.scopeWith("#resultdiv");
}

async function parseLoanStatementRows(
  site: YuantaEbankSite,
  accountLabel: string,
  pageOrdinal: number,
  options: Readonly<{ sourceText: SourceTextPort; silent?: boolean }>,
): Promise<{
  rows: StatementRow[];
  pageOrdinal: number;
  pagination: YuantaLoanPaginationSignal;
}> {
  const { frames } = site;
  const scope = await frames.scopeWith("#resultdiv");
  const tables = scope.locator("table.normalTable");
  const tableCount = await frames.race(tables.count());
  if (tableCount === 0)
    throw new Error("Yuanta loan result is missing the source table.");

  const resultTable = tables.nth(tableCount - 1);
  await frames.withSignal((signal) => resultTable.locator("th").first().waitFor({ state: "attached", signal }));
  const headerCellCount = await frames.race(resultTable.locator("th").count());

  const rows = resultTable.locator("tr");
  const rowCount = await frames.race(rows.count());
  const sourceRows: string[][] = [];

  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("td");
    const cellCount = await frames.race(cells.count());

    const values: string[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(collapseSourceWhitespace(await frames.withSignal((signal) => cells.nth(cellIndex).innerText({ signal }))));
    }
    sourceRows.push(values);
  }

  const parsedRows = parseYuantaLoanStatementRows(accountLabel, sourceRows);
  const renderedHtml = await frames.withSignal((signal) => scope.locator("body").innerHTML({ signal }));
  options.sourceText.assertIntact(renderedHtml);
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
        silent: options.silent,
      },
    ),
  };
}

async function findYuantaLoanNextPageControl(
  frames: FrameScope,
  scope: BrowserScope,
): Promise<Locator | null> {
  const result = scope.locator("#resultdiv").first();
  if ((await result.count().catch(() => 0)) === 0) return null;
  const controls = result.locator("a,button,input");
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const markup = await frames.race(
      control.evaluate((element) => element.outerHTML).catch(() => ""),
    );
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

/** The selector account is account-level evidence, anchored to the capture's first source row. */
function yuantaLoanMandateSourceRecordKey(capture: LoanCaptureInput): string {
  const candidates = capture.records.filter((record) => record.sourceSequenceIndex === 1);
  if (candidates.length !== 1)
    throw new Error(
      "Yuanta loan counterparty evidence row does not identify exactly one canonical source record.",
    );
  return candidates[0]!.sourceRecordKey;
}

/** The markup of the first #resultdiv in the scope, read without waiting for one to attach. */
async function readYuantaLoanResultMarkup(scope: BrowserScope): Promise<string | null> {
  return await scope
    .evaluate(() => document.querySelector("#resultdiv")?.innerHTML ?? null)
    .catch(() => null);
}

async function traverseYuantaLoanStatementPages(
  site: YuantaEbankSite,
  accountLabel: string,
  options: Readonly<{ sourceText: SourceTextPort; silent?: boolean }>,
): Promise<ReturnType<typeof assembleYuantaLoanStatement>> {
  const { frames } = site;
  const pages: ParsedYuantaLoanPage[] = [];
  const fingerprints = new Set<string>();

  while (true) {
    frames.signal.throwIfAborted();
    if (pages.length >= YUANTA_LOAN_MAX_PAGES)
      throw new Error("Yuanta loan pagination exceeded the safe page limit.");
    const parsed = await parseLoanStatementRows(
      site,
      accountLabel,
      pages.length,
      options,
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

    const scope = await frames.scopeWith("#resultdiv");
    const nextControl = await findYuantaLoanNextPageControl(frames, scope);
    if (!nextControl)
      throw new Error(
        "Yuanta loan pagination control disappeared before traversal.",
      );
    const previousResult = await frames.race(readYuantaLoanResultMarkup(scope));
    await frames.withSignal((signal) => nextControl.click({ force: true, signal }));
    await frames.settle();
    await frames.until(async () => {
      for (const candidate of frames.scopes()) {
        const result = await readYuantaLoanResultMarkup(candidate);
        if (result !== null && result !== previousResult) return true;
      }
      return false;
    }, "Yuanta loan next page did not replace the previous result.");
  }

  return assembleYuantaLoanStatement(pages);
}

export type YuantaLoanStatementRead = Readonly<{
  account: LoanAccountOption;
  statement: ReturnType<typeof assembleYuantaLoanStatement>;
  /** When the account's traversal finished; its capture is observed then. */
  observedAt: string;
}>;

export type YuantaLoanSourceSnapshot = Readonly<{
  /** The canonical range of the query, fixed before the first account is read. */
  range: Readonly<{ startDate: string; endDate: string }>;
  accounts: readonly YuantaLoanStatementRead[];
}>;

/** Read every loan account's statement pages over the requested range (ADR 0065). */
export async function readYuantaLoanSource(
  page: Page,
  input: YuantaLoanCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<YuantaLoanSourceSnapshot> {
  const { signal, text: sourceText } = context;
  signal.throwIfAborted();
  const range = yuantaLoanQueryRange(product.collectionPeriod());
  const site = yuantaEbankSite(page, context);
  await site.open(LOAN_TRANSACTION_DETAILS_ROUTE);
  signal.throwIfAborted();
  const accounts: YuantaLoanStatementRead[] = [];
  for (const account of await readYuantaLoanAccountOptions(site, input.loanAccountFilters)) {
    signal.throwIfAborted();
    await product.reportActivity("query");
    await queryLoanAccount(site, range, account);
    signal.throwIfAborted();
    await product.reportActivity("query");
    const statement = await traverseYuantaLoanStatementPages(site, maskAccountLabel(account.label), {
      sourceText,
      silent: true,
    });
    sourceText.assertIntact(
      JSON.stringify({ account: account.label, rows: statement.rows }),
    );
    accounts.push({ account, statement, observedAt: context.now() });
  }
  return { range, accounts };
}

function admitYuantaLoan(
  { account, statement: parsed, observedAt }: YuantaLoanStatementRead,
  range: YuantaLoanSourceSnapshot["range"],
  identity: Readonly<{ sourceConnectionScope: string; sourceConnectionKey: string }>,
): LoanDecision {
  if (
    !parsed.completeness ||
    parsed.pages.length !== parsed.completeness.pageCount
  ) {
    throw new Error(
      "Yuanta loan result lacks explicit complete terminal page evidence.",
    );
  }
  const accountNumber = deriveYuantaLoanAccountNumberEvidence(account);
  const capture = buildYuantaLoanCapture({
    accountValue: account.value,
    ...(accountNumber ? { accountNumber } : {}),
    sourceConnectionScope: identity.sourceConnectionScope,
    observedAt,
    startDate: range.startDate,
    endDate: range.endDate,
    scope: {
      startDate: range.startDate,
      endDate: range.endDate,
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
    rows: parsed.rows.map<YuantaLoanStatementRow>((row) => ({
      transactionDate: row.transactionDate,
      postingDate: row.postingDate,
      paymentItem: row.paymentItem,
      transactionAmount: row.transactionAmount,
      balanceAfterTransaction: row.balanceAfterTransaction,
    })),
  });
  assertYuantaLoanCaptureAccountNumberEvidence(capture);
  return {
    capture,
    sourceConnectionKey: identity.sourceConnectionKey,
    integrationNamespace: "yuanta",
    repaymentMandate: {
      ...yuantaLoanSelectorAccountEvidence(account),
      sourceRecordKey: yuantaLoanMandateSourceRecordKey(capture),
    },
  };
}

/** Admit and stage one loan capture per account from a read snapshot. */
export async function stageYuantaLoan(
  snapshot: YuantaLoanSourceSnapshot,
  input: YuantaLoanCollectionInput,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  const identity = requireSourceConnectionIdentity("yuanta", "Yuanta loan", input);
  const admissions: LoanAdmission[] = [];
  for (const account of snapshot.accounts) {
    product.signal.throwIfAborted();
    admissions.push(await admitLoan(product, () => admitYuantaLoan(account, snapshot.range, identity)));
  }
  stageCanonicalLoans(product, admissions);
  return {
    sourceCaptureCount: snapshot.accounts.length,
    rowCount: snapshot.accounts.reduce((count, { statement }) => count + statement.rows.length, 0),
  };
}

export async function runYuantaLoanStatements(
  page: Page,
  input: YuantaLoanCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  requireSourceConnectionIdentity("yuanta", "Yuanta loan", input);
  const snapshot = await readYuantaLoanSource(page, input, context, product);
  return await stageYuantaLoan(snapshot, input, product);
}
