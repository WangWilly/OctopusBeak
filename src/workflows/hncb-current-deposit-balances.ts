import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
import type { Frame, Locator, Page } from "playwright";
import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import {
  type ProviderEndpoint,
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type ProviderEvidence,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import type { BrowserScope } from "./frame-scope.ts";
import type { HncbMenuRoute, HncbNetbankSite } from "./hncb-netbank-site.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";
import {
  assembleCurrentDepositCapture,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentBalanceCaptureMatching,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

const DETAIL_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["hncb/domestic-deposit/current-balance-v1"];
const OVERVIEW_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["hncb/domestic-deposit/current-balance-overview-v1"];

export const HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION =
  "com.lb.wibc.trx.EAccDDSummary" as const;
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION =
  "com.lb.wibc.trx.AcctInfoInq" as const;

export const HNCB_CURRENT_DEPOSIT_HEADERS = [
  "身份證字號/統一編號",
  "帳號(由小到大排序)",
  "幣別",
  "可用餘額",
  "本交金額",
  "本交抵用金額",
  "次交金額",
  "營業時間外\n未扣帳金額",
  "營業時間外\n未入帳金額",
  "圈存金額",
  "帳上餘額",
  "設質金額",
] as const;

/** The logical columns in HNCB's account-overview table after header spans. */
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS = [
  "帳號",
  "類別",
  "幣別",
  "帳上餘額",
  "原幣",
  "折合新台幣",
  "薪轉利率",
  "餘額查詢",
  "明細查詢",
  "轉帳",
  "其他查詢",
] as const;

type HncbCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  sourceLexeme: string;
}>;

/** A TrxDispatcher query whose first trx parameter names the transaction; the page adds others. */
function transactionQuery(transaction: string): RegExp {
  return new RegExp(`^\\?(?:(?!trx(?:[=&]|$))[^&]*&)*trx=${transaction.replaceAll(".", "\\.")}(?:&|$)`, "u");
}

/** The 帳戶總覽 GET, which must render HTML. */
const HNCB_CURRENT_DEPOSIT_OVERVIEW_ENDPOINT: ProviderEndpoint = {
  path: OVERVIEW_CONTRACT.endpointPath,
  method: "GET",
  contentType: /^text\/html(?:\s*;|$)/iu,
  search: transactionQuery(HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION),
};

/** The 活期存款 balance-page GET. */
const HNCB_CURRENT_DEPOSIT_DETAIL_ENDPOINT: ProviderEndpoint = {
  path: DETAIL_CONTRACT.endpointPath,
  method: "GET",
  search: transactionQuery(HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION),
};

/**
 * Either page may carry the snapshot; each parser accepts only its own
 * endpoint. The two routes share host and cache tokens, so the declaration
 * reads the detail route's; a check pins that the overview route agrees.
 */
export const HNCB_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "HNCB current deposit",
  host: DETAIL_CONTRACT.endpointHost,
  endpoints: [HNCB_CURRENT_DEPOSIT_OVERVIEW_ENDPOINT, HNCB_CURRENT_DEPOSIT_DETAIL_ENDPOINT],
  cacheControl: DETAIL_CONTRACT.requiredCacheTokens,
  providerDate: "required",
};

function requireEndpoint(
  response: VerifiedProviderResponse<"required">,
  endpoint: ProviderEndpoint,
): void {
  if (response.endpoint !== endpoint)
    throw new Error("HNCB current deposit response transaction is unexpected.");
}

/** The current-deposit declaration narrowed to one page's endpoint, the reply its menu route waits for. */
function endpointResponse(endpoint: ProviderEndpoint): ProviderResponseDeclaration<"required"> {
  return { ...HNCB_CURRENT_DEPOSIT_RESPONSE, endpoints: [endpoint] };
}

