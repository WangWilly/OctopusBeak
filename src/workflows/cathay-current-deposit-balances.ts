import { createHash } from "node:crypto";
import type { Frame, Locator, Page, Response } from "playwright";

export const CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH =
  "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_DepositOverview" as const;
export const CATHAY_CURRENT_DOMESTIC_UI_PATH =
  "/OnlineBanking/AcctInq/B0101_DepInq" as const;
export const CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH =
  "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_OverView" as const;
export const CATHAY_CURRENT_FOREIGN_UI_PATH =
  "/OnlineBanking/FAcctInq/R0101_FDepInq" as const;
export const CATHAY_CURRENT_DEPOSIT_HOST = "www.cathaybk.com.tw" as const;
export const CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION =
  "cathay/current-deposit-balance-v1" as const;
export const CATHAY_CURRENT_DEPOSIT_TIME_BOUND_MS = 5 * 60 * 1000;

export type CathayCurrentDepositKind = "domestic" | "foreign";
export type CathayCurrentDepositStream =
  | "domestic-deposit"
  | "foreign-currency-deposit";
export type CathayCurrentDepositObservationKind = "ledger" | "available";

export type CathayCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  sourceLexeme: string;
}>;

export type CathayCurrentDepositFinancialAuthority = Readonly<{
  sourceConnectionKey?: string;
  identityEpochKey?: string;
  authorityClass?: string;
}>;

export type CathayCurrentDepositResponseMetadata = Readonly<{
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  method?: string;
}>;

export type CathayCurrentDepositObservation = Readonly<{
  kind: CathayCurrentDepositObservationKind;
  amount: CathayCurrentDepositExactDecimal;
  currency: string;
  effectiveAt: string;
  effectiveTimeBasis: "provider-system-time";
  effectiveTimeEvidence: Readonly<{
    sourceField: "systemTime";
    value: string;
    httpDate: string;
  }>;
}>;

export type CathayCurrentDomesticDepositBalanceRow = Readonly<{
  source: "cathay";
  kind: "domestic";
  stream: "domestic-deposit";
  /** Existing Cathay account identity from the UI selector. */
  sourceAccountKey: string;
  /** The UI account value used for the exact overview binding. */
  uiAccountNumber: string;
  /** Provider overview evidence; never used as the canonical account key. */
  providerAccountNumber: string;
  currency: "TWD";
  ledger: CathayCurrentDepositExactDecimal;
  available: CathayCurrentDepositExactDecimal;
  observations: readonly [CathayCurrentDepositObservation, CathayCurrentDepositObservation];
  providerSystemTime: string;
  effectiveAt: string;
  httpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH;
    uiPath: typeof CATHAY_CURRENT_DOMESTIC_UI_PATH;
    status: 200;
    responseDigest: string;
    contractVersion: typeof CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION;
  }>;
  financialAuthority?: CathayCurrentDepositFinancialAuthority;
}>;

export type CathayCurrentForeignDepositBalanceRow = Readonly<{
  source: "cathay";
  kind: "foreign";
  stream: "foreign-currency-deposit";
  /** Cathay's existing FX demand-account identity. */
  sourceAccountKey: string;
  accountNumber: string;
  currency: string;
  currencySourceCode: string;
  ledger: CathayCurrentDepositExactDecimal;
  /** FX current-state source does not provide an available balance. */
  observations: readonly [CathayCurrentDepositObservation];
  providerSystemTime: string;
  effectiveAt: string;
  httpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH;
    uiPath: typeof CATHAY_CURRENT_FOREIGN_UI_PATH;
    status: 200;
    responseDigest: string;
    contractVersion: typeof CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION;
  }>;
  financialAuthority?: CathayCurrentDepositFinancialAuthority;
}>;

export type CathayCurrentDepositBalanceRow =
  | CathayCurrentDomesticDepositBalanceRow
  | CathayCurrentForeignDepositBalanceRow;

