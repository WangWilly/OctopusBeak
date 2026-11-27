import { createHmac } from "node:crypto";
import {
  parseMaicoinTickerQuote,
  parseMaicoinProviderDate,
  readMaicoinStatementNativeIdentity,
  maicoinStatementQuerySpecs,
  resolveMaicoinTwdQuote,
  maicoinStatementRecordKey,
  type MaicoinAccountRecord,
  type MaicoinPublicMarket,
  type MaicoinStatementBatch,
  type MaicoinStatementRowType,
  type MaicoinTwdQuote,
  type MaicoinWalletAccountBatch,
} from "./canonical/maicoin-crypto-adapters.ts";
import { parseExactDecimalLexeme } from "./canonical/exact-decimal-lexeme.ts";
import type { InvestmentExactAmount, InvestmentTwdValuation } from "./canonical/investment-financial.ts";
import { decimalToExact, multiplyExact } from "../lib/shared-money/exact-money.ts";

const API_BASE_URL = "https://max-api.maicoin.com";
export const MAICOIN_STATEMENT_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRY_DELAYS_MS = [500, 1_000, 2_000];
export const MAICOIN_WALLET_TYPES = ["spot", "m"] as const;
const MAICOIN_HISTORY_START_TIMESTAMP = 1_512_950_400_000;

export type WalletType = typeof MAICOIN_WALLET_TYPES[number];
type QueryParams = Record<string, string | number | boolean | readonly string[] | undefined>;

export type MaxCredentials = {
  accessKey: string;
  secretKey: string;
  subAccount: string;
  /** Optional explicit fallback when the provider info response has no email. */
  providerEmail?: string;
};

type Account = MaicoinAccountRecord & {
  [key: string]: unknown;
};

type Credentials = MaxCredentials;

type MaxInfo = {
  email?: unknown;
  provider_email?: unknown;
  user_email?: unknown;
  m_wallet_enabled?: boolean;
};

type MaxResponse<T> = {
  data: T;
  providerDate: string | null;
};

export type MaicoinMarket = {
  id: string;
  base_unit: string;
  quote_unit: string;
  status: string;
};

type Ticker = {
  market: string;
  at: number;
  last: string;
  [key: string]: unknown;
};

type TickerSnapshot = {
  providerDate: ReturnType<typeof parseMaicoinProviderDate> | null;
  tickers: Map<string, Ticker>;
};

type StatementBatch = MaicoinStatementBatch;

export class MaxClient {
  #lastNonce = 0;
  private readonly credentials: Credentials;
  private readonly signal?: AbortSignal;

  constructor(credentials: Credentials, signal?: AbortSignal) {
    this.credentials = credentials;
    this.signal = signal;
  }

  throwIfAborted() {
    this.signal?.throwIfAborted();
  }

  async publicGet<T>(path: string, params: QueryParams = {}): Promise<T> {
    return fetchWithRetry(() => {
      const url = new URL(path, API_BASE_URL);
      appendQuery(url, params);
      return fetchJson<T>(url, { signal: this.signal });
    }, FETCH_RETRY_DELAYS_MS, this.signal);
  }

  async publicGetWithMetadata<T>(path: string, params: QueryParams = {}): Promise<MaxResponse<T>> {
    return fetchWithRetry(() => {
      const url = new URL(path, API_BASE_URL);
      appendQuery(url, params);
      return fetchJsonWithMetadata<T>(url, { signal: this.signal });
    }, FETCH_RETRY_DELAYS_MS, this.signal);
  }

  private async privateGetResponse<T>(
    path: string,
    params: QueryParams = {},
  ): Promise<MaxResponse<T>> {
    return fetchWithRetry(() => {
      const signedParams = { nonce: this.nextNonce(), ...params };
      const { payload, signature } = signPayload(
        path,
        signedParams,
        this.credentials.secretKey,
      );
      const url = new URL(path, API_BASE_URL);
      appendQuery(url, signedParams);
      return fetchJsonWithMetadata<T>(url, {
        signal: this.signal,
        headers: {
          "Content-Type": "application/json",
          "X-MAX-ACCESSKEY": this.credentials.accessKey,
          "X-MAX-PAYLOAD": payload,
          "X-MAX-SIGNATURE": signature,
          "X-Sub-Account": this.credentials.subAccount,
        },
      });
    }, FETCH_RETRY_DELAYS_MS, this.signal);
  }