type HncbCurrentDepositBalanceRow = Readonly<{
  source: "hncb";
  accountNumber: string;
  currency: string;
  currencySourceLexeme: string;
  available: HncbCurrentDepositExactDecimal;
  ledger: HncbCurrentDepositExactDecimal;
  effectiveAt: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof DETAIL_CONTRACT.endpointPath;
    transaction: typeof HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION;
    status: 200;
    cacheControl: string;
    contractVersion: typeof DETAIL_CONTRACT.contractVersion;
    /** The exact authenticated response URL, retained when available. */
    url?: string;
  }>;
}>;

/**
 * Account-overview rows use the same balance shape as the detail snapshot,
 * but the provider may omit the currency cell for a zero-balance account.
 * Currency is resolved only after this row is joined to an admitted account.
 */
type HncbCurrentDepositOverviewBalanceRow = Readonly<{
  source: "hncb";
  accountNumber: string;
  currency: string;
  currencySourceLexeme: string;
  currencyResolution: "provider" | "missing";
  available: HncbCurrentDepositExactDecimal;
  ledger: HncbCurrentDepositExactDecimal;
  effectiveAt: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof OVERVIEW_CONTRACT.endpointPath;
    transaction: typeof HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION;
    status: 200;
    cacheControl: string;
    contractVersion: typeof OVERVIEW_CONTRACT.contractVersion;
    url: string;
  }>;
}>;

type HncbCurrentDepositSnapshotInput = Readonly<{
  rows: readonly (readonly string[])[];
  response: VerifiedProviderResponse<"required">;
}>;

const directTableRowsSelector =
  ":scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr";
const directRowCellsSelector = ":scope > th, :scope > td";

const HNCB_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "strip",
  grouping: "thousands",
  digits: "decimal",
};

function parseExactDecimal(
  value: string,
  label: string,
): HncbCurrentDepositExactDecimal {
  const sourceLexeme = collapseSourceWhitespace(value);
  const amount = parseProviderDecimal(sourceLexeme, HNCB_AMOUNT);
  if (!amount) throw new Error(`HNCB current deposit ${label} is not an exact decimal.`);
  return { ...amount, sourceLexeme };
}

function parseAccount(value: string, rowIndex: number): string {
  const normalized = collapseSourceWhitespace(value);
  // The result table renders a complete account number with two display-only
  // hyphen separators. Preserve the numeric identity after removing only
  // those provider formatting characters.
  const accountParts = normalized.split(/[-‐‑‒–—]/u);
  const compact = normalized.replace(/[-‐‑‒–—]/gu, "");
  if (
    !/^\d{6,24}$/u.test(compact) ||
    (accountParts.length !== 1 &&
      (accountParts.length !== 3 || accountParts.some((part) => !/^\d+$/u.test(part))))
  ) {
    throw new Error(`HNCB current deposit row ${rowIndex} account is invalid.`);
  }
  return compact;
}

function isUnavailableBalanceRow(values: readonly string[]): boolean {
  return (
    values.length === HNCB_CURRENT_DEPOSIT_HEADERS.length &&
    collapseSourceWhitespace(values[2] ?? "") === "" &&
    values.slice(3).every((value) => collapseSourceWhitespace(value) === "-")
  );
}

function parseCurrency(value: string, rowIndex: number): {
  value: string;
  sourceLexeme: string;
} {
  const sourceLexeme = collapseSourceWhitespace(value);
  const normalized = sourceLexeme.toUpperCase();
  const mapped = new Map([
    ["臺幣", "TWD"],
    ["台幣", "TWD"],
    ["新臺幣", "TWD"],
    ["新台幣", "TWD"],
  ]).get(normalized);
  const currency = mapped ?? normalized;
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new Error(`HNCB current deposit row ${rowIndex} currency is invalid.`);
  }
  return { value: currency, sourceLexeme };
}

function normalizedHeader(value: string): string {
  return collapseSourceWhitespace(value);
}

