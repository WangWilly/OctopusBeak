import type { Frame, Locator, Page, Response } from "playwright";

/**
 * Fubon current deposits are rendered by the authenticated 我的存款 page.
 * The query is a provider snapshot and does not represent transaction rows.
 */
export const FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH =
  "/B2C/cboqu/cboqu003/CBOQU003_Home.faces" as const;
export const FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_ID =
  "form1:resultGrid_DataGridBody" as const;
export const FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_SELECTOR =
  'table[id="form1:resultGrid_DataGridBody"]' as const;
export const FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "fubon/current-deposit-balance-v1" as const;
export const FUBON_CURRENT_DEPOSIT_BALANCE_HOST =
  "ebank.taipeifubon.com.tw" as const;
const FUBON_CURRENT_DEPOSIT_HEADER_READY_TIMEOUT_MS = 5_000;

export const FUBON_CURRENT_DEPOSIT_HEADERS = [
  "帳號",
  "帳戶暱稱",
  "存款類別",
  "分行",
  "幣別",
  "即時餘額",
  "可用餘額",
  "存單號碼",
  "到期日",
  "功能",
] as const;

export type FubonCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The source cell after surrounding whitespace/NBSP cleanup. */
  sourceLexeme: string;
}>;

export type FubonCurrentDepositFinancialAuthority = Readonly<{
  sourceConnectionKey?: string;
  identityEpochKey?: string;
  authorityClass?: string;
}>;

export type FubonCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  method?: string;
}>;

export type FubonCurrentDepositBalanceRow = Readonly<{
  source: "fubon";
  /** Complete fourteen-digit provider account lexeme, including leading zeroes. */
  accountNumber: string;
  accountNickname: string;
  depositType: string;
  branchName: string;
  currency: string;
  currencySourceLexeme: string;
  /** 即時餘額 remains distinct from 可用餘額. */
  instantBalance: FubonCurrentDepositExactDecimal;
  availableBalance: FubonCurrentDepositExactDecimal;
  effectiveAt: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH;
    status: 200;
    cacheControl: string;
    contractVersion: typeof FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
  }>;
  financialAuthority?: FubonCurrentDepositFinancialAuthority;
}>;

export type FubonCurrentDepositSnapshotInput = Readonly<{
  rows: readonly (readonly string[])[];
  response: FubonCurrentDepositResponseMetadata;
  observedAt: string;
  financialAuthority?: FubonCurrentDepositFinancialAuthority;
}>;

type BrowserScope = Page | Frame;

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
    throw new Error("Fubon current deposit observedAt must be RFC3339.");
  }
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1]
  ) {
    throw new Error("Fubon current deposit observedAt has an invalid calendar date.");
  }
  return value;
}

function requireProviderDate(headers: Readonly<Record<string, string>>): {
  raw: string;
  effectiveAt: string;
} {
  const raw = responseHeader(headers, "date");
  if (!raw) throw new Error("Fubon current deposit response is missing HTTP Date.");
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      raw,
    )
  ) {
    throw new Error("Fubon current deposit HTTP Date is invalid.");
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== raw) {
    throw new Error("Fubon current deposit HTTP Date is invalid.");
  }
  return { raw, effectiveAt: new Date(timestamp).toISOString() };
}