  async privateGet<T>(path: string, params: QueryParams = {}): Promise<T> {
    return (await this.privateGetResponse<T>(path, params)).data;
  }

  /**
   * Return the provider response metadata along with a private response.  MAX
   * account endpoints do not include an as-of value in the JSON body; the
   * HTTP Date header is therefore the only provider-reported observation time
   * available to the canonical investment adapter.
   */
  async privateGetWithMetadata<T>(
    path: string,
    params: QueryParams = {},
  ): Promise<MaxResponse<T>> {
    return this.privateGetResponse<T>(path, params);
  }

  private nextNonce() {
    this.#lastNonce = Math.max(Date.now(), this.#lastNonce + 1);
    return this.#lastNonce;
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  )?.trim();
}

/**
 * Resolve the stable account boundary from the provider's authenticated
 * identity response.  Access keys identify credentials, not the owner, and
 * must never be used as an account identity fallback.
 */
export function resolveMaicoinProviderEmail(
  info: unknown,
  configuredProviderEmail?: string,
): string {
  const response = info && typeof info === "object"
    ? info as Record<string, unknown>
    : {};
  const providerEmail = firstNonEmptyString(
    response.email,
    response.provider_email,
    response.user_email,
    (response.user && typeof response.user === "object"
      ? (response.user as Record<string, unknown>).email
      : undefined),
  );
  const configured = firstNonEmptyString(configuredProviderEmail);
  if (providerEmail && configured && providerEmail.toLocaleLowerCase("en-US") !== configured.toLocaleLowerCase("en-US"))
    throw new Error(
      "MAX provider email disagrees with the configured account identity; refusing to merge source connections.",
    );
  if (providerEmail ?? configured) return providerEmail ?? configured!;
  throw new Error(
    "MAX provider email is required to establish the canonical account boundary; refusing to use the API key as identity.",
  );
}

function appendQuery(url: URL, params: QueryParams) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(item));
    }
  }
}

async function fetchJsonWithMetadata<T>(
  url: URL,
  init: RequestInit = {},
): Promise<MaxResponse<T>> {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(url, {
    ...init,
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`${init.method ?? "GET"} ${url.pathname} failed ${response.status}: ${body}`) as Error & {
      status: number;
    };
    error.status = response.status;
    throw error;
  }
  const data = body ? JSON.parse(body) : null;
  return { data: data as T, providerDate: response.headers.get("date") };
}

async function fetchJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  return (await fetchJsonWithMetadata<T>(url, init)).data;
}

async function fetchWithRetry<T>(
  request: () => Promise<T>,
  delays = FETCH_RETRY_DELAYS_MS,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      lastError = error;
      if (attempt === delays.length || !isRetryableFetchError(error)) throw error;
      await sleep(delays[attempt]!, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableFetchError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status: unknown }).status
    : null;
  return typeof status !== "number" || status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function signPayload(path: string, params: QueryParams, secretKey: string) {
  const payload = Buffer.from(JSON.stringify({ ...params, path })).toString("base64");
  const signature = createHmac("sha256", secretKey).update(payload).digest("hex");
  return { payload, signature };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function createdAtMillis(row: Record<string, unknown>) {
  const timestamp = numeric(row.created_at) ?? 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function requiredCreatedAtMillis(row: Record<string, unknown>, endpoint: string): number {
  const value = numeric(row.created_at);
  const milliseconds = value === null
    ? Number.NaN
    : value < 10_000_000_000 ? value * 1000 : value;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < MAICOIN_HISTORY_START_TIMESTAMP)
    throw new Error(`MAX statement response for ${endpoint} contains an invalid created_at timestamp.`);
  return milliseconds;
}

function taipeiCalendarDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function stableStatementValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableStatementValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableStatementValue(child)]),
    );
  return value;
}

function stableStatementJson(value: unknown): string {
  return JSON.stringify(stableStatementValue(value));
}

