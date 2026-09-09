import type { Frame, Locator, Page, Response } from "playwright";

/** HNCB's current deposit balance query is a provider snapshot. */
export const HNCB_CURRENT_DEPOSIT_BALANCE_PATH =
  "/netbank/servlet/TrxDispatcher" as const;
export const HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION =
  "com.lb.wibc.trx.EAccDDSummary" as const;
export const HNCB_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "hncb/current-deposit-balance-v1" as const;
export const HNCB_CURRENT_DEPOSIT_BALANCE_HOST =
  "netbank.hncb.com.tw" as const;
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION =
  "com.lb.wibc.trx.AcctInfoInq" as const;
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_CONTRACT_VERSION =
  "hncb/current-deposit-balance-overview-v1" as const;
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH =
  HNCB_CURRENT_DEPOSIT_BALANCE_PATH;
export const HNCB_CURRENT_DEPOSIT_OVERVIEW_HOST =
  HNCB_CURRENT_DEPOSIT_BALANCE_HOST;

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

export type HncbCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  sourceLexeme: string;
}>;

export type HncbCurrentDepositFinancialAuthority = Readonly<{
  sourceConnectionKey?: string;
  identityEpochKey?: string;
  authorityClass?: string;
}>;

export type HncbCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  method?: string;
}>;

export type HncbCurrentDepositBalanceRow = Readonly<{
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
    endpoint: typeof HNCB_CURRENT_DEPOSIT_BALANCE_PATH;
    transaction: typeof HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION;
    status: 200;
    cacheControl: string;
    contractVersion: typeof HNCB_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
    /** The exact authenticated response URL, retained when available. */
    url?: string;
  }>;
  financialAuthority?: HncbCurrentDepositFinancialAuthority;
}>;

/**
 * Account-overview rows use the same balance shape as the detail snapshot,
 * but the provider may omit the currency cell for a zero-balance account.
 * Currency is resolved only after this row is joined to an admitted account.
 */
export type HncbCurrentDepositOverviewBalanceRow = Readonly<{
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
    endpoint: typeof HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH;
    transaction: typeof HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION;
    status: 200;
    cacheControl: string;
    contractVersion: typeof HNCB_CURRENT_DEPOSIT_OVERVIEW_CONTRACT_VERSION;
    url: string;
  }>;
  financialAuthority?: HncbCurrentDepositFinancialAuthority;
}>;

export type HncbCurrentDepositSnapshotInput = Readonly<{
  rows: readonly (readonly string[])[];
  response: HncbCurrentDepositResponseMetadata;
  observedAt: string;
  financialAuthority?: HncbCurrentDepositFinancialAuthority;
}>;

export type HncbCurrentDepositOverviewSnapshotInput = Readonly<{
  rows: readonly (readonly string[])[];
  response: HncbCurrentDepositResponseMetadata;
  observedAt: string;
  financialAuthority?: HncbCurrentDepositFinancialAuthority;
}>;

type BrowserScope = Page | Frame;

const directTableRowsSelector =
  ":scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr";
const directRowCellsSelector = ":scope > th, :scope > td";

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function responseHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value.trim();
  }
  return "";
}

function requireObservedAt(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.exec(
      value,
    );
  if (
    typeof value !== "string" ||
    !match ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("HNCB current deposit observedAt must be RFC3339.");
  }
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1]
  ) {
    throw new Error("HNCB current deposit observedAt has an invalid calendar date.");
  }
  return value;
}

function requireProviderDate(headers: Readonly<Record<string, string>>): {
  raw: string;
  effectiveAt: string;
} {
  const raw = responseHeader(headers, "date");
  if (!raw) throw new Error("HNCB current deposit response is missing HTTP Date.");
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      raw,
    )
  ) {
    throw new Error("HNCB current deposit HTTP Date is invalid.");
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== raw) {
    throw new Error("HNCB current deposit HTTP Date is invalid.");
  }
  return { raw, effectiveAt: new Date(timestamp).toISOString() };
}

