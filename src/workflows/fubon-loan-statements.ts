import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import type {
  LoanCapturePage,
  LoanSourceCompletenessEvidence,
} from "../ledger/canonical/loan-financial-contracts.ts";
import { FUBON_LOAN_CONTRACT_VERSION } from "../ledger/canonical/loan-admission.ts";
import { requireSourceConnectionIdentity } from "../ledger/canonical/source-connection-identity.ts";
import {
  FUBON_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  assertFubonLoanCaptureAccountNumberEvidence,
  buildFubonLoanCapture,
  type FubonLoanCaptureBuildInput,
  type FubonLoanAccountNumberEvidence,
  type FubonLoanStatementRow,
} from "../ledger/canonical/fubon-loan-admission.ts";
import {
  fillInputWithoutPointer,
  selectOptionWithoutPointer,
} from "./browser-interaction.ts";
import type { BrowserScope } from "./frame-scope.ts";
import { fubonEbankSite, type FubonEbankSite, type FubonRoute } from "./fubon-ebank-site.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import { periodSpans, type CollectionPeriod } from "../lib/automation/collection-period.ts";

const LOAN_ACCOUNT_SELECTOR = "#form1\\:loanAccountCombo";
const LOAN_FORM_SELECTOR = "form#form1";

const attached = async (locator: Locator) => (await locator.count().catch(() => 0)) > 0;

/**
 * The bank's 貸款交易明細查詢 task, revealed by the 貸款服務 header menu. Its link
 * is clicked in place: navigating a frame to its href loses the bank's 302
 * hand-off and can wait forever for a document the bank never exposes.
 */
const LOAN_STATEMENTS_ROUTE: FubonRoute = {
  description: "loan statement page",
  link: (scope) => [
    scope.locator("a.task_CLNQU001.menu_CLN02"),
    scope.locator("a").filter({ hasText: "貸款交易明細查詢" }),
  ],
  menu: "#menu_CLN",
  clickInPlace: true,
  ready: async (scope) =>
    (await attached(scope.locator(LOAN_ACCOUNT_SELECTOR))) &&
    (await attached(scope.locator(LOAN_FORM_SELECTOR))),
};

const queryItemSchema = z.enum([
  "TRANSACTION_DETAIL_QUERY",
  "PARTLY_PAID_TRANSACTION_DETAIL_QUERY",
  "DATES_DETAIL_QUERY",
  "DYNAMIC_BRANCH_DETAIL_QUERY",
]);

type QueryItem = z.infer<typeof queryItemSchema>;

const DEFAULT_QUERY_ITEMS: QueryItem[] = ["TRANSACTION_DETAIL_QUERY"];
const SUPPORTED_NORMALIZED_QUERY_ITEM: QueryItem = "TRANSACTION_DETAIL_QUERY";

/** Fubon's quick loan periods: the option value and the span it covers, both ends inclusive. */
const QUICK_LOAN_PERIODS = [
  { quickMonths: "1", span: { months: 1, days: 1 } },
  { quickMonths: "3", span: { months: 3, days: 1 } },
  { quickMonths: "6", span: { months: 6, days: 1 } },
] as const;

/** One loan query: a quick option when one covers the period exactly, and its dates as YYYY/MM/DD. */
export type FubonLoanQuery = Readonly<{
  quickMonths?: (typeof QUICK_LOAN_PERIODS)[number]["quickMonths"];
  startDate: string;
  endDate: string;
}>;

/** The loan query for the product's collection period; dates are entered when no quick option fits. */
export function fubonLoanQuery(period: CollectionPeriod): FubonLoanQuery {
  const quick = QUICK_LOAN_PERIODS.find(({ span }) => periodSpans(period, span));
  return {
    ...(quick ? { quickMonths: quick.quickMonths } : {}),
    startDate: period.start.replaceAll("-", "/"),
    endDate: period.end.replaceAll("-", "/"),
  };
}

const inputSchema = z.object({
  loanAccountLabels: z.array(z.string()).default([]),
  queryItem: queryItemSchema.optional(),
  queryItems: z.array(queryItemSchema).optional(),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]).default("EXCEL"),
});

export { inputSchema as fubonLoanStatementsInputSchema };

export type FubonLoanStatementsInput = z.infer<typeof inputSchema>;

export type FubonLoanProductInput = FubonLoanStatementsInput & Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: string;
}>;

const FUBON_LOAN_MAX_PAGES = 10_000;
export const FUBON_LOAN_ACCOUNT_MANDATE_CONTRACT_VERSION =
  "fubon/loan-account-as-repayment-destination/v1" as const;