function statementExternalId(
  rowType: MaicoinStatementRowType,
  row: Record<string, unknown>,
): string {
  const identity = readMaicoinStatementNativeIdentity(rowType, row);
  if (identity.kind === "present") return identity.externalId;
  throw new Error(`MAX ${rowType} history row is missing its contract-required ${identity.field} provider ID.`);
}

function tickerMarketsForAccounts(accounts: Account[], markets: Set<string>) {
  const tickerMarkets = new Set<string>();
  for (const account of accounts) {
    const currency = account.currency.toLowerCase();
    if (currency === "twd") continue;
    if (markets.has(`${currency}twd`)) tickerMarkets.add(`${currency}twd`);
    if (markets.has(`${currency}usdt`)) tickerMarkets.add(`${currency}usdt`);
    if (markets.has("usdttwd")) tickerMarkets.add("usdttwd");
  }
  return tickerMarkets;
}

async function fetchTickers(client: MaxClient, markets: Set<string>) {
  if (markets.size === 0) return { providerDate: null, tickers: new Map<string, Ticker>() };
  const response = await client.publicGetWithMetadata<Ticker[]>("/api/v3/tickers", {
    "markets[]": [...markets].sort(),
  });
  let providerDate: TickerSnapshot["providerDate"] = null;
  try {
    providerDate = parseMaicoinProviderDate(response.providerDate);
  } catch {
    // Public ticker time is required for a valuation, but not for retaining
    // the independently time-qualified wallet holding.  Keep the quotes
    // unavailable when the public response cannot provide that evidence.
  }
  if (!Array.isArray(response.data))
    throw new Error("MAX public tickers response is not an array.");
  const tickers = new Map<string, Ticker>();
  for (const ticker of response.data) {
    if (!ticker || typeof ticker.market !== "string" || ticker.market.trim() === "")
      throw new Error("MAX public ticker is missing its market identifier.");
    const market = ticker.market.toLowerCase();
    if (tickers.has(market))
      throw new Error(`MAX public tickers response contains duplicate market: ${market}.`);
    tickers.set(market, ticker);
  }
  return { providerDate, tickers };
}

function publicMarket(market: MaicoinMarket): MaicoinPublicMarket {
  return {
    id: market.id,
    baseUnit: market.base_unit,
    quoteUnit: market.quote_unit,
    status: market.status,
  };
}

function valuationQuotesForAccounts(
  accounts: readonly MaicoinAccountRecord[],
  markets: readonly MaicoinMarket[],
  tickerSnapshot: TickerSnapshot,
) {
  if (!tickerSnapshot.providerDate) return new Map<string, MaicoinTwdQuote>();
  const publicMarkets = markets.map(publicMarket);
  const byMarket = new Map(publicMarkets.map((market) => [market.id.toLowerCase(), market]));
  const components = new Map<string, ReturnType<typeof parseMaicoinTickerQuote>>();
  for (const [marketId, ticker] of tickerSnapshot.tickers) {
    const market = byMarket.get(marketId);
    if (!market) continue;
    try {
      components.set(
        marketId,
        parseMaicoinTickerQuote(ticker, market, tickerSnapshot.providerDate),
      );
    } catch {
      // A malformed public quote is an unavailable valuation input.  The
      // canonical capture still retains the source holding and leaves its
      // valuation absent rather than persisting a guessed value.
    }
  }
  const quotes = new Map<string, MaicoinTwdQuote>();
  for (const account of accounts) {
    const currency = account.currency.toUpperCase();
    if (currency === "TWD" || quotes.has(currency)) continue;
    try {
      const quote = resolveMaicoinTwdQuote(currency, publicMarkets, components);
      if (quote) quotes.set(currency, quote);
    } catch {
      // Ambiguous market metadata is a known gap, never a zero valuation.
    }
  }
  return quotes;
}

export type MaicoinSourceCollection = Readonly<{
  providerEmail: string;
  walletTypes: readonly WalletType[];
  accountBatches: readonly MaicoinWalletAccountBatch[];
  marketRows: readonly MaicoinMarket[];
  statementBatches: readonly MaicoinStatementBatch[];
  valuationQuotes: ReadonlyMap<string, MaicoinTwdQuote>;
  /** Each priced statement row's TWD valuation, by its `transaction` leg's source record key. */
  statementValuations: ReadonlyMap<string, InvestmentTwdValuation>;
  capturedAt: string;
}>;