export type CathayCurrentDepositSnapshotInput = Readonly<{
  kind: CathayCurrentDepositKind;
  response: CathayCurrentDepositResponseMetadata;
  rawBody: string;
  observedAt: string;
  /** Required for domestic rows to bind API accountNo to the UI account key. */
  uiAccountNumbers?: readonly string[];
  financialAuthority?: CathayCurrentDepositFinancialAuthority;
}>;

type BrowserScope = Page | Frame;

type CathayDomesticApiRow = {
  accountType?: unknown;
  accountNo?: unknown;
  accountName?: unknown;
  accountNickName?: unknown;
  accountBalance?: unknown;
  avaliableBalance?: unknown;
  datas?: unknown;
};

type CathayDomesticApiResponse = {
  success?: unknown;
  systemTime?: unknown;
  content?: {
    depositData?: {
      queryStatus?: unknown;
      totalAccountBalance?: unknown;
      totalAvaliableBalance?: unknown;
      datas?: unknown;
    };
    timeDepositData?: unknown;
  };
};

type CathayForeignApiDetail = {
  currencyId?: unknown;
  currencyCode?: unknown;
  currency?: unknown;
  balance?: unknown;
  equalTwdBalance?: unknown;
  dueDate?: unknown;
};

type CathayForeignApiAccount = {
  account?: unknown;
  nickName?: unknown;
  demandType?: unknown;
  status?: unknown;
  details?: unknown;
};

type CathayForeignApiResponse = {
  success?: unknown;
  systemTime?: unknown;
  content?: {
    isGetDemandAccountSuccess?: unknown;
    demandAccounts?: unknown;
    depositAccounts?: unknown;
  };
};

type CathayJsonParseContext = { source: string };

/** Preserve the provider's numeric token lexeme before decimal admission. */
function parseCathayCurrentApiJson<T>(source: string): T {
  const reviver = function (
    this: unknown,
    _key: string,
    value: unknown,
  ): unknown {
    const context = arguments[2] as CathayJsonParseContext | undefined;
    if (typeof value !== "number") return value;
    if (!context || typeof context.source !== "string") {
      throw new Error("Cathay current deposit numeric response lacks lexical evidence.");
    }
    return context.source;
  };
  return JSON.parse(source, reviver) as T;
}

function responseDigest(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("base64url")}`;
}

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

function validateCalendarDate(date: string, label: string): void {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${label} has an invalid calendar date.`);
  }
}

function validateObservedAt(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new Error("Cathay current deposit observedAt must be RFC3339.");
  }
  validateCalendarDate(match[1]!, "Cathay current deposit observedAt");
  return value;
}

function validateSystemTime(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Cathay current deposit response systemTime is required.");
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new Error("Cathay current deposit systemTime is invalid.");
  }
  validateCalendarDate(match[1]!, "Cathay current deposit systemTime");
  return value;
}

function validateHttpDate(headers: Readonly<Record<string, string>>): string {
  const value = responseHeader(headers, "date");
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      value,
    )
  ) {
    throw new Error("Cathay current deposit response HTTP Date is invalid.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) {
    throw new Error("Cathay current deposit response HTTP Date is invalid.");
  }
  return value;
}

function validateResponse(
  response: CathayCurrentDepositResponseMetadata,
  kind: CathayCurrentDepositKind,
): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(response.url);
  } catch {
    throw new Error("Cathay current deposit response URL is invalid.");
  }
  if (parsedUrl.hostname !== CATHAY_CURRENT_DEPOSIT_HOST) {
    throw new Error("Cathay current deposit response host is unexpected.");
  }
  const expectedPath =
    kind === "domestic"
      ? CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH
      : CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH;
  if (parsedUrl.pathname !== expectedPath) {
    throw new Error(`Cathay current deposit response endpoint is unexpected: ${parsedUrl.pathname}`);
  }
  if (response.status !== 200) {
    throw new Error(`Cathay current deposit response status is ${response.status}, expected 200.`);
  }
  if (response.method?.toUpperCase() !== "POST") {
    throw new Error("Cathay current deposit response method is not POST.");
  }
  return validateHttpDate(response.headers);
}