/**
 * The live selector uses an opaque option value while its visible label owns
 * the full 14-digit loan account followed by a parenthesized loan type. Keep
 * identity on the opaque option value, but retain the exact visible account
 * as repayment evidence when (and only when) that verified shape is present.
 */
export function extractFubonLoanAccountEvidence(
  _optionValue: string,
  optionLabel: string,
): string | null {
  const label = cleanText(optionLabel);
  if (!label || /[*xX•]/u.test(label)) return null;
  return label.match(/^(\d{14})\s*[（(][^()（）]+[）)]$/u)?.[1] ?? null;
}

export function deriveFubonLoanAccountNumberEvidence(
  account: LoanAccountOption,
): FubonLoanAccountNumberEvidence | null {
  const value = extractFubonLoanAccountEvidence(account.value, account.label);
  return value
    ? {
        value,
        kind: "loan-account",
        evidenceVersion: FUBON_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
        sourceField: "form1:loanAccountCombo option.text",
      }
    : null;
}

export type FubonLoanPaginationSignal = {
  nextPage: string | null;
  pageFieldName: string | null;
  terminal: boolean;
  evidence: "next-page" | "terminal-no-next" | null;
};

type ParsedFubonLoanPage = {
  accountType: string;
  branchName: string;
  currency: string;
  rows: string[][];
  pageOrdinal: number;
  pagination: FubonLoanPaginationSignal;
};

type ParsedLoanStatement = {
  loanAccount: string;
  accountNumber?: FubonLoanAccountNumberEvidence;
  loanAccountId: string;
  sourceAccountValue: string;
  queryPeriod: string;
  branchName: string;
  accountType: string;
  currency: string;
  rows: string[][];
  completeness: LoanSourceCompletenessEvidence | null;
  pages: readonly LoanCapturePage[];
};

const loanHeaders = [
  "交易日期",
  "交易內容",
  "異動金額",
  "利率",
  "計息起日",
  "計息止日",
  "餘額",
  "備註",
];

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
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
    ...html
      .slice(openingStart)
      .matchAll(new RegExp("<\\/?" + tagName + "\\b[^>]*>", "giu")),
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

function fubonLoanResultContext(html: string): {
  markup: string;
  gridPrefix: string;
  rowCount: number;
  pageSize: number | null;
  currentPageFieldCount: number;
  pageSizeControlPresent: boolean;
  providerResultTable: boolean;
} | null {
  for (const match of html.matchAll(/<(?:table|tbody)\b[^>]*>/giu)) {
    const opening = match[0];
    const tableId = htmlAttribute(opening, "id");
    const table = extractBalancedHtmlElement(html, match.index ?? 0, opening);
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)];
    const exactHeaderRowIndex = rows.findIndex((row) => {
      const headers = [
        ...(row[1] ?? "").matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/giu),
      ].map((cell) => stripHtml(cell[1] ?? "").replace(/\s+/gu, ""));
      return (
        headers.length === loanHeaders.length &&
        headers.every(
          (header, index) =>
            header === loanHeaders[index]?.replace(/\s+/gu, ""),
        )
      );
    });
    const providerResultTable =
      hasHtmlClassToken(opening, "tb1") &&
      hasHtmlClassToken(opening, "queryResult");
    const providerHeaderRowIndex = providerResultTable
      ? rows.findIndex(
          (row) =>
            [...(row[1] ?? "").matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/giu)]
              .length === loanHeaders.length,
        )
      : -1;
    const headerRowIndex =
      exactHeaderRowIndex >= 0 ? exactHeaderRowIndex : providerHeaderRowIndex;
    if (headerRowIndex < 0) continue;
    const explicitGridPrefix =
      tableId.match(/^(.*?)_DataGridBody(?:\b|_)/iu)?.[1] ?? "";
    const currentPageFields = [...html.matchAll(/<(?:input|select)\b[^>]*>/giu)]
      .flatMap((control) => [
        htmlAttribute(control[0], "name"),
        htmlAttribute(control[0], "id"),
      ])
      .filter((value) => /(?:\b|:|_)dataGridCurrentPage$/iu.test(value));
    const inferredPageField = currentPageFields
      .map((value) => ({
        value,
        prefix: value.replace(/(?::|_)dataGridCurrentPage$/iu, ""),
      }))
      .sort((left, right) => {
        const shared = (value: string) => {
          let index = 0;
          while (index < value.length && value[index] === tableId[index])
            index += 1;
          return index;
        };
        return shared(right.prefix) - shared(left.prefix);
      })[0];
    const gridPrefix = explicitGridPrefix || inferredPageField?.prefix || "";
    if (!gridPrefix) continue;
    const fieldPattern = gridPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pageSizeControl =
      [
        ...html.matchAll(/<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>/giu),
      ].find((control) => {
        const opening =
          control[0].match(/^<(?:input|select)\b[^>]*>/iu)?.[0] ?? "";
        const idOrName = `${htmlAttribute(opening, "id")} ${htmlAttribute(opening, "name")}`;
        return new RegExp(
          `${fieldPattern}(?::|_)dataGridCurrentPageSize\\b`,
          "u",
        ).test(idOrName);
      })?.[0] ?? "";
    const pageSizeOpening =
      pageSizeControl.match(/^<(?:input|select)\b[^>]*>/iu)?.[0] ?? "";
    const selectedOption = [
      ...pageSizeControl.matchAll(/<option\b[^>]*>/giu),
    ].find((option) => hasHtmlBooleanAttribute(option[0], "selected"))?.[0];
    const rawPageSize =
      htmlAttribute(pageSizeOpening, "value") ||
      (selectedOption ? htmlAttribute(selectedOption, "value") : "");
    const pageSize = /^\d+$/u.test(rawPageSize) ? Number(rawPageSize) : null;
    const formStart = html.lastIndexOf("<form", match.index ?? 0);
    const formOpening =
      formStart >= 0
        ? html.slice(formStart).match(/^<form\b[^>]*>/iu)?.[0]
        : undefined;
    const markup = formOpening
      ? extractBalancedHtmlElement(html, formStart, formOpening)
      : html;
    return {
      markup,
      gridPrefix,
      rowCount: Math.max(0, rows.length - headerRowIndex - 1),
      pageSize:
        Number.isSafeInteger(pageSize) && pageSize! > 0 ? pageSize : null,
      currentPageFieldCount: currentPageFields.length,
      pageSizeControlPresent: pageSizeControl.length > 0,
      providerResultTable,
    };
  }
  return null;
}