/** Collect and preflight all MAX source values in memory before any commit. */
export async function collectMaicoinSource(
  credentials: MaxCredentials,
  options: Readonly<{
    walletTypes?: readonly WalletType[];
    statementLimit?: number;
    signal?: AbortSignal;
    now(): string;
    onWalletsCollected?(count: number): void | Promise<void>;
    onStatementsStarted?(): void | Promise<void>;
    onStatementsCollected?(count: number): void | Promise<void>;
  }>,
): Promise<MaicoinSourceCollection> {
  options.signal?.throwIfAborted();
  const client = new MaxClient(credentials, options.signal);
  const selection = await fetchWalletTypes(
    client,
    [...(options.walletTypes ?? MAICOIN_WALLET_TYPES)],
    credentials.providerEmail,
  );
  if (selection.walletTypes.length === 0)
    throw new Error("MAX reported no requested wallet types enabled for this account.");
  const accountBatches = await fetchAccounts(client, selection.walletTypes);
  const accounts = accountBatches.flatMap((batch) => batch.accounts);
  options.signal?.throwIfAborted();
  const marketRows = validateMarkets(await client.publicGet<unknown>("/api/v3/markets"));
  const markets = new Set(marketRows.map((market) => market.id.toLowerCase()));
  const tickerSnapshot = await fetchTickers(
    client,
    tickerMarketsForAccounts(accounts, markets),
  );
  const valuationQuotes = valuationQuotesForAccounts(accounts, marketRows, tickerSnapshot);
  const capturedAt = options.now();
  await options.onWalletsCollected?.(accounts.length);

  await options.onStatementsStarted?.();
  const statementBatches = await fetchStatement(
    client,
    selection.walletTypes,
    options.statementLimit ?? MAICOIN_STATEMENT_LIMIT,
  );
  const statementValuations = await statementTwdValuations(client, statementBatches, markets, capturedAt);
  const statementCount = statementBatches.reduce((count, batch) => count + batch.rows.length, 0);
  await options.onStatementsCollected?.(statementCount);
  options.signal?.throwIfAborted();

  return {
    providerEmail: selection.providerEmail,
    walletTypes: selection.walletTypes,
    accountBatches,
    marketRows,
    statementBatches,
    valuationQuotes,
    statementValuations,
    capturedAt,
  };
}

const DAY_MS = 86_400_000;

/**
 * A daily close lookup ends in a close or in no price. No price is
 * deterministic: the coin has no market, or MAX has no candle for that exact
 * UTC day. Any other failure throws and fails the collection, so a transient
 * error never stands in for "no price" and flips a stored payload (ADR 0158).
 */
type DailyClose = Readonly<{ kind: "close"; close: InvestmentExactAmount }> | Readonly<{ kind: "none" }>;

const NO_PRICE: DailyClose = { kind: "none" };

/**
 * The TWD value of each reward and each non-TWD deposit, the rows Cash flow
 * counts as income (ADR 0146). A row is priced only from a finished UTC day's
 * close, so its valuation never changes once written; a row of the capture's
 * own UTC day carries none until a later sync.
 */
async function statementTwdValuations(
  client: MaxClient,
  statement: readonly StatementBatch[],
  markets: ReadonlySet<string>,
  capturedAt: string,
): Promise<Map<string, InvestmentTwdValuation>> {
  const todayStartMs = Math.floor(Date.parse(capturedAt) / DAY_MS) * DAY_MS;
  const closes = new Map<string, Promise<DailyClose>>();
  const close = (market: string, dayStartMs: number): Promise<DailyClose> => {
    const key = `${market}:${dayStartMs}`;
    if (!closes.has(key)) closes.set(key, dailyClose(client, market, dayStartMs));
    return closes.get(key)!;
  };
  const valuations = new Map<string, InvestmentTwdValuation>();
  for (const batch of statement) {
    if (batch.rowType !== "reward" && batch.rowType !== "deposit") continue;
    for (const row of batch.rows) {
      client.throwIfAborted();
      const valuation = await statementTwdValuation(batch.rowType, row, markets, todayStartMs, close);
      if (valuation)
        valuations.set(maicoinStatementRecordKey({
          endpoint: batch.endpoint,
          walletType: batch.walletType,
          rowType: batch.rowType,
          externalId: statementExternalId(batch.rowType, row),
          leg: "transaction",
        }), valuation);
    }
  }
  return valuations;
}