function compareProviderTimes(systemTime: string, httpDate: string): void {
  const delta = Math.abs(Date.parse(systemTime) - Date.parse(httpDate));
  if (!Number.isFinite(delta) || delta > CATHAY_CURRENT_DEPOSIT_TIME_BOUND_MS) {
    throw new Error("Cathay current deposit systemTime is inconsistent with HTTP Date.");
  }
}

function parseExactDecimal(value: unknown, label: string): CathayCurrentDepositExactDecimal {
  if (typeof value !== "string") {
    throw new Error(`Cathay current deposit ${label} lacks exact JSON lexical evidence.`);
  }
  const sourceLexeme = cleanText(value);
  const normalized = sourceLexeme.replace(/\s/gu, "");
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})*)(?:\.(\d+))?$/u.exec(normalized);
  if (!match) {
    throw new Error(`Cathay current deposit ${label} is not an exact decimal.`);
  }
  const integer = (match[2] ?? "").replace(/,/g, "");
  const fraction = match[3] ?? "";
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  return {
    coefficient: digits === "0" ? "0" : `${match[1] === "-" ? "-" : ""}${digits}`,
    scale: fraction.length,
    sourceLexeme,
  };
}

function parseAccount(value: unknown, label: string, digits: number): string {
  if (typeof value !== "string" || !new RegExp(`^\\d{${digits}}$`, "u").test(value)) {
    throw new Error(`Cathay current deposit ${label} account is invalid.`);
  }
  return value;
}

function validateAuthority(
  authority: CathayCurrentDepositFinancialAuthority | undefined,
): CathayCurrentDepositFinancialAuthority | undefined {
  if (authority === undefined) return undefined;
  for (const [key, value] of Object.entries(authority)) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`Cathay current deposit authority ${key} is invalid.`);
    }
  }
  return authority;
}