/**
 * v2 is the live-verified terminal shape for the Fubon loan result page:
 * the provider result table has real rows and a current-page field, but the
 * provider omits page-size, pager, and next-page controls. This is deliberately
 * narrower than treating every response without a next link as complete.
 */
const FUBON_LOAN_TERMINAL_RULE_VERSION = "fubon-loan-terminal-v2";

function logFubonLoanPaginationObservation(observation: {
  resultContext: boolean;
  rowCount?: number;
  pageSize?: number | null;
  currentPageFieldCount?: number;
  pageSizeControlPresent?: boolean;
  providerResultTable?: boolean;
  nextControlCount?: number;
  activeNextControlCount?: number;
  disabledNextControlCount?: number;
  providerPager?: boolean;
  explicitNoNext?: boolean;
  nextPage?: number | null;
  terminal?: boolean;
  evidence?: FubonLoanPaginationSignal["evidence"];
}, silent = false): void {
  if (!silent) console.log("fubon-loan-pagination-observation", {
    ruleVersion: FUBON_LOAN_TERMINAL_RULE_VERSION,
    ...observation,
  });
}

/**
 * Fubon statement pages expose pagination through the same JS postback
 * control used by the deposit workflow (`setDataGridCurrentPage`).  A loan
 * response is complete only when that provider signal either supplies the
 * next page request or exposes the current-page state with no active next
 * control.  An unrelated result table, an absent marker, or a malformed
 * next-page action remains ambiguous and fails closed.
 */