async function statementTwdValuation(
  rowType: "reward" | "deposit",
  row: Record<string, unknown>,
  markets: ReadonlySet<string>,
  todayStartMs: number,
  close: (market: string, dayStartMs: number) => Promise<DailyClose>,
): Promise<InvestmentTwdValuation | null> {
  const coin = stringValue(row.currency)?.trim().toLowerCase();
  const quantity = exactStatementAmount(row.amount);
  // The adapter rejects a row without a valid currency or amount.
  if (!coin || !quantity) return null;
  if (coin === "twd")
    return rowType === "reward" ? { route: "twd", value: { ...quantity, currency: "TWD" } } : null;
  const dayStartMs = Math.floor(createdAtMillis(row) / DAY_MS) * DAY_MS;
  if (dayStartMs >= todayStartMs) return null;
  const candleDay = new Date(dayStartMs).toISOString().slice(0, 10);
  const direct = `${coin}twd`;
  if (markets.has(direct)) {
    const price = await close(direct, dayStartMs);
    return price.kind === "none" ? null : {
      route: "direct",
      value: { ...multiplyExact(quantity, price.close), currency: "TWD" },
      market: direct,
      close: price.close,
      candleDay,
    };
  }
  const viaUsdt = `${coin}usdt`;
  if (!markets.has(viaUsdt) || !markets.has("usdttwd")) return null;
  const [price, usdtTwd] = await Promise.all([close(viaUsdt, dayStartMs), close("usdttwd", dayStartMs)]);
  if (price.kind === "none" || usdtTwd.kind === "none") return null;
  return {
    route: "via-usdt",
    value: { ...multiplyExact(multiplyExact(quantity, price.close), usdtTwd.close), currency: "TWD" },
    market: viaUsdt,
    close: price.close,
    usdtTwdClose: usdtTwd.close,
    candleDay,
  };
}

function exactStatementAmount(value: unknown): InvestmentExactAmount | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = parseExactDecimalLexeme(value.trim());
    return parsed.coefficient < 0n ? null : { coefficient: parsed.coefficient.toString(), scale: parsed.scale };
  } catch {
    return null;
  }
}

/** MAX k-line rows are `[startSeconds, open, high, low, close, volume]`. */
async function dailyClose(client: MaxClient, market: string, dayStartMs: number): Promise<DailyClose> {
  const dayStart = dayStartMs / 1000;
  const rows = await client.publicGet<unknown>("/api/v3/k", {
    market,
    period: 1440,
    limit: 2,
    timestamp: dayStart,
  });
  if (!Array.isArray(rows)) throw new Error(`MAX k-line response for ${market} is not an array.`);
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) throw new Error(`MAX k-line response for ${market} has a malformed candle.`);
    const start = Number(row[0]);
    if (!Number.isSafeInteger(start)) throw new Error(`MAX k-line response for ${market} has a malformed candle time.`);
    if (start < dayStart || start >= dayStart + 86_400) continue;
    return { kind: "close", close: candleClose(row[4], market) };
  }
  return NO_PRICE;
}

function candleClose(value: unknown, market: string): InvestmentExactAmount {
  const exact = typeof value === "string"
    ? exactStatementAmount(value)
    : typeof value === "number" ? decimalToExact(value) : null;
  if (!exact || BigInt(exact.coefficient) <= 0n)
    throw new Error(`MAX k-line response for ${market} has a malformed close.`);
  return exact;
}

export async function fetchWalletTypes(
  client: MaxClient,
  requested: WalletType[],
  configuredProviderEmail?: string,
) {
  const info = await client.privateGet<MaxInfo>("/api/v3/info");
  const walletTypes = info.m_wallet_enabled === false
    ? requested.filter((walletType) => walletType !== "m")
    : requested;
  return {
    walletTypes,
    providerEmail: resolveMaicoinProviderEmail(info, configuredProviderEmail),
  };
}

