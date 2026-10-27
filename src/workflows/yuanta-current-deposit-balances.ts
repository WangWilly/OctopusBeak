import type { Locator, Response } from "playwright";

import { deriveYuantaDomesticDepositAccountKey } from "../ledger/canonical/yuanta-deposit-account-key.ts";
import { ifFound, type BrowserScope, type FrameScope } from "./frame-scope.ts";
import type { YuantaEbankSite, YuantaRoute } from "./yuanta-ebank-site.ts";

/**
 * Yuanta's current deposit summary is a source snapshot.  It is reached from
 * the authenticated summary page by clicking the matching `活期明細` link and
 * causes this POST to be rendered in the fmain frame.
 */
export const YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH =
  "/nib/tx/finance_overview_for_summary" as const;
export const YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD = "POST" as const;
export const YUANTA_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "yuanta/current-deposit-balance-v1" as const;
export const YUANTA_CURRENT_DEPOSIT_BALANCE_HOST =
  "ebank.yuantabank.com.tw" as const;

export const YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS = [
  "產品名稱",
  "分行名稱",
  "帳號",
  "利率",
  "可用餘額",
  "帳面餘額",
] as const;

export const YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS = [
  "分行名稱",
  "產品名稱",
  "幣別",
  "帳號",
  "可用餘額",
  "帳面餘額",
  "參考匯率",
  "臺幣市值",
] as const;

export type YuantaCurrentDepositKind = "domestic" | "foreign";
export type YuantaCurrentDepositStream =
  | "domestic-deposit"
  | "foreign-currency-deposit";

/** Exact source decimal plus the normalized storage representation. */
export type YuantaCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The source cell after surrounding whitespace/NBSP cleanup. */
  sourceLexeme: string;
}>;

/**
 * The workflow resolves these values from the existing authenticated run.
 * The parser carries them through unchanged and never invents an epoch or
 * account identity.
 */
export type YuantaCurrentDepositFinancialAuthority = Readonly<{
  sourceConnectionKey?: string;
  identityEpochKey?: string;
  authorityClass?: string;
}>;

export type YuantaCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  method?: string;
}>;

export type YuantaCurrentDepositBalanceRow = Readonly<{
  source: "yuanta";
  kind: YuantaCurrentDepositKind;
  stream: YuantaCurrentDepositStream;
  /** The complete provider account lexeme, including leading zeroes. */
  accountNumber: string;
  /** Domestic accounts retain the existing digest key; FX keeps its source key. */
  sourceAccountKey: string;
  currency: string;
  available: YuantaCurrentDepositExactDecimal;
  ledger: YuantaCurrentDepositExactDecimal;
  /** Provider HTTP Date, normalized to RFC3339 for typed time use. */
  effectiveAt: string;
  /** Raw provider HTTP Date retained for source-lineage evidence. */
  providerHttpDate: string;
  /** Local capture/knowledge time supplied by the caller. */
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH;
    method: typeof YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD;
    status: 200;
    cacheControl: string;
    contractVersion: typeof YUANTA_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
  }>;
  financialAuthority?: YuantaCurrentDepositFinancialAuthority;
}>;

export type YuantaCurrentDepositSnapshotInput = Readonly<{
  kind: YuantaCurrentDepositKind;
  rows: readonly (readonly string[])[];
  response: YuantaCurrentDepositResponseMetadata;
  observedAt: string;
  financialAuthority?: YuantaCurrentDepositFinancialAuthority;
}>;

const SUMMARY_HEADING: Record<YuantaCurrentDepositKind, string> = {
  domestic: "目前臺幣存款總額",
  foreign: "目前外幣存款總額",
};

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
    throw new Error("Yuanta current deposit observedAt must be RFC3339.");
  }
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1]
  ) {
    throw new Error("Yuanta current deposit observedAt has an invalid calendar date.");
  }
  return value;
}

function requireProviderDate(headers: Readonly<Record<string, string>>): {
  raw: string;
  effectiveAt: string;
} {
  const raw = responseHeader(headers, "date");
  if (!raw) {
    throw new Error("Yuanta current deposit response is missing HTTP Date.");
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      raw,
    )
  ) {
    throw new Error("Yuanta current deposit HTTP Date is invalid.");
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== raw) {
    throw new Error("Yuanta current deposit HTTP Date is invalid.");
  }
  return { raw, effectiveAt: new Date(timestamp).toISOString() };
}