export function parseFubonLoanPaginationSignal(
  html: string,
  options: Readonly<{ silent?: boolean }> = {},
): FubonLoanPaginationSignal {
  const context = fubonLoanResultContext(html);
  if (!context) {
    logFubonLoanPaginationObservation({ resultContext: false }, options.silent);
    return {
      nextPage: null,
      pageFieldName: null,
      terminal: false,
      evidence: null,
    };
  }
  const fieldPattern = context.gridPrefix.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const pageFieldPattern = new RegExp(
    `^${fieldPattern}(?::|_)dataGridCurrentPage$`,
    "u",
  );
  const links = [...context.markup.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu)].map(
    (match) => {
      const markup = match[0];
      const opening = markup.match(/^<a\b[^>]*>/iu)?.[0] ?? "";
      return {
        opening,
        text: stripHtml(markup),
        onclick: htmlAttribute(opening, "onclick"),
      };
    },
  );
  const nextLinks = links.filter((link) =>
    /^(?:下一頁|下頁)$/u.test(link.text),
  );
  const activeNext = nextLinks.find(
    (link) =>
      !isDisabledHtmlControl(link.opening) &&
      /setDataGridCurrentPage/iu.test(link.onclick),
  );
  if (activeNext) {
    const nextMatch = activeNext.onclick.match(
      /setDataGridCurrentPage\([^,]+,\s*(\d+),\s*["']([^"']+)["']/iu,
    );
    if (nextMatch?.[1] && nextMatch[2] && pageFieldPattern.test(nextMatch[2])) {
      logFubonLoanPaginationObservation({
        resultContext: true,
        rowCount: context.rowCount,
        pageSize: context.pageSize,
        currentPageFieldCount: context.currentPageFieldCount,
        pageSizeControlPresent: context.pageSizeControlPresent,
        providerResultTable: context.providerResultTable,
        nextControlCount: nextLinks.length,
        activeNextControlCount: 1,
        disabledNextControlCount: nextLinks.filter((link) =>
          isDisabledHtmlControl(link.opening),
        ).length,
        nextPage: Number(nextMatch[1]),
        terminal: false,
        evidence: "next-page",
      }, options.silent);
      return {
        nextPage: nextMatch[1],
        pageFieldName: nextMatch[2],
        terminal: false,
        evidence: "next-page",
      };
    }
    logFubonLoanPaginationObservation({
      resultContext: true,
      rowCount: context.rowCount,
      pageSize: context.pageSize,
      currentPageFieldCount: context.currentPageFieldCount,
      pageSizeControlPresent: context.pageSizeControlPresent,
      providerResultTable: context.providerResultTable,
      nextControlCount: nextLinks.length,
      activeNextControlCount: 0,
      disabledNextControlCount: nextLinks.filter((link) =>
        isDisabledHtmlControl(link.opening),
      ).length,
      terminal: false,
      evidence: null,
    }, options.silent);
    return {
      nextPage: null,
      pageFieldName: null,
      terminal: false,
      evidence: null,
    };
  }

  const hasCurrentPageField = [
    ...context.markup.matchAll(/<(?:input|select)\b[^>]*>/giu),
  ].some((control) =>
    [htmlAttribute(control[0], "id"), htmlAttribute(control[0], "name")].some(
      (value) => pageFieldPattern.test(value),
    ),
  );
  // The live provider renders its current-page control outside the form that
  // contains the result table. `fubonLoanResultContext` intentionally counts
  // those controls from the complete response, but the scoped markup above is
  // still the signal used by the generic/legacy terminal branches.
  const hasGlobalCurrentPageField = context.currentPageFieldCount > 0;
  const hasProviderPager = [
    ...context.markup.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu),
  ].some((match) => {
    const tagName = match[1]?.toLowerCase();
    return (
      tagName !== undefined &&
      /^(?:div|span|nav|ul|ol)$/u.test(tagName) &&
      (hasHtmlClassOrIdToken(match[0], "pager") ||
        hasHtmlClassOrIdToken(match[0], "pagination"))
    );
  });
  const hasExplicitNoNext =
    /(?:data-(?:has-)?next|data-next-page|data-next)\s*=\s*["']?(?:false|0|none|empty)["']?/iu.test(
      context.markup,
    );
  const hasDisabledNext = nextLinks.some((link) =>
    isDisabledHtmlControl(link.opening),
  );
  const hasProviderStaticResultTerminal =
    context.providerResultTable &&
    hasGlobalCurrentPageField &&
    context.rowCount > 0 &&
    !context.pageSizeControlPresent &&
    nextLinks.length === 0 &&
    !hasProviderPager &&
    !hasExplicitNoNext;
  const hasLegacyTerminalEvidence =
    hasCurrentPageField &&
    (hasDisabledNext ||
      hasExplicitNoNext ||
      (hasProviderPager && nextLinks.length === 0) ||
      (context.pageSize !== null && context.rowCount < context.pageSize));
  if (hasLegacyTerminalEvidence || hasProviderStaticResultTerminal) {
    logFubonLoanPaginationObservation({
      resultContext: true,
      rowCount: context.rowCount,
      pageSize: context.pageSize,
      currentPageFieldCount: context.currentPageFieldCount,
      pageSizeControlPresent: context.pageSizeControlPresent,
      providerResultTable: context.providerResultTable,
      nextControlCount: nextLinks.length,
      activeNextControlCount: 0,
      disabledNextControlCount: nextLinks.filter((link) =>
        isDisabledHtmlControl(link.opening),
      ).length,
      providerPager: hasProviderPager,
      explicitNoNext: hasExplicitNoNext,
      terminal: true,
      evidence: "terminal-no-next",
    }, options.silent);
    return {
      nextPage: null,
      pageFieldName: null,
      terminal: true,
      evidence: "terminal-no-next",
    };
  }

  logFubonLoanPaginationObservation({
    resultContext: true,
    rowCount: context.rowCount,
    pageSize: context.pageSize,
    currentPageFieldCount: context.currentPageFieldCount,
    pageSizeControlPresent: context.pageSizeControlPresent,
    providerResultTable: context.providerResultTable,
    nextControlCount: nextLinks.length,
    activeNextControlCount: 0,
    disabledNextControlCount: nextLinks.filter((link) =>
      isDisabledHtmlControl(link.opening),
    ).length,
    providerPager: hasProviderPager,
    explicitNoNext: hasExplicitNoNext,
    terminal: false,
    evidence: null,
  }, options.silent);

  return {
    nextPage: null,
    pageFieldName: null,
    terminal: false,
    evidence: null,
  };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function safeLoanAccountIdFallback(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function loanAccountIdFor(loanAccount: string, fallback: string): string {
  const loanAccountPrefix = loanAccount.split(/[（(]/)[0] ?? loanAccount;
  const fallbackPrefix = fallback.split(/[（(]/)[0] ?? fallback;
  return (
    digitsOnly(loanAccountPrefix) ||
    digitsOnly(fallbackPrefix) ||
    safeLoanAccountIdFallback(fallback)
  );
}

/** Validate the provider's tabular result before any row is admitted. Empty
 * layout rows are harmless; every non-empty result row must be the exact
 * eight-column source shape and start with a source transaction date. */
export function parseFubonLoanStatementRows(
  sourceRows: readonly string[][],
): string[][] {
  return sourceRows.flatMap((sourceRow) => {
    const row = sourceRow.map((value) => cleanText(value));
    if (row.every((value) => value.length === 0)) return [];
    if (
      row.length !== loanHeaders.length ||
      !/^\d{4}\/\d{2}\/\d{2}$/.test(row[0] ?? "")
    )
      throw new Error("Unexpected Fubon loan result row.");
    return [row];
  });
}

function matchesFilter(value: string, filters: string[]): boolean {
  if (filters.length === 0) return true;

  const normalizedValue = value.toLowerCase();
  const valueDigits = digitsOnly(value);

  return filters.some((filter) => {
    const normalizedFilter = filter.toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && valueDigits.endsWith(filterDigits))
    );
  });
}

function loanResultTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "交易日期" })
    .filter({ hasText: "異動金額" })
    .filter({ hasText: "餘額" })
    .first();
}