export async function fetchAccounts(
  client: MaxClient,
  walletTypes: WalletType[],
): Promise<MaicoinWalletAccountBatch[]> {
  const batches: MaicoinWalletAccountBatch[] = [];
  for (const walletType of walletTypes) {
    const response = await client.privateGetWithMetadata<Account[]>(
      `/api/v3/wallet/${walletType}/accounts`,
    );
    const providerDate = parseMaicoinProviderDate(response.providerDate);
    if (!Array.isArray(response.data))
      throw new Error(`MAX ${walletType} wallet accounts response is not an array.`);
    if (response.data.some((account) => typeof account !== "object" || account === null || Array.isArray(account)))
      throw new Error(`MAX ${walletType} wallet accounts response contains an invalid row.`);
    // Keep zero-valued rows: a complete provider snapshot includes the fact
    // that the account exists even when its current holding is zero.
    batches.push({
      walletType,
      providerDate,
      accounts: response.data,
    });
  }
  return batches;
}

function validateMarkets(value: unknown): MaicoinMarket[] {
  if (!Array.isArray(value)) throw new Error("MAX public markets response is not an array.");
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("MAX public markets response contains an invalid row.");
    const market = candidate as Partial<MaicoinMarket>;
    if (typeof market.id !== "string" || market.id.trim() === ""
      || typeof market.base_unit !== "string" || market.base_unit.trim() === ""
      || typeof market.quote_unit !== "string" || market.quote_unit.trim() === ""
      || typeof market.status !== "string" || market.status.trim() === "")
      throw new Error("MAX public markets response contains an incomplete row.");
    const key = market.id.toLowerCase();
    if (seen.has(key)) throw new Error("MAX public markets response contains a duplicate market.");
    seen.add(key);
    return market as MaicoinMarket;
  });
}

async function fetchStatement(
  client: MaxClient,
  walletTypes: WalletType[],
  limit: number,
) {
  const batches: StatementBatch[] = [];
  for (const spec of maicoinStatementQuerySpecs(walletTypes)) {
    const history = await fetchFullStatementRows(client, spec.endpoint, limit, spec.rowType);
    batches.push({ ...spec, ...history });
  }
  return batches;
}

type CompleteStatementHistory = Readonly<{
  rows: Record<string, unknown>[];
  history: Readonly<{ startDate: string; endDate: string; complete: true }>;
}>;

function requiredTradeId(row: Record<string, unknown>, endpoint: string): number {
  const value = row.id;
  const lexeme = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && /^\d+$/u.test(value)
      ? value
      : "";
  if (!lexeme) throw new Error(`MAX trade response for ${endpoint} contains a missing or unsafe int64 trade ID.`);
  const parsed = BigInt(lexeme);
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`MAX trade response for ${endpoint} contains a trade ID outside the safe cursor range.`);
  return Number(parsed);
}

function requireHistoryPage(
  value: unknown,
  endpoint: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error(`MAX statement response for ${endpoint} is not an array.`);
  if (value.some((row) => typeof row !== "object" || row === null || Array.isArray(row)))
    throw new Error(`MAX statement response for ${endpoint} contains an invalid row.`);
  return value as Record<string, unknown>[];
}

function completeHistoryEvidence(
  providerDate: ReturnType<typeof parseMaicoinProviderDate>,
): CompleteStatementHistory["history"] {
  const startDate = taipeiCalendarDate(MAICOIN_HISTORY_START_TIMESTAMP);
  const endDate = taipeiCalendarDate(Date.parse(providerDate.effectiveAt));
  if (endDate < startDate)
    throw new Error("MAX statement history provider date precedes its documented history lower bound.");
  return { startDate, endDate, complete: true };
}

function completeHistoryPageEvidence(
  providerDate: ReturnType<typeof parseMaicoinProviderDate>,
  previous: CompleteStatementHistory["history"] | undefined,
  endpoint: string,
): CompleteStatementHistory["history"] {
  const current = completeHistoryEvidence(providerDate);
  if (previous && current.endDate !== previous.endDate)
    throw new Error(`MAX statement history for ${endpoint} crossed a provider calendar date while pages were collected.`);
  return current;
}