function requireSuccess(value: unknown): void {
  if (value !== true) throw new Error("Cathay current deposit API response was not successful.");
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Cathay current deposit ${label} is missing.`);
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cathay current deposit ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function observation(
  kind: CathayCurrentDepositObservationKind,
  amount: CathayCurrentDepositExactDecimal,
  currency: string,
  systemTime: string,
  httpDate: string,
): CathayCurrentDepositObservation {
  return {
    kind,
    amount,
    currency,
    effectiveAt: systemTime,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeEvidence: {
      sourceField: "systemTime",
      value: systemTime,
      httpDate,
    },
  };
}

function domesticRows(
  response: CathayCurrentDepositResponseMetadata,
  rawBody: string,
  observedAt: string,
  uiAccountNumbers: readonly string[] | undefined,
  financialAuthority: CathayCurrentDepositFinancialAuthority | undefined,
  httpDate: string,
): readonly CathayCurrentDomesticDepositBalanceRow[] {
  const parsed = parseCathayCurrentApiJson<CathayDomesticApiResponse>(rawBody);
  requireSuccess(parsed.success);
  const systemTime = validateSystemTime(parsed.systemTime);
  compareProviderTimes(systemTime, httpDate);
  const digest = responseDigest(rawBody);
  const content = requireObject(parsed.content, "domestic content");
  const depositData = requireObject(content.depositData, "domestic depositData");
  const queryStatus = depositData.queryStatus;
  if (typeof queryStatus !== "string" || !queryStatus.trim()) {
    throw new Error("Cathay current domestic response queryStatus is missing.");
  }
  const accounts = requireArray(depositData.datas, "domestic account data");
  if (!uiAccountNumbers || uiAccountNumbers.length === 0) {
    throw new Error("Cathay current domestic UI account binding is missing.");
  }
  const normalizedUi = uiAccountNumbers.map((value) => parseAccount(value, "UI", 12));
  const authority = validateAuthority(financialAuthority);
  const rows: CathayCurrentDomesticDepositBalanceRow[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < accounts.length; index += 1) {
    const account = requireObject(accounts[index], `domestic account ${index}`) as CathayDomesticApiRow;
    const providerAccountNumber = parseAccount(account.accountNo, `domestic row ${index}`, 16);
    const matchingUi = normalizedUi.filter((ui) => providerAccountNumber === `0000${ui}`);
    if (matchingUi.length !== 1) {
      throw new Error(`Cathay current domestic row ${index} does not bind exactly to a UI account.`);
    }
    const uiAccountNumber = matchingUi[0]!;
    if (seen.has(uiAccountNumber)) throw new Error("Cathay current domestic has duplicate UI account rows.");
    seen.add(uiAccountNumber);
    const ledger = parseExactDecimal(account.accountBalance, `domestic row ${index} ledger balance`);
    const available = parseExactDecimal(account.avaliableBalance, `domestic row ${index} available balance`);
    rows.push({
      source: "cathay",
      kind: "domestic",
      stream: "domestic-deposit",
      sourceAccountKey: uiAccountNumber,
      uiAccountNumber,
      providerAccountNumber,
      currency: "TWD",
      ledger,
      available,
      observations: [
        observation("ledger", ledger, "TWD", systemTime, httpDate),
        observation("available", available, "TWD", systemTime, httpDate),
      ],
      providerSystemTime: systemTime,
      effectiveAt: systemTime,
      httpDate,
      observedAt,
      sourceEvidence: {
        endpoint: CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
        uiPath: CATHAY_CURRENT_DOMESTIC_UI_PATH,
        status: 200,
        responseDigest: digest,
        contractVersion: CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION,
      },
      ...(authority ? { financialAuthority: authority } : {}),
    });
  }
  if (rows.length === 0) throw new Error("Cathay current domestic response has no accounts.");
  if (seen.size !== normalizedUi.length) {
    throw new Error("Cathay current domestic UI account binding is incomplete.");
  }
  return rows;
}

function foreignRows(
  rawBody: string,
  observedAt: string,
  financialAuthority: CathayCurrentDepositFinancialAuthority | undefined,
  httpDate: string,
): readonly CathayCurrentForeignDepositBalanceRow[] {
  const parsed = parseCathayCurrentApiJson<CathayForeignApiResponse>(rawBody);
  requireSuccess(parsed.success);
  const systemTime = validateSystemTime(parsed.systemTime);
  compareProviderTimes(systemTime, httpDate);
  const digest = responseDigest(rawBody);
  const content = requireObject(parsed.content, "foreign content");
  if (content.isGetDemandAccountSuccess !== true) {
    throw new Error("Cathay current foreign demand-account response was not successful.");
  }
  const accounts = requireArray(content.demandAccounts, "foreign demand accounts");
  const authority = validateAuthority(financialAuthority);
  const rows: CathayCurrentForeignDepositBalanceRow[] = [];
  const seen = new Set<string>();
  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
    const account = requireObject(accounts[accountIndex], `foreign account ${accountIndex}`) as CathayForeignApiAccount;
    if (account.demandType !== "DemandDeposit" || account.status !== "Normal") {
      throw new Error(`Cathay current foreign account ${accountIndex} is not a normal demand account.`);
    }
    const accountNumber = parseAccount(account.account, `foreign row ${accountIndex}`, 12);
    const details = requireArray(account.details, `foreign account ${accountIndex} details`);
    if (details.length === 0) throw new Error(`Cathay current foreign account ${accountIndex} has no currency details.`);
    for (let detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
      const detail = requireObject(details[detailIndex], `foreign detail ${accountIndex}/${detailIndex}`) as CathayForeignApiDetail;
      if (typeof detail.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(detail.currencyCode)) {
        throw new Error(`Cathay current foreign detail ${accountIndex}/${detailIndex} currencyCode is invalid.`);
      }
      const currency = detail.currencyCode;
      const duplicateKey = `${accountNumber}\u0000${currency}`;
      if (seen.has(duplicateKey)) throw new Error("Cathay current foreign has duplicate account/currency rows.");
      seen.add(duplicateKey);
      const ledger = parseExactDecimal(detail.balance, `foreign detail ${accountIndex}/${detailIndex} ledger balance`);
      rows.push({
        source: "cathay",
        kind: "foreign",
        stream: "foreign-currency-deposit",
        sourceAccountKey: accountNumber,
        accountNumber,
        currency,
        currencySourceCode: currency,
        ledger,
        observations: [observation("ledger", ledger, currency, systemTime, httpDate)],
        providerSystemTime: systemTime,
        effectiveAt: systemTime,
        httpDate,
        observedAt,
        sourceEvidence: {
          endpoint: CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
          uiPath: CATHAY_CURRENT_FOREIGN_UI_PATH,
          status: 200,
          responseDigest: digest,
          contractVersion: CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION,
        },
        ...(authority ? { financialAuthority: authority } : {}),
      });
    }
  }
  if (rows.length === 0) throw new Error("Cathay current foreign response has no demand-account currencies.");
  return rows;
}

export function parseCathayCurrentDepositBalanceSnapshot(
  input: CathayCurrentDepositSnapshotInput,
): readonly CathayCurrentDepositBalanceRow[] {
  const httpDate = validateResponse(input.response, input.kind);
  const observedAt = validateObservedAt(input.observedAt);
  if (input.kind === "domestic") {
    return domesticRows(
      input.response,
      input.rawBody,
      observedAt,
      input.uiAccountNumbers,
      input.financialAuthority,
      httpDate,
    );
  }
  return foreignRows(input.rawBody, observedAt, input.financialAuthority, httpDate);
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
      const controls = scope.locator("a, button, [role='button']").filter({ hasText: matcher });
      const count = await controls.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) return control;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Could not find Cathay control "${text}".`);
}