type LoanAccountOption = {
  label: string;
  value: string;
};

function requestedQueryItems(input: FubonLoanStatementsInput): QueryItem[] {
  const requested =
    input.queryItems && input.queryItems.length > 0
      ? input.queryItems
      : input.queryItem
        ? [input.queryItem]
        : DEFAULT_QUERY_ITEMS;
  const unsupported = requested.filter(
    (queryItem) => queryItem !== SUPPORTED_NORMALIZED_QUERY_ITEM,
  );
  if (unsupported.length > 0) {
    throw new Error(
      `fubon-loan-statements normalized output only supports ${SUPPORTED_NORMALIZED_QUERY_ITEM}; unsupported query items: ${unsupported.join(
        ", ",
      )}`,
    );
  }

  return requested;
}

function hasExplicitQueryItems(input: FubonLoanStatementsInput): boolean {
  return Boolean(
    input.queryItem || (input.queryItems && input.queryItems.length > 0),
  );
}

async function readLoanAccountOptions(
  site: FubonEbankSite,
  scope: BrowserScope,
  filters: string[],
): Promise<LoanAccountOption[]> {
  const { frames } = site;
  const combo = scope.locator(LOAN_ACCOUNT_SELECTOR);
  await frames.race(
    combo.locator("option").first().waitFor({
      state: "attached",
      timeout: 60_000,
    }),
  );

  const options = combo.locator("option");
  const count = await frames.race(options.count());
  const result: LoanAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = cleanText(await frames.race(option.getAttribute("value")));
    const label = cleanText(await frames.race(option.textContent()));
    if (!value || value === "none" || !label) continue;
    if (!matchesFilter(label, filters)) continue;
    result.push({ label, value });
  }

  if (result.length === 0) {
    throw new StatementComponentAbsentError(
      "No Fubon loan account is available for this login.",
    );
  }

  return result;
}

async function selectLoanAccount(
  site: FubonEbankSite,
  account: LoanAccountOption,
): Promise<BrowserScope> {
  const scope = await site.frames.scopeWith(LOAN_ACCOUNT_SELECTOR);
  await site.waitForMaskToClear();

  await site.frames.race(
    selectOptionWithoutPointer(scope.locator(LOAN_ACCOUNT_SELECTOR), account.value),
  );
  await site.waitForMaskToClear();

  return await site.frames.scopeWith("#form1\\:queryItemCombo");
}