export async function fetchFullStatementRows(
  client: MaxClient,
  endpoint: string,
  limit: number,
  rowType: MaicoinStatementRowType,
): Promise<CompleteStatementHistory> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("MAX statement limit must be between 1 and 1000.");
  return rowType === "trade"
    ? fetchFullTradeHistory(client, endpoint, limit)
    : fetchFullTimestampHistory(client, endpoint, limit, rowType);
}

async function fetchFullTradeHistory(
  client: MaxClient,
  endpoint: string,
  limit: number,
): Promise<CompleteStatementHistory> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Map<number, string>();
  // Begin at the first positive native ID, retaining ID 1 in ascending history.
  let fromId = 1;
  let terminalHistory: CompleteStatementHistory["history"] | undefined;
  while (true) {
    const response = await client.privateGetWithMetadata<unknown>(endpoint, {
      order: "asc",
      limit,
      from_id: fromId,
    });
    terminalHistory = completeHistoryPageEvidence(
      parseMaicoinProviderDate(response.providerDate),
      terminalHistory,
      endpoint,
    );
    const page = requireHistoryPage(response.data, endpoint);
    if (page.length === 0) break;

    const previousCursor = fromId;
    let pageLastId = previousCursor;
    let previousPageId = previousCursor;
    for (const row of page) {
      const id = requiredTradeId(row, endpoint);
      if (id < previousCursor || id < previousPageId)
        throw new Error(`MAX trade pagination for ${endpoint} returned IDs out of ascending order.`);
      previousPageId = id;
      pageLastId = Math.max(pageLastId, id);
      const payload = stableStatementJson(row);
      const previousPayload = seen.get(id);
      if (previousPayload !== undefined) {
        if (previousPayload !== payload)
          throw new Error(`MAX trade history for ${endpoint} contains conflicting payloads for one provider ID.`);
        continue;
      }
      seen.set(id, payload);
      rows.push(row);
    }
    if (page.length < limit) break;
    if (pageLastId <= previousCursor)
      throw new Error(`MAX trade pagination for ${endpoint} did not advance beyond its reliable ID boundary.`);
    fromId = pageLastId;
  }
  if (!terminalHistory) throw new Error(`MAX trade history for ${endpoint} has no terminal response.`);
  return { rows, history: terminalHistory };
}

async function fetchFullTimestampHistory(
  client: MaxClient,
  endpoint: string,
  limit: number,
  rowType: MaicoinStatementRowType,
): Promise<CompleteStatementHistory> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Map<string, string>();
  let timestamp = MAICOIN_HISTORY_START_TIMESTAMP;
  let terminalHistory: CompleteStatementHistory["history"] | undefined;
  while (true) {
    const response = await client.privateGetWithMetadata<unknown>(endpoint, {
      order: "asc",
      limit,
      timestamp,
    });
    terminalHistory = completeHistoryPageEvidence(
      parseMaicoinProviderDate(response.providerDate),
      terminalHistory,
      endpoint,
    );
    const page = requireHistoryPage(response.data, endpoint);
    if (page.length === 0) break;

    let previousPageTimestamp = timestamp;
    let pageLastTimestamp = timestamp;
    for (const row of page) {
      const createdAt = requiredCreatedAtMillis(row, endpoint);
      if (createdAt < timestamp || createdAt < previousPageTimestamp)
        throw new Error(`MAX statement pagination for ${endpoint} returned timestamps outside ascending history order.`);
      previousPageTimestamp = createdAt;
      pageLastTimestamp = Math.max(pageLastTimestamp, createdAt);

      const identity = statementExternalId(rowType, row);
      const payload = stableStatementJson(row);
      const previousPayload = seen.get(identity);
      if (previousPayload !== undefined) {
        if (previousPayload !== payload)
          throw new Error(`MAX statement history for ${endpoint} contains conflicting payloads for one provider ID.`);
        continue;
      }
      seen.set(identity, payload);
      rows.push(row);
    }
    if (page.length < limit) break;
    if (pageLastTimestamp <= timestamp)
      throw new Error(`MAX statement pagination for ${endpoint} reached a saturated same-timestamp boundary.`);
    timestamp = pageLastTimestamp;
  }
  if (!terminalHistory) throw new Error(`MAX statement history for ${endpoint} has no terminal response.`);
  return { rows, history: terminalHistory };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