/** Parse only account, currency, available balance, and 帳上餘額. */
export function parseHncbCurrentDepositBalanceSnapshot(
  input: HncbCurrentDepositSnapshotInput,
): readonly HncbCurrentDepositBalanceRow[] {
  requireEndpoint(input.response, HNCB_CURRENT_DEPOSIT_DETAIL_ENDPOINT);
  if (input.rows.length === 0) throw new Error("HNCB current deposit table has no account rows.");

  const seen = new Set<string>();
  const rows: HncbCurrentDepositBalanceRow[] = [];
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== HNCB_CURRENT_DEPOSIT_HEADERS.length) {
      throw new Error(`HNCB current deposit row ${rowIndex} must have 12 cells.`);
    }
    const accountNumber = parseAccount(values[1] ?? "", rowIndex);
    if (isUnavailableBalanceRow(values)) continue;
    const parsedCurrency = parseCurrency(values[2] ?? "", rowIndex);
    const duplicateKey = `${accountNumber}\u0000${parsedCurrency.value}`;
    if (seen.has(duplicateKey)) {
      throw new Error(`HNCB current deposit has duplicate account/currency row ${rowIndex}.`);
    }
    seen.add(duplicateKey);
    rows.push({
      source: "hncb",
      accountNumber,
      currency: parsedCurrency.value,
      currencySourceLexeme: parsedCurrency.sourceLexeme,
      available: parseExactDecimal(values[3] ?? "", `row ${rowIndex} available balance`),
      ledger: parseExactDecimal(values[10] ?? "", `row ${rowIndex} ledger balance`),
      effectiveAt: input.response.providerDate.effectiveAt,
      providerHttpDate: input.response.providerDate.raw,
      observedAt: input.response.observedAt,
      sourceEvidence: {
        endpoint: DETAIL_CONTRACT.endpointPath,
        transaction: HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION,
        status: 200,
        cacheControl: input.response.cacheControl,
        contractVersion: DETAIL_CONTRACT.contractVersion,
        url: input.response.url.href,
      },
    });
  }
  return rows;
}

async function readCellTexts(row: Locator, selector: string): Promise<string[]> {
  const cells = row.locator(selector);
  const count = await cells.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(collapseSourceWhitespace(await cells.nth(index).innerText()));
  }
  return values;
}

/**
 * Locate the un-nested observed HNCB result table by its exact header row and
 * read its account rows' cell texts. Footer totals are left out.
 */
export async function readHncbCurrentDepositDetailCells(
  scope: Page | Frame | Locator,
): Promise<readonly (readonly string[])[]> {
  const scopedTables = scope.locator("table");
  const scopedTableCount = await scopedTables.count();
  const tables =
    scopedTableCount === 0
      ? [scope as Locator]
      : Array.from({ length: scopedTableCount }, (_, index) => scopedTables.nth(index));
  const tableCount = tables.length;
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const table = tables[tableIndex]!;
    if ((await table.locator("table").count()) !== 0) continue;
    const rows = table.locator("tr");
    const rowCount = await rows.count();
    let headerFound = false;
    const dataRows: string[][] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex);
      const values = await readCellTexts(row, "th, td");
      if (
        !headerFound &&
        values.length === HNCB_CURRENT_DEPOSIT_HEADERS.length &&
        values.every(
          (value, index) =>
            normalizedHeader(value) ===
            normalizedHeader(HNCB_CURRENT_DEPOSIT_HEADERS[index] ?? ""),
        )
      ) {
        headerFound = true;
        continue;
      }
      if (!headerFound) continue;
      const dataCells = row.locator("td");
      const headerCells = row.locator("th");
      const dataCount = await dataCells.count();
      const headerCount = await headerCells.count();
      // The observed footer is a single total cell and is not a financial row.
      if (dataCount === 0 && headerCount > 0) continue;
      if (dataCount === 1 && headerCount === 0) {
        const footerCell = dataCells.nth(0);
        const colspan = await footerCell.getAttribute("colspan");
        if (
          colspan === String(HNCB_CURRENT_DEPOSIT_HEADERS.length) ||
          /(?:總計|合計|筆數)/u.test(collapseSourceWhitespace(values[0]))
        )
          continue;
      }
      if (headerCount !== 0 || dataCount !== HNCB_CURRENT_DEPOSIT_HEADERS.length) {
        throw new Error(`HNCB current deposit data row ${rowIndex} must have 12 TD cells.`);
      }
      dataRows.push(values);
    }
    if (headerFound) return dataRows;
  }
  throw new Error("HNCB current deposit result table headers are not recognized.");
}