async function readDomesticUiAccountNumbers(page: Page, timeoutMs: number): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const buttons = scope.locator("table button");
      const count = await buttons.count().catch(() => 0);
      const accounts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const label = cleanText(await buttons.nth(index).innerText().catch(() => ""));
        if (/^\d{12}$/u.test(label)) accounts.push(label);
      }
      if (accounts.length > 0) return accounts;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Could not read Cathay domestic UI account buttons.");
}

function responseMatches(
  kind: CathayCurrentDepositKind,
  response: Response,
): boolean {
  try {
    const url = new URL(response.url());
    const expectedPath =
      kind === "domestic"
        ? CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH
        : CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH;
    return (
      url.hostname === CATHAY_CURRENT_DEPOSIT_HOST &&
      url.pathname === expectedPath &&
      response.request().method().toUpperCase() === "POST"
    );
  } catch {
    return false;
  }
}

/** Passive response observer reached through the authenticated Cathay UI. */
export async function readCathayCurrentDepositBalances(
  page: Page,
  kind: CathayCurrentDepositKind,
  input: Readonly<{
    /** If omitted, capture knowledge time is sampled after the provider response arrives. */
    observedAt?: string;
    financialAuthority?: CathayCurrentDepositFinancialAuthority;
    timeoutMs?: number;
  }>,
): Promise<readonly CathayCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const section = await findExactControl(page, kind === "domestic" ? "臺幣" : "外幣", timeoutMs);
  await section.click();
  const overview = await findExactControl(
    page,
    kind === "domestic" ? "臺幣帳戶總覽" : "外幣帳戶總覽",
    timeoutMs,
  );
  const responsePromise = page.waitForResponse(
    (response) => responseMatches(kind, response),
    { timeout: timeoutMs },
  );
  await overview.click();
  const response = await responsePromise;
  const rawBody = await response.text();
  const headers = await response.allHeaders();
  const uiAccountNumbers =
    kind === "domestic"
      ? await readDomesticUiAccountNumbers(page, timeoutMs)
      : undefined;
  return parseCathayCurrentDepositBalanceSnapshot({
    kind,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      headers,
    },
    rawBody,
    observedAt: input.observedAt ?? new Date().toISOString(),
    uiAccountNumbers,
    financialAuthority: input.financialAuthority,
  });
}
