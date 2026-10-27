/**
 * Pure parsing of the Yuanta eBank credit-card pages: the bills grid and its
 * month options, the settled summary on each billed history page, the
 * settled-summary pages and their pager, and the current used-credit table.
 * Nothing here touches the browser.
 */
import type { YuantaCreditCardStatementSummary } from "../ledger/canonical/yuanta-credit-card-admission.ts";

export type YuantaCreditCardMonthOption = {
  index: number;
  label: string;
};

type MonthOption = YuantaCreditCardMonthOption;

export type YuantaCreditCardStatementRow = {
  creditCardNo: string;
  creditCardName: string;
  consumeDate: string;
  postedDate: string;
  description: string;
  countryCurrency: string;
  foreignExchangeDate: string;
  foreignAmount: string;
  twdAmount: string;
  paymentStatus: string;
  period: string | null;
};

type StatementRow = YuantaCreditCardStatementRow;

type ParsedCreditCardBillsHtml = {
  monthOptions: MonthOption[];
  paymentStatus: string;
  rows: StatementRow[];
};

/** A single issuer-provided, already-settled Yuanta billing summary. */
export type YuantaCreditCardIssuerSummary = {
  period: string;
  statementId?: string;
  closeDate: string;
  issueDate: string;
  dueDate: string;
  balance: string;
  minimumPayment: string;
  paymentStatus?: string;
};

const YUANTA_SUMMARY_MAX_PAGES = 100;

/**
 * The settled-summary extraction contract this parser implements. The human
 * attestation manifest names the same id, so changing how periods or balances
 * are extracted means bumping both.
 */
export const YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT =
  "yuanta-credit-card.settled-summary-parser.v7-exact-period-balance-a" as const;

/** Stable source scope for issuer-settled summaries found in each history query. */
export const YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY =
  "yuanta-credit-card.queryHistoryDetail.settled-summary-v2" as const;

export type YuantaCreditCardSummaryPageRequest = {
  pageOrdinal: number;
  pageTarget: string;
};

export type YuantaCreditCardSummaryPageEvidence = {
  pageOrdinal: number;
  periods: readonly string[];
  terminal: boolean;
  nextPageTarget: string | null;
  pageFingerprint: string;
};

export type YuantaCreditCardSummaryTraversal = {
  summaries: YuantaCreditCardIssuerSummary[];
  pages: YuantaCreditCardSummaryPageEvidence[];
  currentUsedCredit?: YuantaCurrentUsedCreditSnapshot;
};

export type YuantaCurrentUsedCreditSnapshot = Readonly<{
  limit: string;
  usedCredit: string;
  available: string;
  sourceField: "已使用額度";
  endpoint?: string;
  httpDate?: string;
  cacheControl?: string;
}>;

export type YuantaCreditCardHistorySettledSummaryPage = {
  sourceKey: typeof YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY;
  monthIndex: number;
  pageOrdinal: number;
  summary: YuantaCreditCardIssuerSummary;
};

export class YuantaCreditCardSummaryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YuantaCreditCardSummaryParseError";
  }
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function htmlAttribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeHtmlEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? "");
}