function overviewHeader(values: readonly string[]): boolean {
  if (values.length !== HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length) return false;
  const normalized = values.map(normalizedHeader);
  const expected = HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.map(normalizedHeader);
  return normalized.every((value, index) => value === expected[index]);
}

function overviewHeaderWithSpans(values: readonly string[]): boolean {
  if (values.length !== HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length) return false;
  const normalized = values.map(normalizedHeader);
  return (
    normalized[0] === "帳號" &&
    normalized[1] === "類別" &&
    normalized[2] === "幣別" &&
    normalized[3] === "帳上餘額" &&
    normalized[4] === "原幣" &&
    normalized[5] === "折合新台幣" &&
    normalized[6] === "薪轉利率" &&
    normalized[7] === "餘額查詢" &&
    normalized[8] === "明細查詢" &&
    normalized[9] === "轉帳" &&
    normalized[10] === "其他查詢"
  );
}

function overviewParentHeader(values: readonly string[]): boolean {
  const normalized = values.map(normalizedHeader);
  return (
    normalized.length === HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length &&
    normalized[0] === "帳號" &&
    normalized[1] === "類別" &&
    normalized[2] === "幣別" &&
    normalized[3] === "帳上餘額" &&
    normalized[4] === "可用餘額" &&
    normalized[5] === "可用餘額" &&
    normalized[6] === "薪轉利率" &&
    normalized[7] === "餘額查詢" &&
    normalized[8] === "明細查詢" &&
    normalized[9] === "轉帳" &&
    normalized[10] === "其他查詢"
  );
}

type SpannedTableRow = Readonly<{
  values: string[];
  tags: string[];
  sourceCellCount: number;
  sourceDataCount: number;
  sourceHeaderCount: number;
  sourceCells: readonly Readonly<{
    text: string;
    tag: "th" | "td";
    rowSpan: number;
    colSpan: number;
  }>[];
}>;

/** Expand HTML row/column spans so the overview header has stable columns. */
async function readSpannedTableRows(table: Locator): Promise<SpannedTableRow[]> {
  const rows = table.locator(directTableRowsSelector);
  const rowCount = await rows.count();
  const grid: Array<Array<{ text: string; tag: "th" | "td" } | undefined>> = [];
  const result: SpannedTableRow[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    const cells = row.locator(directRowCellsSelector);
    const cellCount = await cells.count();
    const sourceCells: Array<{
      text: string;
      tag: "th" | "td";
      rowSpan: number;
      colSpan: number;
    }> = [];
    let column = 0;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const cell = cells.nth(cellIndex);
      while (grid[rowIndex]?.[column] !== undefined) column += 1;
      const tagName = await cell.evaluate((element) => element.tagName.toLowerCase());
      if (tagName !== "th" && tagName !== "td")
        throw new Error(`HNCB current deposit overview row ${rowIndex} has an invalid cell tag.`);
      const resolvedTag = tagName as "th" | "td";
      const rowSpan = Number((await cell.getAttribute("rowspan")) ?? "1");
      const colSpan = Number((await cell.getAttribute("colspan")) ?? "1");
      if (!Number.isSafeInteger(rowSpan) || rowSpan < 1 || !Number.isSafeInteger(colSpan) || colSpan < 1)
        throw new Error(`HNCB current deposit overview row ${rowIndex} has invalid cell spans.`);
      const entry = { text: collapseSourceWhitespace(await cell.innerText()), tag: resolvedTag };
      sourceCells.push({ ...entry, rowSpan, colSpan });
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        const target = grid[rowIndex + rowOffset] ?? (grid[rowIndex + rowOffset] = []);
        for (let columnOffset = 0; columnOffset < colSpan; columnOffset += 1) {
          const targetColumn = column + columnOffset;
          if (target[targetColumn] !== undefined)
            throw new Error(`HNCB current deposit overview row ${rowIndex} has overlapping spans.`);
          target[targetColumn] = entry;
        }
      }
      column += colSpan;
    }
    const expanded = grid[rowIndex] ?? [];
    if (expanded.some((cell) => cell === undefined))
      throw new Error(`HNCB current deposit overview row ${rowIndex} has a span gap.`);
    result.push({
      values: expanded.map((cell) => cell!.text),
      tags: expanded.map((cell) => cell!.tag),
      sourceCellCount: cellCount,
      sourceDataCount: await row.locator(":scope > td").count(),
      sourceHeaderCount: await row.locator(":scope > th").count(),
      sourceCells,
    });
  }
  return result;
}