async function readAvailableLoanQueryItems(
  site: FubonEbankSite,
  scope: BrowserScope,
): Promise<QueryItem[]> {
  const { frames } = site;
  const combo = scope.locator("#form1\\:queryItemCombo");
  await frames.race(
    combo.locator("option").first().waitFor({
      state: "attached",
      timeout: 60_000,
    }),
  );

  const options = combo.locator("option");
  const count = await frames.race(options.count());
  const result: QueryItem[] = [];

  for (let index = 0; index < count; index += 1) {
    const value = cleanText(
      await frames.race(options.nth(index).getAttribute("value")),
    );
    const parsed = queryItemSchema.safeParse(value);
    if (parsed.success && !result.includes(parsed.data)) {
      result.push(parsed.data);
    }
  }

  return result;
}

async function configureLoanQuery(
  site: FubonEbankSite,
  query: FubonLoanQuery,
  queryItem: QueryItem,
): Promise<BrowserScope> {
  const { frames } = site;
  const scope = await frames.scopeWith("#form1\\:queryItemCombo");
  const availableQueryItems = await readAvailableLoanQueryItems(site, scope);
  if (!availableQueryItems.includes(queryItem)) {
    throw new Error(
      `Loan query item is not available for this account: ${queryItem}`,
    );
  }

  await frames.race(
    selectOptionWithoutPointer(scope.locator("#form1\\:queryItemCombo"), queryItem),
  );
  await site.waitForMaskToClear();

  if (query.quickMonths) {
    await site.activate(scope.locator('input.queryPeriod[value="quick"]'));
    await site.activate(
      scope.locator(`input.quickKind[value="${query.quickMonths}"]`),
    );
  } else {
    await site.activate(scope.locator('input.queryPeriod[value="custom"]'));
    await frames.race(
      fillInputWithoutPointer(
        scope.locator("#form1\\:startDate"),
        query.startDate,
      ),
    );
    await frames.race(
      fillInputWithoutPointer(
        scope.locator("#form1\\:endDate"),
        query.endDate,
      ),
    );
  }

  return scope;
}

async function parseLoanStatementHtml(
  site: FubonEbankSite,
  html: string,
  pageOrdinal: number,
  silent = false,
): Promise<ParsedFubonLoanPage> {
  const parsed = (await site.frames.race(site.frames.page.evaluate(
    ({ html: sourceHtml, headers }) => {
      const clean = (value: string | null | undefined) =>
        (value ?? "")
          .replace(/[\u00a0\u3000]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const cellsFor = (row: Element) =>
        Array.from(row.querySelectorAll("th,td")).map((cell) =>
          clean(cell.textContent),
        );
      const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
      const tableRows = Array.from(doc.querySelectorAll("table"))
        .map((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) => cellsFor(row)),
        )
        .find((rows) =>
          rows.some((row) =>
            headers.every((header, index) =>
              clean(row[index]).includes(header),
            ),
          ),
        );
      if (!tableRows) {
        throw new Error("Loan query response is missing the result table.");
      }

      const headerRowIndex = tableRows.findIndex((row) =>
        headers.every((header, index) => clean(row[index]).includes(header)),
      );
      const rows = tableRows
        .slice(headerRowIndex + 1)
        .map((row) => {
          const normalized = row.map((value) => clean(value));
          if (normalized.every((value) => value.length === 0)) return [];
          if (
            normalized.length !== headers.length ||
            !/^\d{4}\/\d{2}\/\d{2}$/.test(normalized[0] ?? "")
          )
            throw new Error("Unexpected Fubon loan result row.");
          return [normalized];
        })
        .flat();
      const metadataRows = Array.from(doc.querySelectorAll("table"))
        .map((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) => cellsFor(row)),
        )
        .find(
          (rows) =>
            rows.some((row) => row.includes("分行名稱")) &&
            rows.some((row) => row.includes("幣別")),
        );
      const metadataValue = (label: string) => {
        for (const row of metadataRows ?? []) {
          const index = row.findIndex((cell) => clean(cell) === label);
          if (index !== -1) return clean(row[index + 1]);
        }
        return "";
      };

      return {
        accountType: metadataValue("帳號類別"),
        branchName: metadataValue("分行名稱"),
        currency: metadataValue("幣別"),
        rows,
      };
    },
    { html, headers: loanHeaders },
  ))) as {
    accountType: string;
    branchName: string;
    currency: string;
    rows: string[][];
  };

  const pagination = parseFubonLoanPaginationSignal(html, { silent });
  return {
    accountType: parsed.accountType,
    branchName: parsed.branchName,
    currency: parsed.currency,
    rows: parsed.rows,
    pageOrdinal,
    pagination,
  };
}