function validateResponseForTransaction(
  response: HncbCurrentDepositResponseMetadata,
  transaction: string,
  options: Readonly<{ requireHtml?: boolean }> = {},
): {
  providerDate: { raw: string; effectiveAt: string };
  cacheControl: string;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(response.url);
  } catch {
    throw new Error("HNCB current deposit response URL is invalid.");
  }
  if (parsedUrl.hostname !== HNCB_CURRENT_DEPOSIT_BALANCE_HOST) {
    throw new Error("HNCB current deposit response host is unexpected.");
  }
  if (parsedUrl.pathname !== HNCB_CURRENT_DEPOSIT_BALANCE_PATH) {
    throw new Error(
      `HNCB current deposit response endpoint is unexpected: ${parsedUrl.pathname}`,
    );
  }
  if (parsedUrl.searchParams.get("trx") !== transaction) {
    throw new Error("HNCB current deposit response transaction is unexpected.");
  }
  if (response.status !== 200) {
    throw new Error(
      `HNCB current deposit response status is ${response.status}, expected 200.`,
    );
  }
  if (
    response.method !== undefined &&
    response.method.toUpperCase() !== "GET"
  ) {
    throw new Error("HNCB current deposit response method is not GET.");
  }
  const cacheControl = responseHeader(response.headers, "cache-control");
  if (!/\bno-store\b/iu.test(cacheControl)) {
    throw new Error(
      "HNCB current deposit response must carry Cache-Control: no-store.",
    );
  }
  if (options.requireHtml) {
    const contentType = responseHeader(response.headers, "content-type");
    if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) {
      throw new Error("HNCB current deposit overview response must be HTML.");
    }
  }
  return { providerDate: requireProviderDate(response.headers), cacheControl };
}

function validateResponse(
  response: HncbCurrentDepositResponseMetadata,
): {
  providerDate: { raw: string; effectiveAt: string };
  cacheControl: string;
} {
  return validateResponseForTransaction(
    response,
    HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION,
  );
}

function parseExactDecimal(
  value: string,
  label: string,
): HncbCurrentDepositExactDecimal {
  const sourceLexeme = cleanText(value);
  const normalized = sourceLexeme.replace(/\s/gu, "");
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})*)(?:\.(\d+))?$/u.exec(
    normalized,
  );
  if (!match) throw new Error(`HNCB current deposit ${label} is not an exact decimal.`);
  const sign = match[1] === "-" ? "-" : "";
  const whole = (match[2] ?? "").replace(/,/g, "");
  const fraction = match[3] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  return {
    coefficient: digits === "0" ? "0" : `${sign}${digits}`,
    scale: fraction.length,
    sourceLexeme,
  };
}

function parseAccount(value: string, rowIndex: number): string {
  const normalized = cleanText(value);
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
    cleanText(values[2] ?? "") === "" &&
    values.slice(3).every((value) => cleanText(value) === "-")
  );
}

function parseCurrency(value: string, rowIndex: number): {
  value: string;
  sourceLexeme: string;
} {
  const sourceLexeme = cleanText(value);
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
  return cleanText(value);
}

function validateFinancialAuthority(
  authority: HncbCurrentDepositFinancialAuthority | undefined,
): HncbCurrentDepositFinancialAuthority | undefined {
  if (authority === undefined) return undefined;
  for (const [key, value] of Object.entries(authority)) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`HNCB current deposit authority ${key} is invalid.`);
    }
  }
  return authority;
}

/** Parse only account, currency, available balance, and 帳上餘額. */
export function parseHncbCurrentDepositBalanceSnapshot(
  input: HncbCurrentDepositSnapshotInput,
): readonly HncbCurrentDepositBalanceRow[] {
  const { providerDate, cacheControl } = validateResponse(input.response);
  const observedAt = requireObservedAt(input.observedAt);
  const financialAuthority = validateFinancialAuthority(input.financialAuthority);
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
      effectiveAt: providerDate.effectiveAt,
      providerHttpDate: providerDate.raw,
      observedAt,
      sourceEvidence: {
        endpoint: HNCB_CURRENT_DEPOSIT_BALANCE_PATH,
        transaction: HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION,
        status: 200,
        cacheControl,
        contractVersion: HNCB_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
        url: input.response.url,
      },
      ...(financialAuthority ? { financialAuthority } : {}),
    });
  }
  return rows;
}