function validateResponse(
  response: YuantaCurrentDepositResponseMetadata,
): {
  providerDate: { raw: string; effectiveAt: string };
  cacheControl: string;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(response.url);
  } catch {
    throw new Error("Yuanta current deposit response URL is invalid.");
  }
  if (parsedUrl.hostname !== YUANTA_CURRENT_DEPOSIT_BALANCE_HOST) {
    throw new Error("Yuanta current deposit response host is unexpected.");
  }
  if (parsedUrl.pathname !== YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH) {
    throw new Error(
      `Yuanta current deposit response endpoint is unexpected: ${parsedUrl.pathname}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `Yuanta current deposit response status is ${response.status}, expected 200.`,
    );
  }
  if (
    response.method !== undefined &&
    response.method.toUpperCase() !== YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD
  ) {
    throw new Error("Yuanta current deposit response method is not POST.");
  }
  const cacheControl = responseHeader(response.headers, "cache-control");
  if (!/\bno-store\b/iu.test(cacheControl)) {
    throw new Error(
      "Yuanta current deposit response must carry Cache-Control: no-store.",
    );
  }
  return { providerDate: requireProviderDate(response.headers), cacheControl };
}

function parseExactDecimal(
  value: string,
  label: string,
): YuantaCurrentDepositExactDecimal {
  const sourceLexeme = cleanText(value);
  const normalized = sourceLexeme.replace(/\s/gu, "");
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})*)(?:\.(\d+))?$/u.exec(
    normalized,
  );
  if (!match) {
    throw new Error(`Yuanta current deposit ${label} is not an exact decimal.`);
  }
  const sign = match[1] === "-" ? "-" : "";
  const whole = (match[2] ?? "").replace(/,/g, "");
  const fraction = match[3] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  const coefficient = digits === "0" ? "0" : `${sign}${digits}`;
  return { coefficient, scale: fraction.length, sourceLexeme };
}

function parseCurrency(value: string, label: string): string {
  const normalized = cleanText(value).toUpperCase();
  // Yuanta's live pages use Traditional Chinese currency labels while its
  // transaction sources expose the corresponding ISO codes. Keep this
  // source-specific alias set explicit and fail closed for other labels.
  const aliases: Readonly<Record<string, string>> = {
    日幣: "JPY",
    日圓: "JPY",
    美元: "USD",
    美金: "USD",
  };
  const canonical = aliases[normalized] ?? normalized;
  if (!/^[A-Z]{3}$/u.test(canonical)) {
    throw new Error(`Yuanta current deposit ${label} currency is invalid.`);
  }
  return canonical;
}

function parseAccount(value: string, label: string): string {
  const normalized = cleanText(value);
  if (!/^\d{6,24}$/u.test(normalized)) {
    throw new Error(`Yuanta current deposit ${label} account is invalid.`);
  }
  return normalized;
}

function validateFinancialAuthority(
  authority: YuantaCurrentDepositFinancialAuthority | undefined,
): YuantaCurrentDepositFinancialAuthority | undefined {
  if (authority === undefined) return undefined;
  for (const [key, value] of Object.entries(authority)) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`Yuanta current deposit authority ${key} is invalid.`);
    }
  }
  return authority;
}

function expectedHeaders(kind: YuantaCurrentDepositKind): readonly string[] {
  return kind === "domestic"
    ? YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS
    : YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS;
}

function expectedStream(
  kind: YuantaCurrentDepositKind,
): YuantaCurrentDepositStream {
  return kind === "domestic"
    ? "domestic-deposit"
    : "foreign-currency-deposit";
}

/**
 * Parse table data after the DOM reader has identified the exact provider
 * header. Footer totals are intentionally outside this input and therefore
 * cannot become balance facts.
 */
export function parseYuantaCurrentDepositBalanceSnapshot(
  input: YuantaCurrentDepositSnapshotInput,
): readonly YuantaCurrentDepositBalanceRow[] {
  const { providerDate, cacheControl } = validateResponse(input.response);
  const observedAt = requireObservedAt(input.observedAt);
  const financialAuthority = validateFinancialAuthority(input.financialAuthority);
  const headers = expectedHeaders(input.kind);
  const rows: YuantaCurrentDepositBalanceRow[] = [];
  const seen = new Set<string>();

  if (input.rows.length === 0) {
    throw new Error("Yuanta current deposit table has no account rows.");
  }

  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== headers.length) {
      throw new Error(
        `Yuanta current deposit row ${rowIndex} must have ${headers.length} cells.`,
      );
    }

    const accountNumber = parseAccount(
      values[input.kind === "domestic" ? 2 : 3] ?? "",
      `row ${rowIndex}`,
    );
    const currency =
      input.kind === "domestic"
        ? "TWD"
        : parseCurrency(values[2] ?? "", `row ${rowIndex}`);
    const available = parseExactDecimal(
      values[4] ?? "",
      `row ${rowIndex} available balance`,
    );
    const ledger = parseExactDecimal(
      values[5] ?? "",
      `row ${rowIndex} ledger balance`,
    );
    const sourceAccountKey =
      input.kind === "domestic"
        ? deriveYuantaDomesticDepositAccountKey(accountNumber)
        : accountNumber;
    const duplicateKey = `${sourceAccountKey}\u0000${currency}`;
    if (seen.has(duplicateKey)) {
      throw new Error(
        `Yuanta current deposit has duplicate account/currency row ${rowIndex}.`,
      );
    }
    seen.add(duplicateKey);

    rows.push({
      source: "yuanta",
      kind: input.kind,
      stream: expectedStream(input.kind),
      accountNumber,
      sourceAccountKey,
      currency,
      available,
      ledger,
      effectiveAt: providerDate.effectiveAt,
      providerHttpDate: providerDate.raw,
      observedAt,
      sourceEvidence: {
        endpoint: YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
        method: YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD,
        status: 200,
        cacheControl,
        contractVersion: YUANTA_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
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

async function tableClass(table: Locator): Promise<Set<string>> {
  return new Set(cleanText(await table.getAttribute("class")).split(/\s+/u).filter(Boolean));
}

/** Parse one live DOM table through Locator APIs, without replaying its POST. */
export async function parseYuantaCurrentDepositBalanceTable(
  table: Locator,
  input: Omit<YuantaCurrentDepositSnapshotInput, "rows">,
): Promise<readonly YuantaCurrentDepositBalanceRow[]> {
  const classes = await tableClass(table);
  if (!classes.has("normalTable")) {
    throw new Error("Yuanta current deposit table is missing normalTable.");
  }
  if (input.kind === "domestic" && !classes.has("botM2")) {
    throw new Error("Yuanta domestic current deposit table is missing botM2.");
  }

  const expected = expectedHeaders(input.kind);
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  let headerFound = false;
  const dataRows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    if ((await row.locator("table").count()) !== 0) {
      throw new Error(`Yuanta current deposit row ${rowIndex} contains a nested table.`);
    }
    const cells = await readCellTexts(row, "th, td");
    if (!headerFound && cells.length === expected.length && cells.every((value, index) => value === expected[index])) {
      headerFound = true;
      continue;
    }
    if (!headerFound) continue;

    const headerCells = row.locator("th");
    const dataCells = row.locator("td");
    const headerCount = await headerCells.count();
    const dataCount = await dataCells.count();

    // The observed footer is composed of TH cells and is deliberately not a
    // balance row. A missing footer is valid for this parser.
    if (dataCount === 0 && headerCount > 0) continue;
    if (dataCount !== expected.length || headerCount !== 0) {
      throw new Error(
        `Yuanta current deposit data row ${rowIndex} has an unexpected shape.`,
      );
    }
    dataRows.push(await readCellTexts(row, "td"));
  }

  if (!headerFound) {
    throw new Error("Yuanta current deposit table headers are not recognized.");
  }
  return parseYuantaCurrentDepositBalanceSnapshot({ ...input, rows: dataRows });
}

const FOREIGN_SUMMARY_TAB = "#submenuAreaFX";

async function firstVisibleIn(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/** The visible `活期明細` link on this kind's summary card, searched up from its heading. */
async function summaryDetailsLink(
  scope: BrowserScope,
  kind: YuantaCurrentDepositKind,
): Promise<Locator | null> {
  const headings = scope
    .locator("h1, h2, h3, h4, h5, h6, [role='heading']")
    .filter({ hasText: new RegExp(`^\\s*${SUMMARY_HEADING[kind]}\\s*$`, "u") });
  const headingCount = await headings.count().catch(() => 0);
  for (let index = 0; index < headingCount; index += 1) {
    let container = headings.nth(index);
    for (let depth = 0; depth < 6; depth += 1) {
      const link = await firstVisibleIn(
        container.locator("a").filter({ hasText: /^\s*活期明細\s*$/u }),
      );
      if (link) return link;
      container = container.locator("xpath=..");
    }
  }
  return null;
}

/**
 * The authenticated summary page, reached with or without a cid. The FX card
 * is behind the foreign-currency summary tab, so the foreign summary is ready
 * once its tab or its details link shows.
 */
function currentDepositSummaryRoute(kind: YuantaCurrentDepositKind): YuantaRoute {
  return {
    path: "summary",
    description: `the Yuanta ${kind} current deposit summary`,
    cid: "optional",
    ready: async (scope) =>
      (await summaryDetailsLink(scope, kind)) !== null ||
      (kind === "foreign" && (await firstVisibleIn(scope.locator(FOREIGN_SUMMARY_TAB))) !== null),
  };
}

function findCurrentDepositTable(
  frames: FrameScope,
  kind: YuantaCurrentDepositKind,
  timeoutMs: number,
): Promise<Locator> {
  const expected = expectedHeaders(kind);
  return frames.until(async () => {
    for (const scope of frames.scopes()) {
      const tables = scope.locator("table.normalTable");
      const count = await tables.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const table = tables.nth(index);
        const classes = await tableClass(table).catch(() => new Set<string>());
        if (kind === "domestic" && !classes.has("botM2")) continue;
        const rows = table.locator("tr");
        const rowCount = await rows.count().catch(() => 0);
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const values = await readCellTexts(rows.nth(rowIndex), "th, td").catch(
            () => [],
          );
          if (
            values.length === expected.length &&
            values.every((value, cellIndex) => value === expected[cellIndex])
          ) {
            return table;
          }
        }
      }
    }
    return null;
  }, `Could not find Yuanta ${kind} current deposit table.`, { timeoutMs });
}

function responseMatches(
  response: Response,
): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.hostname === YUANTA_CURRENT_DEPOSIT_BALANCE_HOST &&
      url.pathname === YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH &&
      response.request().method().toUpperCase() ===
        YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD
    );
  } catch {
    return false;
  }
}

/**
 * Open the authenticated summary page, follow the kind's summary card and
 * parse the resulting current-state table. The response is observed through
 * Playwright only; this function never fetches or replays the provider request.
 */
export async function readYuantaCurrentDepositBalances(
  site: YuantaEbankSite,
  kind: YuantaCurrentDepositKind,
  input: Readonly<{
    observedAt: string;
    financialAuthority?: YuantaCurrentDepositFinancialAuthority;
    timeoutMs?: number;
  }>,
): Promise<readonly YuantaCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const { frames } = site;
  // The run leaves fmain on the last product page; the summary route brings back the cards.
  await site.open(currentDepositSummaryRoute(kind));
  if (kind === "foreign") {
    const tab = await ifFound(frames.firstVisible(
      (scope) => scope.locator(FOREIGN_SUMMARY_TAB),
      "Yuanta foreign-currency summary tab",
      { timeoutMs: Math.min(timeoutMs, 5_000) },
    ));
    if (tab) await frames.race(tab.click());
  }
  const link = await frames.until(async () => {
    for (const scope of frames.scopes()) {
      const found = await summaryDetailsLink(scope, kind);
      if (found) return found;
    }
    return null;
  }, `Could not find Yuanta ${kind} current deposit details link.`, { timeoutMs });
  const [response] = await Promise.all([
    frames.race(frames.page.waitForResponse(responseMatches, { timeout: timeoutMs })),
    frames.race(link.click()),
  ]);
  const headers = await frames.race(response.allHeaders());
  const table = await findCurrentDepositTable(frames, kind, timeoutMs);
  return await frames.race(parseYuantaCurrentDepositBalanceTable(table, {
    kind,
    observedAt: input.observedAt,
    financialAuthority: input.financialAuthority,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      headers,
    },
  }));
}