/** Parse the authenticated 帳務查詢 → 帳戶總覽 table. */
export function parseHncbCurrentDepositOverviewSnapshot(
  input: HncbCurrentDepositSnapshotInput,
): readonly HncbCurrentDepositOverviewBalanceRow[] {
  requireEndpoint(input.response, HNCB_CURRENT_DEPOSIT_OVERVIEW_ENDPOINT);
  if (input.rows.length === 0)
    throw new Error("HNCB current deposit overview table has no account rows.");
  const seen = new Set<string>();
  const rows: HncbCurrentDepositOverviewBalanceRow[] = [];
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length)
      throw new Error(`HNCB current deposit overview row ${rowIndex} must have 11 cells.`);
    const accountNumber = parseAccount(values[0] ?? "", rowIndex);
    const sourceCurrencyLexeme = collapseSourceWhitespace(values[2] ?? "");
    const parsedCurrency = sourceCurrencyLexeme
      ? parseCurrency(sourceCurrencyLexeme, rowIndex)
      : { value: "", sourceLexeme: "" };
    const duplicateKey = `${accountNumber}\u0000${parsedCurrency.value}`;
    if (seen.has(duplicateKey))
      throw new Error(`HNCB current deposit overview has duplicate account/currency row ${rowIndex}.`);
    seen.add(duplicateKey);
    rows.push({
      source: "hncb",
      accountNumber,
      currency: parsedCurrency.value,
      currencySourceLexeme: parsedCurrency.sourceLexeme,
      currencyResolution: parsedCurrency.value ? "provider" : "missing",
      ledger: parseExactDecimal(values[3] ?? "", `overview row ${rowIndex} ledger balance`),
      available: parseExactDecimal(values[4] ?? "", `overview row ${rowIndex} available balance`),
      effectiveAt: input.response.providerDate.effectiveAt,
      providerHttpDate: input.response.providerDate.raw,
      observedAt: input.response.observedAt,
      sourceEvidence: {
        endpoint: OVERVIEW_CONTRACT.endpointPath,
        transaction: HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
        status: 200,
        cacheControl: input.response.cacheControl,
        contractVersion: OVERVIEW_CONTRACT.contractVersion,
        url: input.response.url.href,
      },
    });
  }
  return rows;
}

/**
 * Locate the un-nested account-overview table and read its account rows' cell
 * texts in logical columns, after expanding header spans.
 */