async function readCellTexts(row: Locator, selector: string): Promise<string[]> {
  const cells = row.locator(selector);
  const count = await cells.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(cleanText(await cells.nth(index).innerText()));
  }
  return values;
}

/** Locate the un-nested observed HNCB result table by its exact header row. */
export async function parseHncbCurrentDepositBalanceTable(
  scope: Page | Frame | Locator,
  input: Omit<HncbCurrentDepositSnapshotInput, "rows">,
): Promise<readonly HncbCurrentDepositBalanceRow[]> {
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
          /(?:總計|合計|筆數)/u.test(cleanText(values[0]))
        )
          continue;
      }
      if (headerCount !== 0 || dataCount !== HNCB_CURRENT_DEPOSIT_HEADERS.length) {
        throw new Error(`HNCB current deposit data row ${rowIndex} must have 12 TD cells.`);
      }
      dataRows.push(values);
    }
    if (headerFound) {
      return parseHncbCurrentDepositBalanceSnapshot({ ...input, rows: dataRows });
    }
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
      const entry = { text: cleanText(await cell.innerText()), tag: resolvedTag };
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
  input: HncbCurrentDepositOverviewSnapshotInput,
): readonly HncbCurrentDepositOverviewBalanceRow[] {
  const { providerDate, cacheControl } = validateResponseForTransaction(
    input.response,
    HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
    { requireHtml: true },
  );
  const observedAt = requireObservedAt(input.observedAt);
  const financialAuthority = validateFinancialAuthority(input.financialAuthority);
  if (input.rows.length === 0)
    throw new Error("HNCB current deposit overview table has no account rows.");
  const seen = new Set<string>();
  const rows: HncbCurrentDepositOverviewBalanceRow[] = [];
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length)
      throw new Error(`HNCB current deposit overview row ${rowIndex} must have 11 cells.`);
    const accountNumber = parseAccount(values[0] ?? "", rowIndex);
    const sourceCurrencyLexeme = cleanText(values[2] ?? "");
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
      effectiveAt: providerDate.effectiveAt,
      providerHttpDate: providerDate.raw,
      observedAt,
      sourceEvidence: {
        endpoint: HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH,
        transaction: HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
        status: 200,
        cacheControl,
        contractVersion: HNCB_CURRENT_DEPOSIT_OVERVIEW_CONTRACT_VERSION,
        url: input.response.url,
      },
      ...(financialAuthority ? { financialAuthority } : {}),
    });
  }
  return rows;
}

/** Locate the un-nested account-overview table and preserve its span layout. */
export async function parseHncbCurrentDepositOverviewTable(
  scope: Page | Frame | Locator,
  input: Omit<HncbCurrentDepositOverviewSnapshotInput, "rows">,
): Promise<readonly HncbCurrentDepositOverviewBalanceRow[]> {
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
        (row.sourceDataCount === 1 && row.values.every((value) => cleanText(value) === ""))
      )
        continue;
      if (row.sourceDataCount === 1) {
        const footer = row.sourceCells[0];
        if (
          footer?.colSpan === 9 &&
          cleanText(footer.text) === "列印"
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
      return parseHncbCurrentDepositOverviewSnapshot({ ...input, rows: dataRows });
  }
  throw new Error("HNCB current deposit overview table headers are not recognized.");
}

async function findExactControl(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<Locator> {
  const matcher = new RegExp(`^\\s*${text}\\s*$`, "u");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const controls = scope.locator("a, button").filter({ hasText: matcher });
      const count = await controls.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Could not find HNCB control "${text}".`);
}

async function findResultTable(page: Page, timeoutMs: number): Promise<{ scope: BrowserScope; table: Locator }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const tables = scope.locator("table");
      const count = await tables.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const table = tables.nth(index);
        if ((await table.locator("table").count().catch(() => 1)) !== 0) continue;
        const text = await table.innerText().catch(() => "");
        if (text.includes("帳號(由小到大排序)") && text.includes("帳上餘額")) {
          return { scope, table };
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Could not find HNCB current deposit result table.");
}

async function findOverviewResultTable(
  page: Page,
  timeoutMs: number,
): Promise<{ scope: BrowserScope; table: Locator }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const tables = scope.locator("table");
      const count = await tables.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const table = tables.nth(index);
        const rows = table.locator(directTableRowsSelector);
        const rowCount = await rows.count().catch(() => 0);
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const row = rows.nth(rowIndex);
          const directCells = row.locator(directRowCellsSelector);
          if ((await directCells.count().catch(() => 0)) < 10) continue;
          const text = await row.innerText().catch(() => "");
          if (
            text.includes("帳號") &&
            text.includes("帳上餘額") &&
            text.includes("可用餘額")
          )
            return { scope, table };
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Could not find HNCB current deposit overview result table.");
}

async function findMenuFrameControl(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<Locator> {
  const matcher = new RegExp(`^\\s*${text}\\s*$`, "u");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const menuFrame = page.frame({ name: "menu" });
    if (menuFrame) {
      const controls = menuFrame.locator("a").filter({ hasText: matcher });
      const count = await controls.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Could not find HNCB menu-frame control "${text}".`);
}

function accountingNavigationResponseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.hostname === HNCB_CURRENT_DEPOSIT_OVERVIEW_HOST &&
      url.pathname === HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH &&
      response.request().method().toUpperCase() === "POST"
    );
  } catch {
    return false;
  }
}

function responseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.hostname === HNCB_CURRENT_DEPOSIT_BALANCE_HOST &&
      url.pathname === HNCB_CURRENT_DEPOSIT_BALANCE_PATH &&
      url.searchParams.get("trx") === HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION
    );
  } catch {
    return false;
  }
}

function overviewResponseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.hostname === HNCB_CURRENT_DEPOSIT_OVERVIEW_HOST &&
      url.pathname === HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH &&
      url.searchParams.get("trx") === HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION &&
      response.request().method().toUpperCase() === "GET"
    );
  } catch {
    return false;
  }
}

/** Navigate 帳務查詢 → 餘額查詢 → 活期存款, then parse the source table. */
export async function readHncbCurrentDepositBalances(
  page: Page,
  input: Readonly<{
    observedAt: string;
    financialAuthority?: HncbCurrentDepositFinancialAuthority;
    timeoutMs?: number;
  }>,
): Promise<readonly HncbCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const accountingMenu = await findExactControl(page, "帳務查詢", timeoutMs);
  await accountingMenu.click();
  const balanceMenu = await findExactControl(page, "餘額查詢", timeoutMs);
  await balanceMenu.click();
  const demandDeposit = await findExactControl(page, "活期存款", timeoutMs);
  const responsePromise = page.waitForResponse(responseMatches, { timeout: timeoutMs });
  await demandDeposit.click();
  const response = await responsePromise;
  const headers = await response.allHeaders();
  const result = await findResultTable(page, timeoutMs);
  return parseHncbCurrentDepositBalanceTable(result.scope, {
    observedAt: input.observedAt,
    financialAuthority: input.financialAuthority,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      headers,
    },
  });
}

/** Navigate 帳務查詢 → 帳戶總覽, then parse the authenticated overview page. */
export async function readHncbCurrentDepositOverviewBalances(
  page: Page,
  input: Readonly<{
    observedAt: string;
    financialAuthority?: HncbCurrentDepositFinancialAuthority;
    timeoutMs?: number;
  }>,
): Promise<readonly HncbCurrentDepositOverviewBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const accountingMenu = await findExactControl(page, "帳務查詢", timeoutMs);
  const accountingResponse = page
    .waitForResponse(accountingNavigationResponseMatches, {
      timeout: Math.min(timeoutMs, 10_000),
    })
    .catch(() => null);
  await accountingMenu.click();
  // Wait for the bank's accounting POST when it emits one. The menu-frame
  // locator below supplies the readiness barrier for shells that do not emit
  // that response or finish rendering it before the response event.
  await accountingResponse;
  const overviewMenu = await findMenuFrameControl(page, "帳戶總覽", timeoutMs);
  const responsePromise = page.waitForResponse(overviewResponseMatches, { timeout: timeoutMs });
  await overviewMenu.click();
  const response = await responsePromise;
  const headers = await response.allHeaders();
  const result = await findOverviewResultTable(page, timeoutMs);
  return parseHncbCurrentDepositOverviewTable(result.scope, {
    observedAt: input.observedAt,
    financialAuthority: input.financialAuthority,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      headers,
    },
  });
}