function validateResponse(
  response: FubonCurrentDepositResponseMetadata,
): {
  providerDate: { raw: string; effectiveAt: string };
  cacheControl: string;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(response.url);
  } catch {
    throw new Error("Fubon current deposit response URL is invalid.");
  }
  if (parsedUrl.hostname !== FUBON_CURRENT_DEPOSIT_BALANCE_HOST) {
    throw new Error("Fubon current deposit response host is unexpected.");
  }
  if (parsedUrl.pathname !== FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH) {
    throw new Error(
      `Fubon current deposit response endpoint is unexpected: ${parsedUrl.pathname}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `Fubon current deposit response status is ${response.status}, expected 200.`,
    );
  }
  const cacheControl = responseHeader(response.headers, "cache-control");
  if (!/\bno-store\b/iu.test(cacheControl) || !/\bno-cache\b/iu.test(cacheControl)) {
    throw new Error(
      "Fubon current deposit response must carry Cache-Control: no-store, no-cache.",
    );
  }
  return { providerDate: requireProviderDate(response.headers), cacheControl };
}

function parseExactDecimal(
  value: string,
  label: string,
): FubonCurrentDepositExactDecimal {
  const sourceLexeme = cleanText(value);
  const normalized = sourceLexeme.replace(/\s/gu, "");
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})*)(?:\.(\d+))?$/u.exec(
    normalized,
  );
  if (!match) {
    throw new Error(`Fubon current deposit ${label} is not an exact decimal.`);
  }
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

function parseAccount(value: string): string {
  const normalized = cleanText(value);
  if (!/^\d{14}$/u.test(normalized)) {
    throw new Error("Fubon current deposit account must be a full fourteen-digit value.");
  }
  return normalized;
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
    throw new Error(`Fubon current deposit row ${rowIndex} currency is invalid.`);
  }
  return { value: currency, sourceLexeme };
}

function validateFinancialAuthority(
  authority: FubonCurrentDepositFinancialAuthority | undefined,
): FubonCurrentDepositFinancialAuthority | undefined {
  if (authority === undefined) return undefined;
  for (const [key, value] of Object.entries(authority)) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`Fubon current deposit authority ${key} is invalid.`);
    }
  }
  return authority;
}

/** Parse the ten visible contract columns. Hidden/internal cells are excluded by the DOM reader. */
export function parseFubonCurrentDepositBalanceSnapshot(
  input: FubonCurrentDepositSnapshotInput,
): readonly FubonCurrentDepositBalanceRow[] {
  const { providerDate, cacheControl } = validateResponse(input.response);
  const observedAt = requireObservedAt(input.observedAt);
  const financialAuthority = validateFinancialAuthority(input.financialAuthority);
  if (input.rows.length === 0) {
    throw new Error("Fubon current deposit table has no account rows.");
  }

  const seenAccounts = new Set<string>();
  const rows: FubonCurrentDepositBalanceRow[] = [];
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== FUBON_CURRENT_DEPOSIT_HEADERS.length) {
      throw new Error(
        `Fubon current deposit row ${rowIndex} must have exactly 10 visible cells.`,
      );
    }
    const accountNumber = parseAccount(values[0] ?? "");
    if (seenAccounts.has(accountNumber)) {
      throw new Error(`Fubon current deposit has duplicate account row ${rowIndex}.`);
    }
    seenAccounts.add(accountNumber);
    const parsedCurrency = parseCurrency(values[4] ?? "", rowIndex);
    rows.push({
      source: "fubon",
      accountNumber,
      accountNickname: cleanText(values[1]),
      depositType: cleanText(values[2]),
      branchName: cleanText(values[3]),
      currency: parsedCurrency.value,
      currencySourceLexeme: parsedCurrency.sourceLexeme,
      instantBalance: parseExactDecimal(values[5] ?? "", `row ${rowIndex} instant balance`),
      availableBalance: parseExactDecimal(values[6] ?? "", `row ${rowIndex} available balance`),
      effectiveAt: providerDate.effectiveAt,
      providerHttpDate: providerDate.raw,
      observedAt,
      sourceEvidence: {
        endpoint: FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
        status: 200,
        cacheControl,
        contractVersion: FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
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

async function readClass(locator: Locator): Promise<Set<string>> {
  return new Set(
    cleanText(await locator.getAttribute("class"))
      .split(/\s+/u)
      .filter(Boolean),
  );
}

function isCurrentDepositHeader(cells: readonly string[]): boolean {
  return (
    cells.length === FUBON_CURRENT_DEPOSIT_HEADERS.length &&
    cells.every((value, index) => value === FUBON_CURRENT_DEPOSIT_HEADERS[index])
  );
}

async function tableHasCurrentDepositHeader(table: Locator): Promise<boolean> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = await readCellTexts(
      rows.nth(rowIndex),
      "th:not(.hide), td:not(.hide)",
    );
    if (isCurrentDepositHeader(cells)) return true;
  }
  return false;
}

export async function waitForFubonCurrentDepositHeader(
  isReady: () => Promise<boolean>,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (await isReady()) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(250, remainingMs));
  }
}

/**
 * Parse the observed table through Locator APIs. The table must contain
 * exactly twelve TD cells per data row: ten visible contract cells followed
 * by two cells marked `.hide`. This explicit shape prevents hidden internals
 * and unrelated aggregate tables from entering the typed result.
 */
export async function parseFubonCurrentDepositBalanceTable(
  table: Locator,
  input: Omit<FubonCurrentDepositSnapshotInput, "rows">,
): Promise<readonly FubonCurrentDepositBalanceRow[]> {
  if ((await table.getAttribute("id")) !== FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_ID) {
    throw new Error("Fubon current deposit table id is unexpected.");
  }
  const classes = await readClass(table);
  if (!classes.has("tb_bkBody") || !classes.has("m10")) {
    throw new Error("Fubon current deposit table classes are unexpected.");
  }

  const rows = table.locator("tr");
  const rowCount = await rows.count();
  let headerFound = false;
  const dataRows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    if ((await row.locator("table").count()) !== 0) {
      throw new Error(`Fubon current deposit row ${rowIndex} contains a nested table.`);
    }
    const cells = await readCellTexts(row, "th:not(.hide), td:not(.hide)");
    if (
      !headerFound &&
      isCurrentDepositHeader(cells)
    ) {
      headerFound = true;
      continue;
    }
    if (!headerFound) continue;

    const headerCount = await row.locator("th").count();
    const allDataCount = await row.locator("td").count();
    if (allDataCount === 0 && headerCount > 0) continue;
    if (headerCount !== 0 || allDataCount !== 12) {
      throw new Error(
        `Fubon current deposit data row ${rowIndex} must contain 12 TD cells.`,
      );
    }
    const visibleCells = row.locator("td:not(.hide)");
    const hiddenCells = row.locator("td.hide");
    if ((await visibleCells.count()) !== 10 || (await hiddenCells.count()) !== 2) {
      throw new Error(
        `Fubon current deposit data row ${rowIndex} must contain 10 visible and 2 hidden TD cells.`,
      );
    }
    dataRows.push(await readCellTexts(row, "td:not(.hide)"));
  }

  if (!headerFound) {
    throw new Error("Fubon current deposit table headers are not recognized.");
  }
  return parseFubonCurrentDepositBalanceSnapshot({ ...input, rows: dataRows });
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
  throw new Error(`Could not find Fubon control "${text}".`);
}

async function findCurrentDepositTable(page: Page, timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  let candidate: Locator | undefined;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const table = scope.locator(FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_SELECTOR);
      if ((await table.count().catch(() => 0)) !== 1) continue;
      candidate = table;
      const remainingMs = Math.max(0, deadline - Date.now());
      const headerReady = await waitForFubonCurrentDepositHeader(
        () => tableHasCurrentDepositHeader(table),
        Math.min(remainingMs, FUBON_CURRENT_DEPOSIT_HEADER_READY_TIMEOUT_MS),
        (milliseconds) => page.waitForTimeout(milliseconds),
      );
      if (headerReady) return table;
      return table;
    }
    await page.waitForTimeout(250);
  }
  if (candidate) return candidate;
  throw new Error("Could not find Fubon current deposit table.");
}

function responseMatches(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.hostname === FUBON_CURRENT_DEPOSIT_BALANCE_HOST &&
      url.pathname === FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH
    );
  } catch {
    return false;
  }
}

/** Navigate through 存款交易查詢 → 我的存款 and parse the current table. */
export async function readFubonCurrentDepositBalances(
  page: Page,
  input: Readonly<{
    observedAt: string;
    financialAuthority?: FubonCurrentDepositFinancialAuthority;
    timeoutMs?: number;
  }>,
): Promise<readonly FubonCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const depositMenu = await findExactControl(page, "存款交易查詢", timeoutMs);
  await depositMenu.click();
  const myDeposit = await findExactControl(page, "我的存款", timeoutMs);
  const responsePromise = page.waitForResponse(responseMatches, { timeout: timeoutMs });
  await myDeposit.click();
  const response = await responsePromise;
  const headers = await response.allHeaders();
  const table = await findCurrentDepositTable(page, timeoutMs);
  return parseFubonCurrentDepositBalanceTable(table, {
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