function stripHtml(value: string): string {
  return cleanText(
    decodeHtmlEntities(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function htmlElements(html: string, tag: string): string[] {
  return [
    ...html.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi")),
  ].map((match) => match[0]);
}

/** Extract balanced elements when nested provider markup is present. */
function balancedHtmlElements(html: string, tag: string): string[] {
  const elements: string[] = [];
  const stack: number[] = [];
  const tokenPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  for (const token of html.matchAll(tokenPattern)) {
    if (token.index === undefined) continue;
    if (/^<\//u.test(token[0])) {
      const start = stack.pop();
      if (start !== undefined)
        elements.push(html.slice(start, token.index + token[0].length));
    } else {
      stack.push(token.index);
    }
  }
  return elements;
}

function htmlBlocksByClass(html: string, className: string): string[] {
  const starts = [
    ...html.matchAll(
      new RegExp(
        `<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
        "gi",
      ),
    ),
  ].map((match) => match.index ?? 0);

  return starts.map((start, index) =>
    html.slice(start, starts[index + 1] ?? html.length),
  );
}

function parseHtmlRowsFromString(tableHtml: string): string[][] {
  const parsedRows: string[][] = [];

  for (const rowHtml of htmlElements(tableHtml, "tr")) {
    const values = [...rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
      .filter((match) => {
        const className = htmlAttribute(match[0], "class");
        return !/\b(cardDetailList|billcontrol_Btn)\b/.test(className);
      })
      .map((match) => stripHtml(match[3]));

    if (values.some((value) => value.length > 0)) parsedRows.push(values);
  }

  if (parsedRows.length === 0) {
    const text = stripHtml(tableHtml);
    if (text) parsedRows.push([text]);
  }

  return parsedRows;
}

function parseRwdTablesFromHtml(html: string): string[][][] {
  return balancedHtmlElements(html, "table")
    .filter((tableHtml) =>
      /<table\b[^>]*class=["'][^"']*\brwdTable\b[^"']*["'][^>]*>/iu.test(
        tableHtml,
      ),
    )
    .map((tableHtml) => parseHtmlRowsFromString(tableHtml));
}

function issuerAmountText(value: string | undefined, label: string): string {
  const text = cleanText(value ?? "").replaceAll(",", "");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text))
    throw new Error(`Yuanta ${label} is not an exact decimal amount.`);
  return text;
}

const YUANTA_CURRENT_CREDIT_HEADERS = [
  "信用額度",
  "已使用額度",
  "信用額度餘額",
  "預借現金額度",
] as const;

function yuantaCurrentCreditHeaderIndex(row: readonly string[]): number {
  return row.length >= YUANTA_CURRENT_CREDIT_HEADERS.length &&
    YUANTA_CURRENT_CREDIT_HEADERS.every(
      (header, index) => cleanText(row[index]) === header,
    )
    ? 0
    : -1;
}

/**
 * Parse only the first credit-limit table; statement tables are unrelated.
 * The header match is exact so a nearby statement table cannot supply a
 * current-used-credit value by accident.
 */
export function parseYuantaCurrentCreditCardUsedCreditSummaryHtml(
  html: string,
): YuantaCurrentUsedCreditSnapshot | undefined {
  for (const table of parseRwdTablesFromHtml(html)) {
    const headerIndex = table.findIndex(
      (row) => yuantaCurrentCreditHeaderIndex(row) >= 0,
    );
    if (headerIndex < 0) continue;
    const values = table[headerIndex + 1];
    if (!values || values.length < YUANTA_CURRENT_CREDIT_HEADERS.length)
      continue;
    return {
      limit: issuerAmountText(values[0], "credit limit"),
      usedCredit: issuerAmountText(values[1], "used credit"),
      available: issuerAmountText(values[2], "available credit"),
      sourceField: "已使用額度",
    };
  }
  return undefined;
}

/** Whether the HTML carries the reviewed current-credit header row. */
export function hasYuantaCurrentCreditTable(html: string): boolean {
  return parseRwdTablesFromHtml(html).some((table) =>
    table.some((row) => yuantaCurrentCreditHeaderIndex(row) >= 0),
  );
}

function parseMonthOptionsFromHtml(html: string): MonthOption[] {
  const options = new Map<number, MonthOption>();
  for (const match of html.matchAll(
    /<a\b[^>]*onclick=["'][^"']*queryMonth\(['"]?(\d+)['"]?\)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const label = stripHtml(match[2]);
    if (label)
      options.set(Number(match[1]), { index: Number(match[1]), label });
  }

  if (options.size === 0) {
    throw new Error("Could not find YuanTa credit card statement month links.");
  }

  return [...options.values()].sort((left, right) => left.index - right.index);
}

export function hasUntraversedPager(html: string): boolean {
  return htmlControlTags(html).some(isActiveYuantaSummaryPagerControl);
}

type YuantaSummaryTableMatch = {
  html: string;
  start: number;
  end: number;
};

function summaryFieldCount(value: string): number {
  const labels = [
    "帳單月份",
    "帳單期別",
    "對帳單月份",
    "結帳月份",
    "帳單週期",
    "結帳日",
    "結帳日期",
    "帳單結帳日",
    "本期結帳日",
    "出帳日",
    "繳款截止日",
    "繳款期限",
    "到期日",
    "本期應繳總額",
    "本期應繳總金額",
    "本期應繳金額",
    "應繳總額",
    "應繳金額",
    "本期最低應繳額",
    "本期最低應繳金額",
    "最低應繳額",
    "最低應繳金額",
  ];
  return labels.filter((label) => value.includes(label)).length;
}

function isVoidHtmlElement(tagName: string): boolean {
  return /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/iu.test(
    tagName,
  );
}

function enclosingSummaryBlocks(
  html: string,
  targetStart: number,
  targetEnd: number,
): string[] {
  const tokenPattern = /<!--(?:[\s\S]*?)-->|<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?>/giu;
  const tokens = [...html.matchAll(tokenPattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    raw: match[0],
    tagName: match[1]?.toLowerCase() ?? "",
    closing: /^<\//u.test(match[0]),
    selfClosing: /\/\s*>$/u.test(match[0]),
  }));
  const stack: Array<{ tagName: string; start: number; end?: number }> = [];
  const beforeTarget = tokens.filter((token) => token.start < targetStart);
  for (const token of beforeTarget) {
    if (!token.tagName || token.raw.startsWith("<!--")) continue;
    if (token.closing) {
      const index = stack.findLastIndex((item) => item.tagName === token.tagName);
      if (index >= 0) stack.splice(index, 1);
    } else if (!token.selfClosing && !isVoidHtmlElement(token.tagName)) {
      stack.push({ tagName: token.tagName, start: token.start });
    }
  }
  const ancestors = stack.map((item) => ({ ...item }));
  for (const token of tokens.filter((value) => value.start >= targetEnd)) {
    if (!token.tagName || token.raw.startsWith("<!--")) continue;
    if (token.closing) {
      const index = stack.findLastIndex((item) => item.tagName === token.tagName);
      if (index >= 0) {
        const [item] = stack.splice(index, 1);
        const ancestor = ancestors.find(
          (candidate) => candidate.start === item?.start,
        );
        if (ancestor) ancestor.end = token.end;
      }
    } else if (!token.selfClosing && !isVoidHtmlElement(token.tagName)) {
      stack.push({ tagName: token.tagName, start: token.start });
    }
  }
  return ancestors
    .filter(
      (item) =>
        /^(?:div|section|form)$/iu.test(item.tagName) &&
        item.end !== undefined,
    )
    .map((item) => html.slice(item.start, item.end))
    .filter((fragment) => {
      const opening = fragment.match(/^<(?:div|section|form)\b[^>]*>/iu)?.[0] ?? "";
      const className = htmlAttribute(opening, "class");
      const id = htmlAttribute(opening, "id");
      return !/\b(?:menu|global|site-nav|header|footer)\b/iu.test(
        `${className} ${id}`,
      );
    });
}

function yuantaSummaryTableMatches(html: string): YuantaSummaryTableMatch[] {
  return [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/giu)]
    .map((match) => {
      const tableHtml = match[0];
      const rows = parseHtmlRowsFromString(tableHtml);
      const fields = new Set(
        rows
          .flat()
          .map((cell) => yuantaSummaryField(cell))
          .filter((field): field is YuantaSummaryField => field !== undefined),
      );
      const hasSummaryFields = fields.size >= 1;
      return hasSummaryFields
        ? {
            html: tableHtml,
            start: match.index ?? 0,
            end: (match.index ?? 0) + tableHtml.length,
          }
        : null;
    })
    .filter((match): match is YuantaSummaryTableMatch => match !== null);
}

function isAdjacentSummaryPagerNode(fragment: string): boolean {
  const opening = fragment.match(
    /^<(?:a|button|input|div|section|form|nav)\b[^>]*>/iu,
  )?.[0] ?? "";
  if (!opening) return false;
  const className = htmlAttribute(opening, "class");
  const id = htmlAttribute(opening, "id");
  const marker = `${className} ${id}`;
  if (/\b(?:menu|global|site-nav)\b/iu.test(marker)) return false;
  if (
    /^<nav\b/iu.test(opening) &&
    !/\b(?:pager|pagination)\b/iu.test(marker)
  )
    return false;
  return (
    /\b(?:pager|pagination)\b/iu.test(marker) ||
    summaryPagerControlsFromFragment(fragment).length > 0
  );
}

function adjacentSummaryPagerFragments(
  html: string,
  targetStart: number,
  targetEnd: number,
): string[] {
  const candidates: string[] = [];
  const after = html.slice(targetEnd).match(
    /^\s*(<(?:a|button|div|section|form|nav)\b[^>]*>[\s\S]*?<\/(?:a|button|div|section|form|nav)>|<input\b[^>]*>)/iu,
  )?.[1];
  if (after && isAdjacentSummaryPagerNode(after)) candidates.push(after);
  const beforeHtml = html.slice(0, targetStart);
  const beforeMatches = [
    ...beforeHtml.matchAll(
      /<(?:a|button|div|section|form|nav)\b[^>]*>[\s\S]*?<\/(?:a|button|div|section|form|nav)>/giu,
    ),
  ];
  const before = beforeMatches.at(-1)?.[0];
  if (before && isAdjacentSummaryPagerNode(before)) candidates.push(before);
  return candidates;
}

function yuantaSummaryResultFragments(html: string): string[] {
  const tables = yuantaSummaryTableMatches(html);
  if (tables.length > 0) {
    const fragments = tables.flatMap((table) => [
      table.html,
      ...enclosingSummaryBlocks(html, table.start, table.end),
      ...adjacentSummaryPagerFragments(html, table.start, table.end),
    ]);
    return [...new Set(fragments)];
  }

  const blocks = [
    ...html.matchAll(
      /<(?:div|section|form)\b[^>]*>[\s\S]*?<\/(?:div|section|form)>/giu,
    ),
  ]
    .map((match) => match[0])
    .filter((block) => summaryFieldCount(stripHtml(block)) >= 2)
    .sort((left, right) => left.length - right.length);
  return blocks.length > 0 ? [blocks[0]!] : [];
}

function htmlControlTags(containerHtml: string): string[] {
  return [
    ...containerHtml.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu),
    ...containerHtml.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/giu),
    ...containerHtml.matchAll(/<input\b[^>]*>/giu),
  ].map((match) => match[0]);
}

function htmlControlOpeningTag(controlHtml: string): string {
  return controlHtml.match(/^<(?:a|button|input)\b[^>]*>/iu)?.[0] ?? controlHtml;
}

export function isActiveYuantaSummaryPagerControl(controlHtml: string): boolean {
  const opening = htmlControlOpeningTag(controlHtml);
  const tagName = opening.match(/^<([a-z]+)/iu)?.[1]?.toLowerCase() ?? "";
  if (!tagName) return false;
  if (
    /\bhidden\b|\bdisabled\b|aria-disabled\s*=\s*["']?true\b/iu.test(
      opening,
    ) ||
    (tagName === "input" &&
      /type\s*=\s*["']?hidden\b/iu.test(opening))
  )
    return false;
  const text = stripHtml(controlHtml);
  const attributes = opening;
  const haystack = `${attributes} ${text}`.normalize("NFKC");
  if (/queryMonth|menuaction/iu.test(haystack))
    return false;
  if (/上一頁|上頁|\bprev(?:ious)?\b/iu.test(haystack)) return false;
  if (
    tagName === "input" &&
    !/type\s*=\s*["']?(?:submit|button|image)\b/iu.test(opening)
  )
    return false;
  const hasForwardLabel = /下一頁|下頁|\bnext(?:\s*page)?\b/iu.test(
    haystack,
  );
  const hasPageAction =
    /(?:goPage|setPage|currentPage|pageIndex|pageNo|pageNumber)\s*[=(]/iu.test(
      haystack,
    ) ||
    /[?&#](?:page|pageNo|pageIndex)=/iu.test(haystack) ||
    /\b(?:pager|pagination)\b/iu.test(haystack);
  return hasForwardLabel || hasPageAction;
}

function yuantaSummaryPagerTarget(controlHtml: string): string {
  const opening = htmlControlOpeningTag(controlHtml);
  const onclick = htmlAttribute(opening, "onclick");
  const href = htmlAttribute(opening, "href");
  const action = `${onclick} ${href}`;
  const pageNumber = [...action.matchAll(
    /(?:goPage|setPage|currentPage|pageIndex|pageNo|pageNumber)\s*\([^)]*?(\d+)\s*\)?/giu,
  )].at(-1)?.[1];
  if (pageNumber) return `page:${pageNumber}`;
  const queryPage = action.match(/[?&#](?:page|pageNo|pageIndex)=([^&#"']+)/iu)?.[1];
  if (queryPage) return `page:${queryPage}`;
  return `${opening} ${stripHtml(controlHtml)}`
    .replace(/\s+/gu, " ")
    .trim();
}

function summaryPagerControlsFromFragment(fragment: string): string[] {
  return htmlControlTags(fragment).filter(isActiveYuantaSummaryPagerControl);
}

function hasUntraversedYuantaSummaryPager(html: string): boolean {
  return yuantaSummaryResultFragments(html).some(
    (fragment) => summaryPagerControlsFromFragment(fragment).length > 0,
  );
}

function yuantaSummaryPageFingerprint(html: string): string {
  const fragments = yuantaSummaryResultFragments(html);
  return (fragments[0] ?? html).replace(/\s+/gu, " ").trim();
}

function normalizeTableRows(tableLabel: string, rows: string[][]): string[][] {
  if (tableLabel !== "transactions" || rows.length < 2) return rows;

  const [headers, ...bodyRows] = rows;
  const trailingHeaderIndex = headers.length - 1;
  const hasBlankTrailingHeader =
    trailingHeaderIndex >= 0 && !headers[trailingHeaderIndex];
  const hasTwdAmountHeader = headers.includes("新臺幣金額");
  if (!hasBlankTrailingHeader || !hasTwdAmountHeader) return rows;

  const normalizedHeaders = headers.slice(0, trailingHeaderIndex);
  const normalizedBodyRows = bodyRows.map((row) => {
    if (row.length === headers.length && !row[0] && row[trailingHeaderIndex]) {
      return row.slice(1);
    }

    return row.slice(0, normalizedHeaders.length);
  });

  return [normalizedHeaders, ...normalizedBodyRows];
}

function headerScore(row: string[]): number {
  return row.filter((value) => /日期|明細|幣別|金額|繳款|入帳|消費/.test(value))
    .length;
}

function findHeaderRowIndex(rows: string[][]): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const score = headerScore(rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex >= 0) return bestIndex;
  return rows[0]?.some((header) => header.length > 0) ? 0 : -1;
}

function uniqueHeaders(row: string[]): string[] {
  const seen = new Map<string, number>();

  return row.map((value, index) => {
    const baseName = cleanText(value) || `column_${index + 1}`;
    const count = seen.get(baseName) ?? 0;
    seen.set(baseName, count + 1);
    return count === 0 ? baseName : `${baseName}_${count + 1}`;
  });
}

function alignValuesToHeaders(values: string[], headers: string[]): string[] {
  const aligned = [...values];
  while (aligned.length > headers.length && !aligned[0]) {
    aligned.shift();
  }
  return aligned;
}

function isRepeatedHeaderRow(values: string[], headers: string[]): boolean {
  if (values.length !== headers.length) return false;
  return values.every((value, index) => !value || value === headers[index]);
}

function hasTransactionHeaders(headers: string[]): boolean {
  return ["消費日期", "入帳日期", "消費明細", "新臺幣金額"].every((header) =>
    headers.includes(header),
  );
}

function columnsFromValues(
  headers: string[],
  values: string[],
): Record<string, string> {
  const columns: Record<string, string> = {};
  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    columns[headers[columnIndex]] = values[columnIndex] ?? "";
  }
  return columns;
}

function statementRowsFromTableRows(
  rows: string[][],
  context: {
    creditCardNo: string;
    creditCardName: string;
    period: string | null;
    paymentStatus: string;
  },
): StatementRow[] {
  const normalizedRows = normalizeTableRows("transactions", rows);
  const headerRowIndex = findHeaderRowIndex(normalizedRows);
  if (headerRowIndex < 0) return [];

  const headers = uniqueHeaders(normalizedRows[headerRowIndex]);
  if (!hasTransactionHeaders(headers)) return [];

  const statementRows: StatementRow[] = [];
  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < normalizedRows.length;
    rowIndex += 1
  ) {
    const values = alignValuesToHeaders(
      normalizedRows[rowIndex],
      headers,
    ).slice(0, headers.length);
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values, headers)) continue;

    const columns = columnsFromValues(headers, values);
    statementRows.push({
      creditCardNo: context.creditCardNo,
      creditCardName: context.creditCardName,
      consumeDate: columns["消費日期"] ?? "",
      postedDate: columns["入帳日期"] ?? "",
      description: columns["消費明細"] ?? "",
      countryCurrency: columns["國家/幣別"] ?? "",
      foreignExchangeDate: columns["外幣折算日"] ?? "",
      foreignAmount: columns["外幣金額"] ?? "",
      twdAmount: columns["新臺幣金額"] ?? "",
      paymentStatus: context.paymentStatus,
      period: context.period,
    });
  }

  return statementRows;
}

function parseAmount(value: string | undefined): number | null {
  const normalized = (value ?? "").replace(/[, $NT]/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferPaymentStatus(columns: Record<string, string>): string {
  const due = parseAmount(columns["本期應繳金額"]);
  const paid = parseAmount(columns["已繳款金額"]);
  if (due === null || paid === null) return "";
  if (due <= 0) return "無應繳";
  if (paid <= 0) return "未繳";
  if (paid >= due) return "已繳";
  return "部分繳款";
}

function paymentStatusFromTables(tables: string[][][]): string {
  for (const rows of tables) {
    const headerRowIndex = rows.findIndex(
      (row) => row.includes("帳單月份") && row.includes("已繳款金額"),
    );
    if (headerRowIndex < 0 || headerRowIndex + 1 >= rows.length) continue;

    const headers = uniqueHeaders(rows[headerRowIndex]);
    const values = alignValuesToHeaders(
      rows[headerRowIndex + 1],
      headers,
    ).slice(0, headers.length);
    return inferPaymentStatus(columnsFromValues(headers, values));
  }

  return "";
}

function parseCreditCardName(cardHtml: string): string {
  const heading =
    cardHtml.match(
      /<h4\b[^>]*class=["'][^"']*\bweb\b[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i,
    )?.[1] ??
    cardHtml.match(
      /<div\b[^>]*class=["'][^"']*\bcardHead\b[^"']*["'][^>]*>[\s\S]*?<h4\b[^>]*>([\s\S]*?)<\/h4>/i,
    )?.[1] ??
    "";
  return stripHtml(heading).replace(/主卡/g, "").trim();
}

function parseCreditCardNo(cardHtml: string): string {
  for (const item of htmlElements(cardHtml, "li")) {
    if (
      !stripHtml(
        item.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? "",
      ).includes("卡號")
    ) {
      continue;
    }
    return stripHtml(item.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  }

  return "";
}

export function parseCreditCardBillsHtml(
  html: string,
  period: string | null,
  requireMonthOptions = true,
): ParsedCreditCardBillsHtml {
  const tables = parseRwdTablesFromHtml(html);
  const paymentStatus = period ? paymentStatusFromTables(tables) : "";
  const rows = htmlBlocksByClass(html, "cardBx")
    .filter(
      (cardHtml) =>
        cardHtml.includes("cardInfoD") && cardHtml.includes("rwdTable"),
    )
    .flatMap((cardHtml) => {
      const creditCardNo = parseCreditCardNo(cardHtml);
      const creditCardName = parseCreditCardName(cardHtml);
      return parseRwdTablesFromHtml(cardHtml).flatMap((tableRows) =>
        statementRowsFromTableRows(tableRows, {
          creditCardNo,
          creditCardName,
          period,
          paymentStatus,
        }),
      );
    });

  return {
    monthOptions: requireMonthOptions ? parseMonthOptionsFromHtml(html) : [],
    paymentStatus,
    rows,
  };
}

type YuantaSummaryField =
  | "period"
  | "statementId"
  | "closeDate"
  | "issueDate"
  | "dueDate"
  | "balance"
  | "minimumPayment"
  | "paymentStatus";

type YuantaSummarySourceLayout =
  | "vertical-grid-same-column"
  | "header-row-same-column"
  | "same-row-adjacent"
  | "text-label-value"
  | "unknown";

type YuantaSummaryFieldSource = {
  layout: YuantaSummarySourceLayout;
  labelTagName: "th" | "td" | null;
  valueTagName: "th" | "td" | null;
  rowIndex: number | null;
  cellIndex: number | null;
};

type YuantaSummaryFieldEvidence = {
  rawValue: string;
  source: YuantaSummaryFieldSource;
};

const YUANTA_SUMMARY_FIELD_EVIDENCE = Symbol("yuanta-summary-field-evidence");
type YuantaSummaryFieldEvidenceMap = Partial<
  Record<YuantaSummaryField, YuantaSummaryFieldEvidence>
>;

type YuantaSummaryCandidate = Partial<Record<YuantaSummaryField, string>> & {
  [YUANTA_SUMMARY_FIELD_EVIDENCE]?: YuantaSummaryFieldEvidenceMap;
};

const UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE: YuantaSummaryFieldSource = {
  layout: "unknown",
  labelTagName: null,
  valueTagName: null,
  rowIndex: null,
  cellIndex: null,
};

function setYuantaSummaryCandidateField(
  candidate: YuantaSummaryCandidate,
  field: YuantaSummaryField,
  rawValue: string,
  source: YuantaSummaryFieldSource = UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
): void {
  candidate[field] = rawValue;
  candidate[YUANTA_SUMMARY_FIELD_EVIDENCE] = {
    ...(candidate[YUANTA_SUMMARY_FIELD_EVIDENCE] ?? {}),
    [field]: { rawValue, source },
  };
}

function yuantaSummaryCandidateFieldEvidence(
  candidate: YuantaSummaryCandidate,
  field: YuantaSummaryField,
): YuantaSummaryFieldEvidence | undefined {
  return candidate[YUANTA_SUMMARY_FIELD_EVIDENCE]?.[field];
}

/**
 * Copy a candidate through the field-evidence API rather than spreading it.
 * A plain object spread makes a shallow copy without enforcing that each
 * value and its provenance are copied as one field-level unit. Keeping this
 * operation explicit makes value/source propagation atomic for every field.
 */
function cloneYuantaSummaryCandidate(
  source: YuantaSummaryCandidate,
): YuantaSummaryCandidate {
  const clone: YuantaSummaryCandidate = {};
  for (const field of Object.keys(source) as YuantaSummaryField[]) {
    const value = source[field];
    if (value !== undefined)
      setYuantaSummaryCandidateFieldFromCandidate(clone, field, value, source);
  }
  return clone;
}

function setYuantaSummaryCandidateFieldFromCandidate(
  target: YuantaSummaryCandidate,
  field: YuantaSummaryField,
  value: string,
  sourceCandidate: YuantaSummaryCandidate,
): void {
  const evidence = yuantaSummaryCandidateFieldEvidence(sourceCandidate, field);
  setYuantaSummaryCandidateField(
    target,
    field,
    evidence?.rawValue ?? value,
    evidence?.source ?? UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
  );
}

function assertYuantaVerticalCandidateEvidence(
  candidate: YuantaSummaryCandidate,
): void {
  for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
    const evidence = yuantaSummaryCandidateFieldEvidence(candidate, field);
    if (
      !evidence ||
      evidence.rawValue !== candidate[field] ||
      evidence.source.layout !== "vertical-grid-same-column" ||
      evidence.source.rowIndex === null ||
      evidence.source.cellIndex === null
    )
      throw new Error(
        "Yuanta settled statement summary vertical grid field source contract is invalid.",
      );
  }
}

function normalizedYuantaSummaryLabel(value: string): string {
  return stripHtml(value)
    .normalize("NFKC")
    .replace(/[：:：\s]/gu, "")
    .replace(/[()（）]/gu, "")
    .replace(/註[^\p{L}\p{N}]*[\p{L}\p{N}]+$/u, "");
}

function yuantaSummaryField(value: string): YuantaSummaryField | undefined {
  const label = normalizedYuantaSummaryLabel(value);
  if (
    /^(?:帳單月份|帳單期別|對帳單月份|結帳月份|帳單週期)$/u.test(label)
  )
    return "period";
  if (/^(?:帳單編號|帳單號碼|對帳單編號|帳單序號)$/u.test(label))
    return "statementId";
  if (/^(?:帳單)?結帳(?:日|日期)$/u.test(label) || /^本期結帳日$/u.test(label))
    return "closeDate";
  if (/^(?:出帳日|出帳日期|帳單日|帳單日期)$/u.test(label))
    return "issueDate";
  if (/^(?:繳款截止日|繳款期限|到期日)$/u.test(label)) return "dueDate";
  if (/^(?:本期應繳(?:總額|總金額|金額)|應繳(?:總額|金額))$/u.test(label))
    return "balance";
  if (
    /^(?:本期最低應繳(?:額|金額)|最低應繳(?:額|金額)?|最低應繳)$/u.test(
      label,
    )
  )
    return "minimumPayment";
  if (/^(?:繳費狀態|繳款狀態|付款狀態)$/u.test(label)) return "paymentStatus";
  return undefined;
}

function isYuantaSummaryIgnoredLabel(value: string): boolean {
  return /^已繳款金額$/u.test(normalizedYuantaSummaryLabel(value));
}

function addYuantaSummaryCandidate(
  candidates: YuantaSummaryCandidate[],
  candidate: YuantaSummaryCandidate,
): void {
  if (Object.keys(candidate).length > 0) candidates.push(candidate);
}

function candidateFromYuantaSummaryRow(
  headers: readonly string[],
  values: readonly string[],
): YuantaSummaryCandidate {
  const candidate: YuantaSummaryCandidate = {};
  for (let index = 0; index < headers.length; index += 1) {
    const field = yuantaSummaryField(headers[index] ?? "");
    const value = cleanText(values[index]);
    if (field && value)
      setYuantaSummaryCandidateField(candidate, field, value, {
        ...UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
        layout: "header-row-same-column",
        cellIndex: index,
      });
  }
  return candidate;
}

function yuantaSummaryTableHeaderIndex(rows: string[][]): number {
  return rows.findIndex(
    (row) =>
      row.filter((cell) => yuantaSummaryField(cell) !== undefined).length >= 2 &&
      row.some((cell) => yuantaSummaryField(cell) === "period") &&
      !row.some((cell, index) => {
        const field = yuantaSummaryField(cell);
        const next = cleanText(row[index + 1]);
        return (
          field !== undefined &&
          next !== "" &&
          yuantaSummaryField(next) === undefined &&
          !isYuantaSummaryIgnoredLabel(next)
        );
      }),
  );
}

type YuantaSummaryStructuredCell = {
  tagName: "th" | "td";
  text: string;
  hasSpan: boolean;
};

function parseYuantaSummaryStructuredRows(
  tableHtml: string,
): YuantaSummaryStructuredCell[][] {
  const rows: YuantaSummaryStructuredCell[][] = [];
  for (const rowHtml of htmlElements(tableHtml, "tr")) {
    const row = [...rowHtml.matchAll(
      /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
    )]
      .filter((match) => {
        const className = htmlAttribute(match[0], "class");
        return !/\b(cardDetailList|billcontrol_Btn)\b/u.test(className);
      })
      .map((match) => ({
        tagName: match[1]!.toLowerCase() as "th" | "td",
        text: stripHtml(match[3]),
        hasSpan: /\b(?:rowspan|colspan)\s*=/iu.test(match[2] ?? ""),
      }));
    if (row.some((cell) => cell.text.length > 0)) rows.push(row);
  }
  if (rows.length === 0) {
    const text = stripHtml(tableHtml);
    if (text) rows.push([{ tagName: "td", text, hasSpan: false }]);
  }
  return rows;
}

function isYuantaSummaryStructuredHeaderRow(
  row: readonly YuantaSummaryStructuredCell[],
): boolean {
  const populated = row.filter((cell) => cell.text.length > 0);
  const fields = populated.map((cell) => yuantaSummaryField(cell.text));
  const hasRequiredField = fields.some(
    (field) =>
      field !== undefined &&
      YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.includes(
        field as YuantaSummaryRequiredField,
      ),
  );
  return (
    populated.length >= 2 &&
    fields.filter((field) => field !== undefined).length >= 2 &&
    hasRequiredField &&
    populated.every(
      (cell) =>
        yuantaSummaryField(cell.text) !== undefined ||
        isYuantaSummaryIgnoredLabel(cell.text),
    ) &&
    // A real header is normally th-based. Accept all-known td rows too,
    // because the bank has used both markup variants across sessions.
    (populated.some((cell) => cell.tagName === "th") ||
      populated.every((cell) => yuantaSummaryField(cell.text) !== undefined))
  );
}

function candidateFromYuantaStructuredHeaderRow(
  headers: readonly YuantaSummaryStructuredCell[],
  values: readonly YuantaSummaryStructuredCell[],
): YuantaSummaryCandidate {
  const candidate: YuantaSummaryCandidate = {};
  for (let index = 0; index < headers.length; index += 1) {
    const field = yuantaSummaryField(headers[index]?.text ?? "");
    const value = cleanText(values[index]?.text);
    if (
      field &&
      value &&
      yuantaSummaryField(value) === undefined &&
      !isYuantaSummaryIgnoredLabel(value)
    )
      setYuantaSummaryCandidateField(candidate, field, value, {
        layout: "header-row-same-column",
        labelTagName: headers[index]?.tagName ?? null,
        valueTagName: values[index]?.tagName ?? null,
        rowIndex: null,
        cellIndex: index,
      });
  }
  return candidate;
}

type YuantaSummaryVerticalGridExtraction = {
  found: boolean;
  candidates: YuantaSummaryCandidate[];
};

type YuantaSummaryVerticalPeriodExtraction = {
  found: boolean;
  candidate?: YuantaSummaryCandidate;
  mixedNextRow: boolean;
  labelRowIndex: number | null;
};

function isYuantaSummaryRequiredField(
  field: YuantaSummaryField | undefined,
): field is YuantaSummaryRequiredField {
  return field !== undefined &&
    YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.includes(
      field as YuantaSummaryRequiredField,
    );
}

function isYuantaSummaryVerticalLabelRow(
  row: readonly YuantaSummaryStructuredCell[],
): boolean {
  const populated = row.filter((cell) => cell.text.length > 0);
  return (
    populated.length > 0 &&
    populated.some((cell) =>
      isYuantaSummaryRequiredField(yuantaSummaryField(cell.text)),
    ) &&
    populated.every((cell) => !isYuantaSummaryIgnoredLabel(cell.text)) &&
    populated.every((cell) => cell.tagName === "th")
  );
}

function isYuantaSummaryVerticalValueRow(
  row: readonly YuantaSummaryStructuredCell[],
): boolean {
  const populated = row.filter((cell) => cell.text.length > 0);
  const tagName = populated[0]?.tagName;
  return (
    populated.length > 0 &&
    (tagName === "th" || tagName === "td") &&
    populated.every((cell) => cell.tagName === tagName)
  );
}

function candidatesFromYuantaSummaryVerticalPeriodColumn(
  rows: readonly YuantaSummaryStructuredCell[][],
): YuantaSummaryVerticalPeriodExtraction {
  let labelRowIndex = -1;
  let labelCellIndex = -1;
  for (const [rowIndex, row] of rows.entries()) {
    for (const [cellIndex, cell] of row.entries()) {
      if (yuantaSummaryField(cell.text) !== "period") continue;
      if (labelRowIndex >= 0)
        throw new Error(
          "Yuanta settled statement summary vertical period column has multiple labels.",
        );
      labelRowIndex = rowIndex;
      labelCellIndex = cellIndex;
    }
  }
  if (labelRowIndex < 0)
    return { found: false, mixedNextRow: false, labelRowIndex: null };

  const labelRow = rows[labelRowIndex]!;
  const nextRow = rows[labelRowIndex + 1];
  if (!nextRow)
    throw new Error(
      "Yuanta settled statement summary vertical period value row is missing.",
    );
  const labelCell = labelRow[labelCellIndex]!;
  const valueCell = nextRow[labelCellIndex];
  if (
    !valueCell ||
    labelCell.hasSpan ||
    valueCell.hasSpan
  )
    throw new Error(
      "Yuanta settled statement summary vertical period column has ambiguous cell spans or position.",
    );
  const value = cleanText(valueCell.text);
  // A recognized label in the same column means this is the ordinary
  // same-row key/value layout (the next row starts another field group), not
  // the human-attested vertical period relationship.  Leave it to the normal
  // key/value extractor instead of manufacturing a period candidate.
  if (
    yuantaSummaryField(value) !== undefined ||
    isYuantaSummaryIgnoredLabel(value)
  )
    return { found: false, mixedNextRow: false, labelRowIndex: null };
  if (
    !value
  )
    throw new Error(
      "Yuanta settled statement summary vertical period value is missing or label-like.",
    );

  const populatedNextRow = nextRow.filter((cell) => cell.text.length > 0);
  const nextRowTagNames = new Set(populatedNextRow.map((cell) => cell.tagName));
  const mixedNextRow =
    nextRow.some(
      (cell, cellIndex) =>
        cellIndex !== labelCellIndex &&
        (yuantaSummaryField(cell.text) !== undefined ||
          isYuantaSummaryIgnoredLabel(cell.text)),
    ) || nextRowTagNames.size > 1;
  const candidate: YuantaSummaryCandidate = {};
  setYuantaSummaryCandidateField(candidate, "period", value, {
    layout: "vertical-grid-same-column",
    labelTagName: labelCell.tagName,
    valueTagName: valueCell.tagName,
    rowIndex: labelRowIndex,
    cellIndex: labelCellIndex,
  });
  assertYuantaVerticalCandidateEvidence(candidate);
  return { found: true, candidate, mixedNextRow, labelRowIndex };
}

/**
 * Human-attested Yuanta history contract: the first issuer rwdTable's first
 * cell is the period label and the next row's first cell is its value.  This
 * exact coordinate binding runs before all generic extractors so a title,
 * tab, or same-row display text cannot become period authority.
 */
function candidatesFromYuantaAttestedPeriodColumn(
  rows: readonly YuantaSummaryStructuredCell[][],
): YuantaSummaryVerticalPeriodExtraction {
  const labelRow = rows[0];
  const labelCell = labelRow?.[0];
  if (!labelRow || !labelCell || yuantaSummaryField(labelCell.text) !== "period")
    throw new Error(
      "Yuanta settled statement summary exact period contract requires rwdTable row 0 cell 0 period label.",
    );

  const periodLabelCells = rows.flatMap((row, rowIndex) =>
    row.flatMap((cell, cellIndex) =>
      yuantaSummaryField(cell.text) === "period"
        ? [{ rowIndex, cellIndex }]
        : [],
    ),
  );
  if (periodLabelCells.length !== 1)
    throw new Error(
      "Yuanta settled statement summary exact period contract has duplicate or shifted period labels.",
    );

  const valueRow = rows[1];
  const valueCell = valueRow?.[0];
  if (
    !valueRow ||
    !valueCell ||
    labelCell.hasSpan ||
    valueCell.hasSpan
  )
    throw new Error(
      "Yuanta settled statement summary exact period contract has an ambiguous span or missing row 1 cell 0.",
    );
  const value = cleanText(valueCell.text);
  if (
    !value ||
    yuantaSummaryField(value) !== undefined ||
    isYuantaSummaryIgnoredLabel(value)
  )
    throw new Error(
      "Yuanta settled statement summary exact period contract has an empty or label-like row 1 cell 0 value.",
    );

  const populatedValueRow = valueRow.filter((cell) => cell.text.length > 0);
  const valueRowTags = new Set(populatedValueRow.map((cell) => cell.tagName));
  const mixedNextRow =
    valueRow.some(
      (cell, cellIndex) =>
        cellIndex !== 0 &&
        (yuantaSummaryField(cell.text) !== undefined ||
          isYuantaSummaryIgnoredLabel(cell.text)),
    ) || valueRowTags.size > 1;
  const candidate: YuantaSummaryCandidate = {};
  setYuantaSummaryCandidateField(candidate, "period", value, {
    layout: "vertical-grid-same-column",
    labelTagName: labelCell.tagName,
    valueTagName: valueCell.tagName,
    rowIndex: 0,
    cellIndex: 0,
  });
  assertYuantaVerticalCandidateEvidence(candidate);
  return { found: true, candidate, mixedNextRow, labelRowIndex: 0 };
}

/**
 * Human-attested balance contract for the same first issuer table.  The
 * balance is taken only from the next row in the label's own column; a paid
 * amount or text-fragment total is never promoted to authoritative balance.
 */
function candidateFromYuantaAttestedBalanceColumn(
  rows: readonly YuantaSummaryStructuredCell[][],
): YuantaSummaryCandidate {
  const balanceLabelCells = rows.flatMap((row, rowIndex) =>
    row.flatMap((cell, cellIndex) =>
      yuantaSummaryField(cell.text) === "balance"
        ? [{ rowIndex, cellIndex, cell }]
        : [],
    ),
  );
  if (balanceLabelCells.length !== 1)
    throw new Error(
      "Yuanta settled statement summary exact balance contract requires one balance label column.",
    );
  const { rowIndex, cellIndex, cell: labelCell } = balanceLabelCells[0]!;
  const valueRow = rows[rowIndex + 1];
  const valueCell = valueRow?.[cellIndex];
  if (
    !valueRow ||
    !valueCell ||
    labelCell.hasSpan ||
    valueCell.hasSpan
  )
    throw new Error(
      "Yuanta settled statement summary exact balance contract has an ambiguous span or missing value cell.",
    );
  const value = cleanText(valueCell.text);
  if (
    !value ||
    yuantaSummaryField(value) !== undefined ||
    isYuantaSummaryIgnoredLabel(value)
  )
    throw new Error(
      "Yuanta settled statement summary exact balance contract has an empty or label-like value.",
    );
  const candidate: YuantaSummaryCandidate = {};
  setYuantaSummaryCandidateField(candidate, "balance", value, {
    layout: "vertical-grid-same-column",
    labelTagName: labelCell.tagName,
    valueTagName: valueCell.tagName,
    rowIndex,
    cellIndex,
  });
  assertYuantaVerticalCandidateEvidence(candidate);
  return candidate;
}

function candidatesFromYuantaSummaryVerticalGrid(
  rows: readonly YuantaSummaryStructuredCell[][],
  excludedLabelRowIndex: number | null = null,
): YuantaSummaryVerticalGridExtraction {
  const candidates: YuantaSummaryCandidate[] = [];
  let found = false;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const labelRow = rows[rowIndex]!;
    if (rowIndex === excludedLabelRowIndex) continue;
    if (!isYuantaSummaryVerticalLabelRow(labelRow)) continue;

    const nextRow = rows[rowIndex + 1];
    const nextRowHasLabel = nextRow?.some((cell) =>
      yuantaSummaryField(cell.text) !== undefined ||
      isYuantaSummaryIgnoredLabel(cell.text),
    ) ?? false;
    // Alternating label/value rows have labels in the following row; they are
    // deliberately left to pair extraction instead of being treated as a
    // vertical grid.
    if (nextRowHasLabel) continue;
    if (!nextRow) {
      throw new Error(
        "Yuanta settled statement summary vertical grid value row is missing.",
      );
    }
    found = true;
    if (labelRow.length !== nextRow.length ||
        !isYuantaSummaryVerticalValueRow(nextRow) ||
        labelRow.some((cell) => cell.hasSpan) ||
        nextRow.some((cell) => cell.hasSpan))
      throw new Error(
        "Yuanta settled statement summary vertical grid has ambiguous cell spans.",
      );

    const candidate: YuantaSummaryCandidate = {};
    const seenFields = new Set<YuantaSummaryField>();
    for (const [cellIndex, labelCell] of labelRow.entries()) {
      const field = yuantaSummaryField(labelCell.text);
      if (field === undefined) continue;
      if (seenFields.has(field))
        throw new Error(
          "Yuanta settled statement summary vertical grid has multiple candidate values.",
        );
      seenFields.add(field);
      const valueCell = nextRow[cellIndex];
      const value = cleanText(valueCell?.text);
      // Preserve an empty cell as a missing field so the normal candidate
      // validation path can report an incomplete or invalid
      // summary.  A non-empty label-like value is structurally ambiguous and
      // must still fail closed here.
      if (!value) continue;
      if (
        yuantaSummaryField(value) !== undefined ||
        isYuantaSummaryIgnoredLabel(value)
      )
        throw new Error(
          "Yuanta settled statement summary vertical grid value is missing or ambiguous.",
        );
      setYuantaSummaryCandidateField(candidate, field, value, {
        layout: "vertical-grid-same-column",
        labelTagName: labelCell.tagName,
        valueTagName: valueCell?.tagName ?? null,
        rowIndex,
        cellIndex,
      });
    }
    assertYuantaVerticalCandidateEvidence(candidate);
    addYuantaSummaryCandidate(candidates, candidate);
  }
  return { found, candidates };
}

function hasYuantaSummaryRequiredCandidateValues(
  candidate: YuantaSummaryCandidate,
): boolean {
  return YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.every((field) => {
    const value = candidate[field];
    return value !== undefined &&
      normalizedYuantaSummaryCandidateValue(field, value) !== undefined;
  });
}

function yuantaSummaryCandidatesEquivalent(
  left: YuantaSummaryCandidate,
  right: YuantaSummaryCandidate,
): boolean {
  const fields = new Set<YuantaSummaryField>([
    ...(Object.keys(left) as YuantaSummaryField[]),
    ...(Object.keys(right) as YuantaSummaryField[]),
  ]);
  for (const field of fields) {
    const leftValue = left[field];
    const rightValue = right[field];
    if ((leftValue === undefined) !== (rightValue === undefined)) return false;
    if (leftValue === undefined || rightValue === undefined) continue;
    const normalizedLeft = normalizedYuantaSummaryCandidateValue(field, leftValue);
    const normalizedRight = normalizedYuantaSummaryCandidateValue(field, rightValue);
    if (normalizedLeft !== undefined && normalizedRight !== undefined) {
      if (normalizedLeft !== normalizedRight) return false;
    } else if (cleanText(leftValue) !== cleanText(rightValue)) {
      return false;
    }
  }
  return true;
}

function uniqueYuantaSummaryCandidates(
  candidates: readonly YuantaSummaryCandidate[],
): YuantaSummaryCandidate[] {
  const unique: YuantaSummaryCandidate[] = [];
  for (const candidate of candidates) {
    if (!unique.some((existing) => yuantaSummaryCandidatesEquivalent(existing, candidate)))
      unique.push(candidate);
  }
  return unique;
}

function removeYuantaSummaryCandidateField(
  candidate: YuantaSummaryCandidate,
  field: YuantaSummaryField,
): YuantaSummaryCandidate {
  const withoutField = cloneYuantaSummaryCandidate(candidate);
  delete withoutField[field];
  const evidence = withoutField[YUANTA_SUMMARY_FIELD_EVIDENCE];
  if (evidence) {
    const remainingEvidence = { ...evidence };
    delete remainingEvidence[field];
    if (Object.keys(remainingEvidence).length > 0)
      withoutField[YUANTA_SUMMARY_FIELD_EVIDENCE] = remainingEvidence;
    else delete withoutField[YUANTA_SUMMARY_FIELD_EVIDENCE];
  }
  return withoutField;
}

function removeYuantaSummaryCandidateOverlaps(
  candidate: YuantaSummaryCandidate,
  protectedCandidates: readonly YuantaSummaryCandidate[],
): YuantaSummaryCandidate {
  let result = candidate;
  for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
    const value = candidate[field];
    if (!value) continue;
    const protectedCandidate = protectedCandidates.find(
      (item) => item[field] !== undefined,
    );
    if (!protectedCandidate) continue;
    const protectedValue = protectedCandidate[field]!;
    const normalizedValue = normalizedYuantaSummaryCandidateValue(field, value);
    const normalizedProtected = normalizedYuantaSummaryCandidateValue(
      field,
      protectedValue,
    );
    if (
      normalizedValue !== undefined &&
      normalizedProtected !== undefined &&
      normalizedValue !== normalizedProtected
    )
      throw new Error(
        `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
      );
    if (
      normalizedValue === undefined &&
      normalizedProtected === undefined &&
      cleanText(value) !== cleanText(protectedValue)
    )
      throw new Error(
        `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
      );
    result = removeYuantaSummaryCandidateField(result, field);
  }
  return result;
}

function reconcileYuantaVerticalPeriodCandidates(
  authoritative: YuantaSummaryCandidate,
  alternatives: readonly YuantaSummaryCandidate[],
  authoritativeFields: readonly YuantaSummaryField[] = ["period"],
): YuantaSummaryCandidate[] {
  return alternatives.map((candidate) => {
    let result = candidate;
    for (const field of authoritativeFields) {
      const authoritativeValue = authoritative[field];
      const alternativeValue = result[field];
      if (alternativeValue === undefined) continue;
      const normalizedAuthoritative = authoritativeValue === undefined
        ? undefined
        : normalizedYuantaSummaryCandidateValue(field, authoritativeValue);
      const normalizedAlternative = normalizedYuantaSummaryCandidateValue(
        field,
        alternativeValue,
      );
      if (
        normalizedAuthoritative !== undefined &&
        normalizedAlternative !== undefined &&
        normalizedAuthoritative !== normalizedAlternative
      )
        throw new Error(
          `Yuanta settled statement summary has conflicting ${field} column evidence.`,
        );
      result = removeYuantaSummaryCandidateField(result, field);
    }
    return result;
  });
}

function completeYuantaSummaryCandidatesFromVerticalGrid(
  candidates: readonly YuantaSummaryCandidate[],
): YuantaSummaryCandidate[] {
  const complete: YuantaSummaryCandidate[] = [];
  let current: YuantaSummaryCandidate | undefined;
  const flush = () => {
    if (current && hasYuantaSummaryRequiredCandidateValues(current))
      complete.push(current);
    current = undefined;
  };
  for (const candidate of candidates) {
    if (candidate.period) {
      flush();
      current = cloneYuantaSummaryCandidate(candidate);
      continue;
    }
    if (!current) continue;
    mergeYuantaSummaryCandidate(current, candidate);
  }
  flush();
  return complete;
}

function assertYuantaSummaryExtractionAgreement(
  primary: readonly YuantaSummaryCandidate[],
  alternative: readonly YuantaSummaryCandidate[],
): void {
  const primaryComplete = primary.filter(hasYuantaSummaryRequiredCandidateValues);
  const alternativeComplete = alternative.filter(hasYuantaSummaryRequiredCandidateValues);
  if (primaryComplete.length === 0 || alternativeComplete.length === 0) return;
  for (const candidate of alternativeComplete) {
    if (!primaryComplete.some((existing) =>
      yuantaSummaryCandidatesEquivalent(existing, candidate),
    ))
      throw new Error(
        "Yuanta settled statement summary has conflicting extraction strategies.",
      );
  }
}

function candidatesFromYuantaSummaryStructuredHeaderRows(
  rows: readonly YuantaSummaryStructuredCell[][],
): { foundHeader: boolean; candidates: YuantaSummaryCandidate[] } {
  const candidates: YuantaSummaryCandidate[] = [];
  let foundHeader = false;
  for (let headerIndex = 0; headerIndex < rows.length; headerIndex += 1) {
    const header = rows[headerIndex]!;
    if (!isYuantaSummaryStructuredHeaderRow(header)) continue;
    foundHeader = true;
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      if (isYuantaSummaryStructuredHeaderRow(row)) break;
      // A row containing another recognized label is a new local layout, not
      // data for this header. Pair extraction will handle it separately.
      if (row.some((cell) => yuantaSummaryField(cell.text) !== undefined)) break;
      addYuantaSummaryCandidate(
        candidates,
        candidateFromYuantaStructuredHeaderRow(header, row),
      );
    }
  }
  return { foundHeader, candidates };
}

function candidatesFromYuantaSummaryKeyValueRows(
  rows: readonly string[][],
): YuantaSummaryCandidate[] {
  const candidates: YuantaSummaryCandidate[] = [];
  let current: YuantaSummaryCandidate = {};
  const flush = () => {
    if (Object.keys(current).length > 0) addYuantaSummaryCandidate(candidates, current);
    current = {};
  };
  for (const row of rows) {
    for (let index = 0; index + 1 < row.length; index += 1) {
      const field = yuantaSummaryField(row[index] ?? "");
      const value = cleanText(row[index + 1]);
      if (
        !field ||
        !value ||
        yuantaSummaryField(value) !== undefined ||
        isYuantaSummaryIgnoredLabel(value)
      )
        continue;
      if (field === "period" && current.period) flush();
      setYuantaSummaryCandidateField(current, field, value, {
        ...UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
        layout: "same-row-adjacent",
        rowIndex: rows.indexOf(row),
        cellIndex: index,
      });
    }
  }
  flush();
  return candidates;
}

function candidatesFromYuantaSummaryTable(
  tableHtml: string,
  requireAttestedPeriodColumn = false,
): YuantaSummaryCandidate[] {
  const rows = parseHtmlRowsFromString(tableHtml);
  const structuredRows = parseYuantaSummaryStructuredRows(tableHtml);
  const verticalPeriod = requireAttestedPeriodColumn
    ? candidatesFromYuantaAttestedPeriodColumn(structuredRows)
    : candidatesFromYuantaSummaryVerticalPeriodColumn(structuredRows);
  const attestedBalance = requireAttestedPeriodColumn
    ? candidateFromYuantaAttestedBalanceColumn(structuredRows)
    : undefined;
  const vertical = candidatesFromYuantaSummaryVerticalGrid(
    structuredRows,
    verticalPeriod.mixedNextRow ? verticalPeriod.labelRowIndex : null,
  );
  const candidates: YuantaSummaryCandidate[] = [];
  const structured = candidatesFromYuantaSummaryStructuredHeaderRows(
    structuredRows,
  );
  const pairCandidates = candidatesFromYuantaSummaryKeyValueRows(rows);
  if (
    verticalPeriod.found &&
    (verticalPeriod.mixedNextRow || requireAttestedPeriodColumn)
  ) {
    const authoritativePeriod = cloneYuantaSummaryCandidate(
      verticalPeriod.candidate!,
    );
    if (attestedBalance)
      mergeYuantaSummaryCandidate(authoritativePeriod, attestedBalance);
    const authoritativeFields: YuantaSummaryField[] =
      requireAttestedPeriodColumn ? ["period", "balance"] : ["period"];
    const verticalCandidates = reconcileYuantaVerticalPeriodCandidates(
      authoritativePeriod,
      vertical.candidates,
      authoritativeFields,
    );
    const structuredCandidates = reconcileYuantaVerticalPeriodCandidates(
      authoritativePeriod,
      structured.candidates,
      authoritativeFields,
    ).map((candidate) =>
      removeYuantaSummaryCandidateOverlaps(candidate, verticalCandidates),
    );
    const pairCandidatesWithoutAttestedColumns =
      reconcileYuantaVerticalPeriodCandidates(
        authoritativePeriod,
        pairCandidates,
        authoritativeFields,
      ).map((candidate) =>
        removeYuantaSummaryCandidateOverlaps(
          candidate,
          [...verticalCandidates, ...structuredCandidates],
        ),
      );
    return uniqueYuantaSummaryCandidates([
      authoritativePeriod,
      ...verticalCandidates,
      ...structuredCandidates,
      ...pairCandidatesWithoutAttestedColumns,
    ]);
  }
  if (vertical.found) {
    if (structured.foundHeader) {
      // The established header-matrix/grouped-row extractor owns tables whose
      // label rows are unambiguous on their own.  Still run the vertical pass
      // above so spans, missing value rows, and duplicate labels fail closed;
      // do not let its first label/value pair truncate a multi-row matrix.
      if (pairCandidates.length > 0)
        throw new Error(
          "Yuanta settled statement summary has ambiguous extraction strategies.",
        );
      return structured.candidates.length > 0
        ? structured.candidates
        : uniqueYuantaSummaryCandidates(vertical.candidates);
    }
    const primaryCandidates = [...vertical.candidates, ...structured.candidates];
    assertYuantaSummaryExtractionAgreement(
      [
        ...completeYuantaSummaryCandidatesFromVerticalGrid(vertical.candidates),
        ...structured.candidates,
      ],
      pairCandidates,
    );
    return uniqueYuantaSummaryCandidates(primaryCandidates);
  }
  if (structured.foundHeader) {
    if (pairCandidates.length > 0)
      throw new Error(
        "Yuanta settled statement summary has ambiguous extraction strategies.",
      );
    return structured.candidates;
  }
  const headerIndex = yuantaSummaryTableHeaderIndex(rows);
  if (headerIndex >= 0) {
    const headers = rows[headerIndex]!;
    for (const row of rows.slice(headerIndex + 1)) {
      addYuantaSummaryCandidate(
        candidates,
        candidateFromYuantaSummaryRow(headers, row),
      );
    }
    if (candidates.length > 0) return candidates;
  }

  return candidatesFromYuantaSummaryKeyValueRows(rows);
}

function escapedYuantaSummaryLabel(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateFromYuantaSummaryText(text: string): YuantaSummaryCandidate {
  const labels: Record<YuantaSummaryField, readonly string[]> = {
    period: ["帳單月份", "帳單期別", "對帳單月份", "結帳月份", "帳單週期"],
    statementId: ["帳單編號", "帳單號碼", "對帳單編號", "帳單序號"],
    closeDate: ["結帳日", "結帳日期", "帳單結帳日", "本期結帳日"],
    issueDate: ["出帳日", "出帳日期", "帳單日", "帳單日期"],
    dueDate: ["繳款截止日", "繳款期限", "到期日"],
    balance: [
      "本期應繳總額",
      "本期應繳總金額",
      "本期應繳金額",
      "應繳總額",
      "應繳金額",
    ],
    minimumPayment: [
      "本期最低應繳額",
      "本期最低應繳金額",
      "最低應繳金額",
      "最低應繳額",
      "最低應繳",
    ],
    paymentStatus: ["繳費狀態", "繳款狀態", "付款狀態"],
  };
  const allLabels = Object.values(labels)
    .flat()
    .map(escapedYuantaSummaryLabel)
    .join("|");
  const candidate: YuantaSummaryCandidate = {};
  for (const [field, aliases] of Object.entries(labels) as Array<
    [YuantaSummaryField, readonly string[]]
  >) {
    const aliasPattern = aliases.map(escapedYuantaSummaryLabel).join("|");
    const match = text.match(
      new RegExp(
        `(?:${aliasPattern})\\s*[：:]?\\s*(.*?)(?=\\s*(?:${allLabels})\\s*[：:]?|$)`,
        "iu",
      ),
    );
    const value = cleanText(match?.[1]);
    if (value)
      setYuantaSummaryCandidateField(candidate, field, value, {
        ...UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
        layout: "text-label-value",
      });
  }
  return candidate;
}

type YuantaSummaryCandidateGroup = {
  tables: YuantaSummaryTableMatch[];
  fragment: string;
};

function normalizedYuantaSummaryCandidateValue(
  field: YuantaSummaryField,
  value: string,
): string | undefined {
  try {
    if (field === "period") return normalizeYuantaSummaryPeriod(value);
    if (
      field === "closeDate" ||
      field === "issueDate" ||
      field === "dueDate"
    )
      return normalizeYuantaSummaryDate(value, field);
    if (field === "balance" || field === "minimumPayment")
      return normalizeYuantaSummaryAmount(value, field);
  } catch {
    return undefined;
  }
  return cleanText(value);
}

function mergeYuantaSummaryCandidate(
  target: YuantaSummaryCandidate,
  source: YuantaSummaryCandidate,
  options: { ignoreUncomparableDuplicate?: boolean } = {},
): void {
  for (const [field, value] of Object.entries(source) as Array<
    [YuantaSummaryField, string | undefined]
  >) {
    if (!value) continue;
    const existing = target[field];
    if (!existing) {
      setYuantaSummaryCandidateFieldFromCandidate(target, field, value, source);
      continue;
    }
    const normalizedExisting = normalizedYuantaSummaryCandidateValue(
      field,
      existing,
    );
    const normalizedValue = normalizedYuantaSummaryCandidateValue(field, value);
    if (
      normalizedExisting !== undefined &&
      normalizedValue !== undefined
    ) {
      if (normalizedExisting !== normalizedValue)
        throw new Error(
          `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
        );
      continue;
    }
    if (
      options.ignoreUncomparableDuplicate &&
      normalizedExisting !== undefined
    )
      continue;
    if (cleanText(existing) !== cleanText(value))
      throw new Error(
        `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
      );
  }
}

function supplementYuantaSummaryCandidateWithMissingFields(
  target: YuantaSummaryCandidate,
  source: YuantaSummaryCandidate,
): void {
  const missingFields: YuantaSummaryCandidate = {};
  for (const [field, value] of Object.entries(source) as Array<
    [YuantaSummaryField, string | undefined]
  >) {
    if (value && !target[field])
      setYuantaSummaryCandidateFieldFromCandidate(
        missingFields,
        field,
        value,
        source,
      );
  }
  mergeYuantaSummaryCandidate(target, missingFields, {
    ignoreUncomparableDuplicate: true,
  });
}

function hasYuantaSummaryRequiredCandidateFields(
  candidate: YuantaSummaryCandidate,
): boolean {
  return ["period", "closeDate", "dueDate", "balance", "minimumPayment"].every(
    (field) => Boolean(candidate[field as YuantaSummaryField]),
  );
}

const YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER = [
  "period",
  "closeDate",
  "dueDate",
  "balance",
  "minimumPayment",
] as const;

type YuantaSummaryRequiredField =
  (typeof YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER)[number];

function yuantaSummaryCandidateGroups(html: string): YuantaSummaryCandidateGroup[] {
  const tables = yuantaSummaryTableMatches(html);
  if (tables.length === 0)
    return yuantaSummaryResultFragments(html).map((fragment) => ({
      tables: [],
      fragment,
    }));

  const contexts = tables.map((table) => ({
    table,
    blocks: enclosingSummaryBlocks(html, table.start, table.end),
  }));
  const parents = contexts.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstByBlock = new Map<string, number>();
  contexts.forEach((context, index) => {
    context.blocks.forEach((block) => {
      const first = firstByBlock.get(block);
      if (first === undefined) firstByBlock.set(block, index);
      else union(first, index);
    });
  });

  const grouped = new Map<number, typeof contexts>();
  contexts.forEach((context, index) => {
    const root = find(index);
    const group = grouped.get(root) ?? [];
    group.push(context);
    grouped.set(root, group);
  });
  return [...grouped.values()].map((group) => {
    const sharedBlocks = group[0]!.blocks.filter((block) =>
      group.every((context) => context.blocks.includes(block)),
    );
    const fragment = [...sharedBlocks, ...group.flatMap((context) => context.blocks), ...group.map((context) => context.table.html)]
      .sort((left, right) => right.length - left.length)[0]!;
    return {
      tables: group.map((context) => context.table),
      fragment,
    };
  });
}

function yuantaSummaryCandidatesFromHtml(
  html: string,
): YuantaSummaryCandidate[] {
  return yuantaSummaryCandidatesFromGroups(yuantaSummaryCandidateGroups(html));
}

function isYuantaSummaryRwdTable(tableHtml: string): boolean {
  const opening = tableHtml.match(/^<table\b[^>]*>/iu)?.[0] ?? "";
  return /\brwdTable\b/iu.test(htmlAttribute(opening, "class"));
}

function yuantaSummaryCandidatesFromGroups(
  groups: readonly YuantaSummaryCandidateGroup[],
): YuantaSummaryCandidate[] {
  const candidates: YuantaSummaryCandidate[] = [];
  for (const group of groups) {
    const firstRwdTableIndex = group.tables.findIndex((table) =>
      isYuantaSummaryRwdTable(table.html),
    );
    const tableCandidates = group.tables.flatMap((table, tableIndex) =>
      candidatesFromYuantaSummaryTable(
        table.html,
        tableIndex === firstRwdTableIndex,
      ),
    );
    const periodCandidates = tableCandidates.filter(
      (candidate) => candidate.period,
    );
    const partialCandidates = tableCandidates.filter(
      (candidate) => !candidate.period,
    );
    const textCandidate = candidateFromYuantaSummaryText(
      stripHtml(group.fragment),
    );

    if (periodCandidates.length > 1) {
      if (partialCandidates.length > 0)
        throw new Error(
          "Yuanta settled statement summary has ambiguous statement boundaries.",
        );
      candidates.push(...periodCandidates);
      continue;
    }

    if (periodCandidates.length === 1) {
      const merged = cloneYuantaSummaryCandidate(periodCandidates[0]!);
      for (const candidate of partialCandidates)
        mergeYuantaSummaryCandidate(merged, candidate);
      if (!hasYuantaSummaryRequiredCandidateFields(merged))
        supplementYuantaSummaryCandidateWithMissingFields(merged, textCandidate);
      candidates.push(merged);
      continue;
    }

    const merged: YuantaSummaryCandidate = {};
    for (const candidate of partialCandidates)
      mergeYuantaSummaryCandidate(merged, candidate);
    supplementYuantaSummaryCandidateWithMissingFields(merged, textCandidate);
    if (Object.keys(merged).length > 0) candidates.push(merged);
  }
  return candidates;
}

function normalizeYuantaSummaryPeriod(value: string): string {
  const periodLabelPattern =
    "(?:帳單月份|帳單期別|對帳單月份|結帳月份|帳單週期)";
  let normalized = toAsciiDigits(stripHtml(value)).normalize("NFKC");
  normalized = normalized
    .replace(
      new RegExp(`^${periodLabelPattern}\\s*[：:]?\\s*`, "u"),
      "",
    )
    .replace(/^[\s:：([{【「『]+/u, "")
    .replace(/[\s:：)\]}】」』，,。；;]+$/u, "");
  const slashCategoryTwo = normalized.match(
    /^(\d{4})\s*\/\s*(\d{1,2})\s*(?:月(?:份)?|期)$/u,
  );
  if (slashCategoryTwo) {
    const month = Number(slashCategoryTwo[2]);
    if (month < 1 || month > 12)
      throw new Error("Yuanta settled statement period is invalid.");
    return `${slashCategoryTwo[1]}/${String(month).padStart(2, "0")}`;
  }
  const match = normalized.match(
    /^(民國\s*)?(\d{3,4})(?:\s*年\s*(\d{1,2})\s*月(?:份)?|\s*[/\.\-]\s*(\d{1,2})(?:月(?:份)?)?)$/u,
  );
  if (!match) throw new Error("Yuanta settled statement period is invalid.");
  const eraPrefix = Boolean(match[1]);
  const yearText = match[2]!;
  const monthText = match[3] ?? match[4];
  if (!monthText) throw new Error("Yuanta settled statement period is invalid.");
  if (eraPrefix && yearText.length !== 3)
    throw new Error("Yuanta settled statement period is ambiguous.");
  const year = Number(yearText);
  if (year < 1 || (eraPrefix && year > 999))
    throw new Error("Yuanta settled statement period is invalid.");
  const month = Number(monthText);
  if (month < 1 || month > 12)
    throw new Error("Yuanta settled statement period is invalid.");
  return `${yearText}/${String(month).padStart(2, "0")}`;
}

function normalizeYuantaSummaryDate(value: string, label: string): string {
  const normalized = toAsciiDigits(stripHtml(value))
    .replace(/[年\/\.\-]/gu, "-")
    .replace(/月/gu, "-")
    .replace(/日/gu, "")
    .replace(/--+/gu, "-");
  const match = normalized.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/u);
  if (!match) throw new Error(`Yuanta ${label} is invalid.`);
  const year = match[1]!.length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error(`Yuanta ${label} is invalid.`);
  return date.toISOString().slice(0, 10);
}

function normalizeYuantaSummaryAmount(value: string, label: string): string {
  const normalized = stripHtml(value)
    .normalize("NFKC")
    .replace(/[,，\s]/gu, "")
    .replace(/^(?:NT\$|TWD|新臺幣|新台幣|元)/iu, "");
  if (!/^\+?\d+(?:\.\d+)?$/u.test(normalized))
    throw new Error(`Yuanta ${label} is invalid.`);
  return normalized.replace(/^\+/u, "");
}

function wrapYuantaCreditCardSummaryParseError(
  error: unknown,
): YuantaCreditCardSummaryParseError {
  if (error instanceof YuantaCreditCardSummaryParseError) return error;
  const message = error instanceof Error ? error.message : "Yuanta summary parsing failed.";
  return new YuantaCreditCardSummaryParseError(message);
}

/**
 * Parse issuer-settled summary evidence without treating a transaction
 * query's selected month as a billing statement. Both matrix tables and the
 * label/value layout used by the bank are accepted; incomplete rows fail
 * closed instead of being promoted to canonical statements.
 */
export function parseYuantaCreditCardSettledStatementSummaries(
  html: string,
): YuantaCreditCardIssuerSummary[] {
  if (hasUntraversedYuantaSummaryPager(html))
    throw new YuantaCreditCardSummaryParseError(
        "YuanTa settled statement summary has untraversed pagination.",
      );
  return parseYuantaCreditCardSettledStatementSummaryPage(html);
}

function requiredYuantaSelectedMonthPeriod(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("Yuanta selected provider month label is required.");
  try {
    return normalizeYuantaSummaryPeriod(value);
  } catch {
    throw new Error("Yuanta selected provider month label is invalid.");
  }
}

/**
 * Parse the one issuer-settled summary attached to one billed history query.
 * The provider query index is only a response binding; period authority must
 * still come from the response's own `帳單月份` field.
 */
export function parseYuantaCreditCardSettledStatementHistoryPage(
  html: string,
  month: YuantaCreditCardMonthOption,
  pageOrdinal: number,
): YuantaCreditCardHistorySettledSummaryPage {
  if (
    !Number.isSafeInteger(month.index) ||
    month.index < 0 ||
    !Number.isSafeInteger(pageOrdinal) ||
    pageOrdinal < 0
  )
    throw new Error("Yuanta history summary page association is invalid.");
  const summaries = parseYuantaCreditCardSettledStatementSummaries(html);
  if (summaries.length !== 1)
    throw new Error(
      "Yuanta history response must contain exactly one issuer-settled summary.",
    );
  const summary = summaries[0]!;
  const selectedPeriod = requiredYuantaSelectedMonthPeriod(month.label);
  if (selectedPeriod !== summary.period)
    throw new Error(
      "Yuanta history issuer period does not match the selected provider month.",
    );
  return {
    sourceKey: YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY,
    monthIndex: month.index,
    pageOrdinal,
    summary,
  };
}

function parseYuantaCreditCardSettledStatementSummaryPage(
  html: string,
): YuantaCreditCardIssuerSummary[] {
  try {
    return parseYuantaCreditCardSettledStatementSummaryPageUnsafe(html);
  } catch (error) {
    throw wrapYuantaCreditCardSummaryParseError(error);
  }
}

function parseYuantaCreditCardSettledStatementSummaryPageUnsafe(
  html: string,
): YuantaCreditCardIssuerSummary[] {
  const candidates = yuantaSummaryCandidatesFromHtml(html);
  if (candidates.length === 0)
    throw new Error("Yuanta settled statement summary is missing issuer fields.");

  const summaries = candidates.map((candidate) => {
    if (!candidate.period || !candidate.closeDate || !candidate.dueDate ||
        !candidate.balance || !candidate.minimumPayment)
      throw new Error("Yuanta settled statement summary is incomplete.");
    const closeDate = normalizeYuantaSummaryDate(candidate.closeDate, "close date");
    const issueDate = candidate.issueDate
      ? normalizeYuantaSummaryDate(candidate.issueDate, "issue date")
      : closeDate;
    const dueDate = normalizeYuantaSummaryDate(candidate.dueDate, "due date");
    if (issueDate < closeDate || dueDate < issueDate)
      throw new Error("Yuanta settled statement summary dates are not ordered.");
    return {
      period: normalizeYuantaSummaryPeriod(candidate.period),
      ...(candidate.statementId ? { statementId: cleanText(candidate.statementId) } : {}),
      closeDate,
      issueDate,
      dueDate,
      balance: normalizeYuantaSummaryAmount(candidate.balance, "balance"),
      minimumPayment: normalizeYuantaSummaryAmount(
        candidate.minimumPayment,
        "minimum payment",
      ),
      ...(candidate.paymentStatus
        ? { paymentStatus: cleanText(candidate.paymentStatus) }
        : {}),
    } satisfies YuantaCreditCardIssuerSummary;
  });
  const periods = new Set<string>();
  const statementIds = new Set<string>();
  for (const summary of summaries) {
    if (periods.has(summary.period))
      throw new Error("Yuanta settled statement summary periods must be unique.");
    periods.add(summary.period);
    if (summary.statementId) {
      if (statementIds.has(summary.statementId))
        throw new Error("Yuanta settled statement identifiers must be unique.");
      statementIds.add(summary.statementId);
    }
  }
  return summaries;
}

function mergeYuantaCreditCardIssuerSummaries(
  pages: readonly YuantaCreditCardIssuerSummary[][],
): YuantaCreditCardIssuerSummary[] {
  const byPeriod = new Map<string, YuantaCreditCardIssuerSummary>();
  for (const page of pages) {
    for (const summary of page) {
      const existing = byPeriod.get(summary.period);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(summary))
          throw new Error(
            "Yuanta settled statement pagination repeated a period with conflicting evidence.",
          );
        continue;
      }
      byPeriod.set(summary.period, summary);
    }
  }
  return [...byPeriod.values()];
}

export async function traverseYuantaCreditCardSettledStatementSummaryPages(
  firstHtml: string,
  loadNextPage: (
    request: YuantaCreditCardSummaryPageRequest,
  ) => Promise<string>,
): Promise<YuantaCreditCardSummaryTraversal> {
  const pages: YuantaCreditCardSummaryPageEvidence[] = [];
  const parsedPages: YuantaCreditCardIssuerSummary[][] = [];
  const pageFingerprints = new Set<string>();
  const pageRequests = new Set<string>();
  let html = firstHtml;

  while (true) {
    if (pages.length >= YUANTA_SUMMARY_MAX_PAGES)
      throw new YuantaCreditCardSummaryParseError(
        "Yuanta settled statement pagination exceeded the safe page limit.",
      );
    const pageFingerprint = yuantaSummaryPageFingerprint(html);
    if (pageFingerprints.has(pageFingerprint))
      throw new YuantaCreditCardSummaryParseError(
        "Yuanta settled statement pagination repeated page.",
      );
    pageFingerprints.add(pageFingerprint);
    const summaries = parseYuantaCreditCardSettledStatementSummaryPage(html);
    parsedPages.push(summaries);
    const controls = yuantaSummaryResultFragments(html).flatMap(
      (fragment) => summaryPagerControlsFromFragment(fragment),
    );
    const nextControl = controls[0];
    const nextPageTarget = nextControl
      ? yuantaSummaryPagerTarget(nextControl)
      : null;
    pages.push({
      pageOrdinal: pages.length,
      periods: summaries.map((summary) => summary.period),
      terminal: nextPageTarget === null,
      nextPageTarget,
      pageFingerprint,
    });
    if (nextPageTarget === null) break;
    const requestKey = `${pageFingerprint}\u0000${nextPageTarget}`;
    if (pageRequests.has(requestKey))
      throw new YuantaCreditCardSummaryParseError(
        "Yuanta settled statement pagination repeated page request.",
      );
    pageRequests.add(requestKey);
    html = await loadNextPage({
      pageOrdinal: pages.length,
      pageTarget: nextPageTarget,
    });
  }

  return {
    summaries: mergeYuantaCreditCardIssuerSummaries(parsedPages),
    pages,
  };
}

function nextYuantaIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Derive only cycles whose predecessor close date is present as evidence. */
export function resolveYuantaSettledStatementCycles(
  summaries: readonly YuantaCreditCardIssuerSummary[],
): YuantaCreditCardStatementSummary[] {
  if (summaries.length < 2)
    throw new Error("Yuanta needs at least two consecutive issuer summaries.");
  const normalized = summaries.map((summary) => ({
    ...summary,
    period: normalizeYuantaSummaryPeriod(summary.period),
    closeDate: normalizeYuantaSummaryDate(summary.closeDate, "close date"),
    issueDate: normalizeYuantaSummaryDate(summary.issueDate, "issue date"),
    dueDate: normalizeYuantaSummaryDate(summary.dueDate, "due date"),
    balance: normalizeYuantaSummaryAmount(summary.balance, "balance"),
    minimumPayment: normalizeYuantaSummaryAmount(
      summary.minimumPayment,
      "minimum payment",
    ),
  }));
  if (
    normalized.some(
      (summary) =>
        summary.issueDate < summary.closeDate ||
        summary.dueDate < summary.issueDate,
    )
  )
    throw new Error("Yuanta settled statement dates are not ordered.");
  const periods = new Set(normalized.map((summary) => summary.period));
  if (periods.size !== normalized.length)
    throw new Error("Yuanta issuer summary periods must be unique.");
  const sourceOrder = normalized.map((summary) => summary.closeDate);
  const ascending = sourceOrder.every(
    (date, index) => index === 0 || sourceOrder[index - 1]! < date,
  );
  const descending = sourceOrder.every(
    (date, index) => index === 0 || sourceOrder[index - 1]! > date,
  );
  if (!ascending && !descending)
    throw new Error("Yuanta issuer statement close dates are not monotonic.");
  const ordered = normalized.slice().sort((left, right) =>
    left.closeDate.localeCompare(right.closeDate) ||
    left.period.localeCompare(right.period),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.closeDate >= ordered[index]!.closeDate)
      throw new Error("Yuanta issuer statement close dates are not monotonic.");
  }
  return ordered.slice(1).map((summary, index) => ({
    period: summary.period,
    ...(summary.statementId ? { statementId: summary.statementId } : {}),
    cycleStart: nextYuantaIsoDate(ordered[index]!.closeDate),
    cycleEnd: summary.closeDate,
    issueDate: summary.issueDate,
    dueDate: summary.dueDate,
    balance: summary.balance,
    minimumPayment: summary.minimumPayment,
    ...(summary.paymentStatus ? { paymentStatus: summary.paymentStatus } : {}),
  }));
}

/**
 * Reassemble history-page evidence without allowing a page to migrate to a
 * different selected month.  The returned order is the provider query order;
 * cycle resolution separately orders the issuer close dates.
 */
export function collectYuantaCreditCardHistorySummaries(
  pages: readonly YuantaCreditCardHistorySettledSummaryPage[],
  selectedMonths: readonly YuantaCreditCardMonthOption[],
): YuantaCreditCardIssuerSummary[] {
  if (pages.length !== selectedMonths.length)
    throw new Error(
      "Yuanta history summary pages must cover every selected billed month.",
    );
  const monthIndexes = new Set<number>();
  const periods = new Set<string>();
  const summaries: YuantaCreditCardIssuerSummary[] = [];
  for (const [pageOrdinal, page] of pages.entries()) {
    const selectedMonth = selectedMonths[pageOrdinal];
    if (
      !selectedMonth ||
      page.pageOrdinal !== pageOrdinal ||
      page.monthIndex !== selectedMonth.index ||
      page.sourceKey !== YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY
    )
      throw new Error(
        "Yuanta history summary page association is invalid.",
      );
    if (monthIndexes.has(page.monthIndex))
      throw new Error("Yuanta history summary month indexes must be unique.");
    monthIndexes.add(page.monthIndex);
    const summary = page.summary;
    if (
      !summary.period ||
      !summary.closeDate ||
      !summary.dueDate ||
      !summary.balance ||
      !summary.minimumPayment
    )
      throw new Error("Yuanta history issuer summary is incomplete.");
    const normalizedPeriod = normalizeYuantaSummaryPeriod(summary.period);
    const selectedPeriod = requiredYuantaSelectedMonthPeriod(selectedMonth.label);
    if (selectedPeriod !== normalizedPeriod)
      throw new Error(
        "Yuanta history issuer period does not match the selected provider month.",
      );
    if (periods.has(normalizedPeriod))
      throw new Error("Yuanta history issuer summary periods must be unique.");
    periods.add(normalizedPeriod);
    summaries.push({ ...summary, period: normalizedPeriod });
  }
  return summaries;
}