export async function readHncbCurrentDepositOverviewCells(
  scope: Page | Frame | Locator,
): Promise<readonly (readonly string[])[]> {
  const scopedTables = scope.locator("table");
  const scopedTableCount = await scopedTables.count();
  const tables = scopedTableCount === 0
    ? [scope as Locator]
    : Array.from({ length: scopedTableCount }, (_, index) => scopedTables.nth(index));
  for (const table of tables) {
    const tableRows = await readSpannedTableRows(table);
    let headerFound = false;
    let parentHeaderFound = false;
    const dataRows: string[][] = [];
    for (const [rowIndex, row] of tableRows.entries()) {
      if (!headerFound && overviewParentHeader(row.values)) {
        if (
          row.sourceCells.filter(
            (cell) => normalizedHeader(cell.text) === "可用餘額",
          ).length !== 1 ||
          row.sourceCells.find(
            (cell) => normalizedHeader(cell.text) === "可用餘額",
          )?.colSpan !== 2
        )
          throw new Error(
            "HNCB current deposit overview parent header must span 可用餘額 across two columns.",
          );
        parentHeaderFound = true;
        continue;
      }
      if (
        !headerFound &&
        overviewHeaderWithSpans(row.values) &&
        (parentHeaderFound ||
          (row.sourceCellCount === HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length &&
            row.sourceCells.every((cell) => cell.rowSpan === 1 && cell.colSpan === 1)))
      ) {
        headerFound = true;
        continue;
      }
      if (!headerFound) continue;
      if (row.sourceHeaderCount > 0 || row.tags.some((tag) => tag === "th")) continue;
      // HNCB appends an empty separator row before its footer on some
      // account-overview responses. It has no financial cells or text and is
      // safe to discard without weakening malformed data-row rejection.
      if (
        row.sourceDataCount === 0 ||
        (row.sourceDataCount === 1 && row.values.every((value) => collapseSourceWhitespace(value) === ""))
      )
        continue;
      if (row.sourceDataCount === 1) {
        const footer = row.sourceCells[0];
        if (
          footer?.colSpan === 9 &&
          collapseSourceWhitespace(footer.text) === "列印"
        )
          continue;
        if (
          footer?.colSpan === HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length ||
          /(?:總計|合計|筆數|查詢結果)/u.test(row.values.join(" "))
        ) continue;
      }
      if (row.sourceDataCount !== HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length)
        throw new Error(`HNCB current deposit overview data row ${rowIndex} must have 11 TD cells.`);
      dataRows.push(row.values);
    }
    if (headerFound && (parentHeaderFound || tableRows.some((row) => overviewHeader(row.values))))
      return dataRows;
  }
  throw new Error("HNCB current deposit overview table headers are not recognized.");
}

async function hasResultTable(scope: BrowserScope): Promise<boolean> {
  const tables = scope.locator("table");
  const count = await tables.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const table = tables.nth(index);
    if ((await table.locator("table").count().catch(() => 1)) !== 0) continue;
    const text = await table.innerText().catch(() => "");
    if (text.includes("帳號(由小到大排序)") && text.includes("帳上餘額")) return true;
  }
  return false;
}

async function hasOverviewResultTable(scope: BrowserScope): Promise<boolean> {
  const tables = scope.locator("table");
  const count = await tables.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const rows = tables.nth(index).locator(directTableRowsSelector);
    const rowCount = await rows.count().catch(() => 0);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex);
      if ((await row.locator(directRowCellsSelector).count().catch(() => 0)) < 10) continue;
      const text = await row.innerText().catch(() => "");
      if (text.includes("帳號") && text.includes("帳上餘額") && text.includes("可用餘額")) return true;
    }
  }
  return false;
}

/** 帳務查詢 → 餘額查詢 → 活期存款, rendered by the balance-page GET. */
export const HNCB_CURRENT_DEPOSIT_DETAIL_ROUTE: HncbMenuRoute = {
  description: "HNCB current deposit result table",
  menu: [{ label: "帳務查詢" }, { label: "餘額查詢" }, { label: "活期存款" }],
  reply: endpointResponse(HNCB_CURRENT_DEPOSIT_DETAIL_ENDPOINT),
  ready: hasResultTable,
};