async function fetchLoanQueryHtml(site: FubonEbankSite): Promise<string> {
  const scope = await site.frames.scopeWith("#form1\\:doValidate");
  const html = await site.postback(
    scope.locator("form").first(),
    "form1:doValidate",
  );
  await site.replaceDocument(scope, html);
  await site.frames.scopeWith(loanResultTable, "loan result table");

  return html;
}

export function assembleFubonLoanStatement(
  pages: readonly ParsedFubonLoanPage[],
  account: LoanAccountOption,
  query: FubonLoanQuery,
): ParsedLoanStatement {
  const firstPage = pages[0];
  if (!firstPage)
    throw new Error("Fubon loan query returned no response page.");
  const terminalPage = pages.at(-1);
  const complete =
    terminalPage?.pagination.terminal === true &&
    terminalPage.pagination.evidence === "terminal-no-next" &&
    pages.every((page, index) =>
      index === pages.length - 1
        ? page.pagination.terminal
        : page.pagination.evidence === "next-page" && !page.pagination.terminal,
    );
  const accountNumber = deriveFubonLoanAccountNumberEvidence(account);
  return {
    loanAccount: account.label,
    ...(accountNumber ? { accountNumber } : {}),
    loanAccountId: loanAccountIdFor(account.label, account.label),
    sourceAccountValue: account.value,
    queryPeriod: `${query.startDate}~${query.endDate}`,
    branchName: firstPage.branchName,
    accountType: firstPage.accountType,
    currency: firstPage.currency,
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

async function fetchFubonLoanStatementPages(
  site: FubonEbankSite,
  firstHtml: string,
  account: LoanAccountOption,
  query: FubonLoanQuery,
  silent = false,
): Promise<ParsedLoanStatement> {
  const pages: ParsedFubonLoanPage[] = [];
  const requests = new Set<string>();
  let html = firstHtml;

  while (true) {
    if (pages.length >= FUBON_LOAN_MAX_PAGES)
      throw new Error("Fubon loan pagination exceeded the safe page limit.");
    const parsed = await parseLoanStatementHtml(site, html, pages.length, silent);
    pages.push(parsed);
    if (!parsed.pagination.nextPage) break;
    if (!parsed.pagination.pageFieldName)
      throw new Error(
        "Fubon loan pagination control is missing its page field.",
      );
    const requestKey = `${parsed.pagination.pageFieldName}\u0000${parsed.pagination.nextPage}`;
    if (requests.has(requestKey))
      throw new Error("Fubon loan pagination repeated a page request.");
    requests.add(requestKey);

    const scope = await site.frames.scopeWith("#form1\\:doValidate");
    html = await site.postback(
      scope.locator("form").first(),
      undefined,
      { [parsed.pagination.pageFieldName]: parsed.pagination.nextPage },
    );
    await site.replaceDocument(scope, html);
    await site.frames.scopeWith(loanResultTable, "loan result table");
  }

  return assembleFubonLoanStatement(pages, account, query);
}

export async function parseFubonLoanStatementForCollection(
  site: FubonEbankSite,
  html: string,
  account: LoanAccountOption,
  query: FubonLoanQuery,
  sourceText: SourceTextPort,
): Promise<ParsedLoanStatement> {
  sourceText.assertIntact(html);
  const parsed = await fetchFubonLoanStatementPages(
    site,
    html,
    account,
    query,
    true,
  );
  sourceText.assertIntact(JSON.stringify(parsed));
  if (!parsed.completeness || parsed.pages.length !== parsed.completeness.pageCount)
    throw new Error("Fubon loan result lacks explicit complete terminal page evidence.");
  return parsed;
}

export async function runFubonLoanStatements(
  page: Page,
  input: FubonLoanProductInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  if (input.downloadFormat !== "EXCEL") {
    throw new Error(
      'fubon-loan-statements normalized collection currently supports downloadFormat="EXCEL" only.',
    );
  }

  const {
    sourceConnectionScope,
    sourceConnectionKey: relationSourceConnectionKey,
  } = requireSourceConnectionIdentity("fubon", "Fubon loan", input);
  const site = fubonEbankSite(page, context);
  await product.reportActivity("query");
  let scope = await site.open(LOAN_STATEMENTS_ROUTE);
  const loanAccounts = await readLoanAccountOptions(site, scope, input.loanAccountLabels);
  const queryItems = requestedQueryItems(input);
  const explicitQueryItems = hasExplicitQueryItems(input);
  const period = product.collectionPeriod();
  const query = fubonLoanQuery(period);
  const dateRange = { startDate: period.start, endDate: period.end };
  const skippedReasons: string[] = [];
  const items: ProductStageRequest[] = [];
  let rowCount = 0;

  for (const account of loanAccounts) {
    context.signal.throwIfAborted();
    scope = await selectLoanAccount(site, account);
    const availableQueryItems = await readAvailableLoanQueryItems(site, scope);
    const accountQueryItems = queryItems.filter((queryItem) =>
      availableQueryItems.includes(queryItem),
    );
    const unavailableQueryItems = queryItems.filter(
      (queryItem) => !availableQueryItems.includes(queryItem),
    );
    if (explicitQueryItems) {
      for (const queryItem of unavailableQueryItems)
        skippedReasons.push(`Loan query item is not available for this account: ${queryItem}`);
    }
    if (accountQueryItems.length === 0) {
      skippedReasons.push("No requested loan statement query is available for this account.");
      continue;
    }

    for (const queryItem of accountQueryItems) {
      context.signal.throwIfAborted();
      scope = await configureLoanQuery(site, query, queryItem);
      await product.reportActivity("query");
      const html = await fetchLoanQueryHtml(site);
      const parsed = await parseFubonLoanStatementForCollection(
        site,
        html,
        account,
        query,
        context.text,
      );
      const completeness = parsed.completeness;
      if (!completeness || parsed.pages.length !== completeness.pageCount)
        throw new Error("Fubon loan result lacks explicit complete terminal page evidence.");
      const captureInput: FubonLoanCaptureBuildInput = {
        accountValue: parsed.sourceAccountValue,
        ...(parsed.accountNumber ? { accountNumber: parsed.accountNumber } : {}),
        sourceConnectionScope,
        observedAt: context.now(),
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        scope: {
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          completeness: "complete-range",
          completenessBasis: "source-declared-terminal-range",
          completenessRuleVersion: FUBON_LOAN_CONTRACT_VERSION,
          pageCount: completeness.pageCount,
          terminal: completeness.terminal,
        },
        pages: parsed.pages,
        // Fubon exposes no source-linked deposit transaction in this response.
        relationCoverage: "not-asserted",
        counterpartTransactions: [],
        relations: [],
        rows: parsed.rows.map<FubonLoanStatementRow>((row) => ({
          transactionDate: row[0] ?? "",
          transactionContent: row[1] ?? "",
          transactionAmount: row[2] ?? "",
          balanceAfterTransaction: row[6] ?? "",
        })),
      };
      const capture = buildFubonLoanCapture(captureInput);
      assertFubonLoanCaptureAccountNumberEvidence(capture);
      const repaymentAccount = extractFubonLoanAccountEvidence(
        parsed.sourceAccountValue,
        parsed.loanAccount,
      );
      const provenanceRecord = capture.records[0];
      items.push({
        product: "loan",
        itemKey: `${capture.captureId}:${queryItem}`,
        command: {
          kind: PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
          request: { capture },
        },
        relationCommands: () => [
          {
            kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
            request: {
              sourceConnectionKey: relationSourceConnectionKey,
              integrationNamespace: "fubon",
              observedAt: capture.observedAt,
              counterpartyEvidence:
                repaymentAccount && provenanceRecord
                  ? [
                      {
                        captureId: capture.captureId,
                        sourceRecordKey: provenanceRecord.sourceRecordKey,
                        sourceConnectionKey: capture.identity.sourceConnectionKey,
                        identityEpochKey: capture.identity.identityEpochKey,
                        accountValue: repaymentAccount,
                        role: "beneficiary",
                        purpose: "loan_repayment",
                        scope: "loan_contract",
                        evidenceKind: "repayment-mandate",
                        sourceField: "loan-account-selector",
                        contractVersion: FUBON_LOAN_ACCOUNT_MANDATE_CONTRACT_VERSION,
                        effectiveStartDate: capture.scope.startDate,
                        effectiveEndDate: capture.scope.endDate,
                        accountKey: capture.identity.accountKey,
                      },
                    ]
                  : [],
            },
          },
        ],
      });
      rowCount += parsed.rows.length;
    }
  }

  if (items.length === 0 && skippedReasons.length > 0)
    throw new StatementComponentAbsentError(
      `No Fubon loan statement query is available. First skipped account reason: ${skippedReasons[0]}`,
    );
  context.signal.throwIfAborted();
  product.stage(...items);
  return {
    sourceCaptureCount: items.length,
    rowCount,
  };
}