/** 帳務查詢 → 帳戶總覽 in the menu frame, rendered by the overview GET. */
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_MENU: HncbMenuRoute = {
  description: "HNCB current deposit overview result table",
  menu: [{ label: "帳務查詢", dispatches: true }, { label: "帳戶總覽", frame: "menu" }],
  reply: endpointResponse(HNCB_CURRENT_DEPOSIT_OVERVIEW_ENDPOINT),
  ready: hasOverviewResultTable,
};

/**
 * One current-state table before decoding: the account overview or the
 * 活期存款 balance page, which carry different columns and transactions.
 */
export type HncbCurrentDepositTable = Readonly<{
  view: "overview" | "detail";
  evidence: Extract<ProviderEvidence, { kind: "cells" }>;
  response: ProviderResponse;
}>;

/** Open the 活期存款 balance page, then read the source table. */
export async function readHncbCurrentDepositDetailTable(
  site: HncbNetbankSite,
  reader: ProviderResponseReader,
): Promise<HncbCurrentDepositTable> {
  const { scope, response } = await site.read(HNCB_CURRENT_DEPOSIT_DETAIL_ROUTE, reader);
  return {
    view: "detail",
    evidence: { kind: "cells", rows: await site.frames.race(readHncbCurrentDepositDetailCells(scope)) },
    response,
  };
}

/** Open the account overview, then read the authenticated overview table. */
export async function readHncbCurrentDepositOverviewTable(
  site: HncbNetbankSite,
  reader: ProviderResponseReader,
): Promise<HncbCurrentDepositTable> {
  const { scope, response } = await site.read(HNCB_CURRENT_DEPOSIT_OVERVIEW_MENU, reader);
  return {
    view: "overview",
    evidence: { kind: "cells", rows: await site.frames.race(readHncbCurrentDepositOverviewCells(scope)) },
    response,
  };
}

/** The admitted HNCB statement identity a current balance joins. */
export type ExistingHncbFinancialCapture = Readonly<{
  identity: Readonly<{
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
    currency?: string | null;
  }>;
}>;

type HncbCurrentDepositRow =
  | HncbCurrentDepositBalanceRow
  | HncbCurrentDepositOverviewBalanceRow;

/** Join HNCB's full numeric account evidence to the existing financial
 * identity and retain both provider balance fields independently. */
function buildHncbCurrentDepositBalanceCapture(
  row: HncbCurrentDepositRow,
  financialCapture: ExistingHncbFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const isOverview =
    String(row.sourceEvidence.transaction) === HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION ||
    String(row.sourceEvidence.contractVersion) ===
      CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["hncb/domestic-deposit/current-balance-overview-v1"].contractVersion;
  const route = isOverview
    ? "hncb/domestic-deposit/current-balance-overview-v1"
    : "hncb/domestic-deposit/current-balance-v1";
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
  const providerCurrency = row.currency.trim().toUpperCase();
  const canonicalCurrency = identity.currency?.trim().toUpperCase() ?? "";
  if (!isOverview && !providerCurrency)
    throw new Error("HNCB current deposit detail row is missing provider currency.");
  if (isOverview && !providerCurrency && !/^[A-Z]{3}$/u.test(canonicalCurrency))
    throw new Error(
      "HNCB current deposit overview cannot resolve blank currency without an admitted canonical account currency.",
    );
  if (providerCurrency && !/^[A-Z]{3}$/u.test(providerCurrency))
    throw new Error("HNCB current deposit currency is invalid.");
  if (providerCurrency && canonicalCurrency && providerCurrency !== canonicalCurrency)
    throw new Error("HNCB current deposit currency contradicts the existing canonical account.");
  const currency = providerCurrency || canonicalCurrency;
  const currencyResolution = providerCurrency ? "provider" : "canonical-account";
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  const availableSourceField = isOverview ? "原幣" : "可用餘額";
  const amountPairs: readonly [
    "ledger" | "available",
    string,
    CurrentDepositExactAmount,
  ][] = [
    ["ledger", "帳上餘額", row.ledger],
    ["available", availableSourceField, row.available],
  ];
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeRuleVersion: contract.contractVersion,
    sourceField: "HTTP Date",
    sourceValue: row.providerHttpDate,
    contractVersion: contract.contractVersion,
  } as const;
  const entries = amountPairs.map(([balanceKind, sourceField, balance]) => ({
    sourceRecordKey: canonicalDigest(
      "hncb-current-deposit-source-record-v1",
      sourceAccountKey,
      contract.contractVersion,
      currency,
      balanceKind,
      row.effectiveAt,
      balance.coefficient,
      String(balance.scale),
    ),
    providerKey: canonicalDigest(
      "hncb-current-deposit-provider-record-v1",
      row.accountNumber,
      contract.contractVersion,
      currency,
      balanceKind,
      row.effectiveAt,
    ),
    observationKey: canonicalDigest(
      "hncb-current-deposit-observation-v1",
      sourceAccountKey,
    ),
    balanceKind,
    sourceField,
    currency,
    value: balance,
    time,
    timeInRecord: false,
    compact: {
      accountNumber: row.accountNumber,
      currencySourceLexeme: row.currencySourceLexeme,
      currencyResolution,
      ...(canonicalCurrency ? { canonicalCurrency } : {}),
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
    },
  }));
  const endpoint =
    row.sourceEvidence.url ??
    `https://${contract.endpointHost}${row.sourceEvidence.endpoint}?trx=${encodeURIComponent(row.sourceEvidence.transaction)}`;
  return assembleCurrentDepositCapture({
    captureId: randomUUID(),
    authorityRoute: route,
    contractVersion: contract.contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "hncb",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: row.effectiveAt.slice(0, 10),
      endDate: row.effectiveAt.slice(0, 10),
    },
    providerResponse: {
      endpoint,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    page: {
      metadata: {
        source: isOverview
          ? "hncb-current-deposit-account-overview"
          : "hncb-current-deposit-summary",
        sourceRowCount: 1,
        balanceFieldCount: entries.length,
        currencyResolution,
      },
    },
  }, entries);
}

/**
 * HNCB keys a balance by the full account number. A capture without account
 * number evidence is left out of the index, and a row with no admitted capture
 * fails the run. The first capture under a number wins.
 */
const hncbCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ accountNumber: string }>,
  ExistingHncbFinancialCapture
> = {
  captureKey: (capture) => capture.identity.accountNumber?.value || undefined,
  rowKey: (row) => row.accountNumber,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    (kept.identity.sourceAccountKey ?? kept.identity.accountNo) ===
      (candidate.identity.sourceAccountKey ?? candidate.identity.accountNo) &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest &&
    (kept.identity.currency ?? null) === (candidate.identity.currency ?? null),
  ambiguousMessage: "HNCB current deposit identities are ambiguous across financial captures.",
  unmatched: {
    kind: "throw",
    message:
      "HNCB current deposit snapshot contains an account without existing full account-number evidence.",
  },
};

export const hncbCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  HncbCurrentDepositTable,
  HncbCurrentDepositRow,
  ExistingHncbFinancialCapture
> = {
  product: "current-balance",
  response: HNCB_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response, acquired) => {
    const snapshot = { rows: decoded.rows, response };
    return acquired.view === "overview"
      ? parseHncbCurrentDepositOverviewSnapshot(snapshot)
      : parseHncbCurrentDepositBalanceSnapshot(snapshot);
  },
  kind: CURRENT_DEPOSIT_BALANCE_STAGING,
  matching: hncbCurrentBalanceCaptureMatching,
  build: buildHncbCurrentDepositBalanceCapture,
};
