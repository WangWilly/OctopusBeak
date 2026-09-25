import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
  PGliteMaicoinSnapshot,
  PGliteMaicoinStatementRow,
} from "./pglite/maicoin-operational.ts";
import {
  parseMaicoinTickerQuote,
  parseMaicoinProviderDate,
  resolveMaicoinTwdQuote,
  type MaicoinAccountRecord,
  type MaicoinPublicMarket,
  type MaicoinStatementBatch,
  type MaicoinTwdQuote,
  type MaicoinWalletAccountBatch,
} from "./canonical/maicoin-crypto-adapters.ts";

const API_BASE_URL = "https://max-api.maicoin.com";
export const MAICOIN_STATEMENT_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRY_DELAYS_MS = [500, 1_000, 2_000];
export const MAICOIN_WALLET_TYPES = ["spot", "m"] as const;

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

export type MaicoinAccountSnapshot = {
  walletType: WalletType;
  account: Account;
  price: PriceQuote;
  totalQuantity: number;
  valueTwd: number | null;
};

type PriceQuote = {
  market: string | null;
  currency: string | null;
  price: number | null;
  at: string | null;
  raw: unknown;
};

type StatementBatch = MaicoinStatementBatch;

type StatementSpec = Omit<StatementBatch, "rows">;
type StatementValueMap = Map<string, number | null>;
type KLine = [number, number | string, number | string, number | string, number | string, number | string];

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

function amount(value: unknown) {
  return numeric(value) ?? 0;
}

function isoFromTimestamp(value: unknown): string | null {
  const timestamp = numeric(value);
  if (timestamp === null) return null;
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp).toISOString();
}

function createdAtMillis(row: Record<string, unknown>) {
  const timestamp = numeric(row.created_at) ?? 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function hashId(...parts: unknown[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? part : JSON.stringify(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function statementExternalId(row: Record<string, unknown>) {
  return String(row.id ?? row.sn ?? row.uuid ?? hashId(row));
}

function statementIdFor(batch: StatementSpec, row: Record<string, unknown>) {
  return hashId(batch.endpoint, batch.walletType ?? "", batch.rowType, statementExternalId(row));
}

function totalQuantity(account: Account) {
  return amount(account.balance) + amount(account.locked) + amount(account.staked);
}

function priceForCurrency(currency: string, tickers: Map<string, Ticker>): PriceQuote {
  const normalized = currency.toLowerCase();
  if (normalized === "twd") {
    return { market: null, currency: "TWD", price: 1, at: null, raw: null };
  }

  const direct = tickers.get(`${normalized}twd`);
  if (direct) return tickerQuote(direct, "TWD");

  if (normalized === "usdt") {
    return { ...missingQuote(), market: "usdttwd", currency: "TWD" };
  }

  const viaUsdt = tickers.get(`${normalized}usdt`);
  const usdtTwd = tickers.get("usdttwd");
  const viaUsdtPrice = numeric(viaUsdt?.last);
  const usdtTwdPrice = numeric(usdtTwd?.last);
  if (viaUsdt && usdtTwd && viaUsdtPrice !== null && usdtTwdPrice !== null) {
    return {
      market: `${viaUsdt.market}+${usdtTwd.market}`,
      currency: "TWD",
      price: viaUsdtPrice * usdtTwdPrice,
      at: isoFromTimestamp(Math.max(viaUsdt.at, usdtTwd.at)),
      raw: [viaUsdt, usdtTwd],
    };
  }

  return missingQuote();
}

function tickerQuote(ticker: Ticker, currency: string): PriceQuote {
  return {
    market: ticker.market,
    currency,
    price: numeric(ticker.last),
    at: isoFromTimestamp(ticker.at),
    raw: ticker,
  };
}

function missingQuote(): PriceQuote {
  return { market: null, currency: null, price: null, at: null, raw: null };
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

async function statementValueMap(
  client: MaxClient,
  statement: StatementBatch[],
  markets: Set<string>,
): Promise<StatementValueMap> {
  const cache = new Map<string, Promise<number | null>>();
  const values: StatementValueMap = new Map();
  for (const batch of statement) {
    for (const row of batch.rows) {
      client.throwIfAborted();
      values.set(statementIdFor(batch, row), await statementValueTwd(client, markets, cache, batch.rowType, row));
    }
  }
  return values;
}

export type MaicoinSourceCollection = Readonly<{
  providerEmail: string;
  walletTypes: readonly WalletType[];
  accountBatches: readonly MaicoinWalletAccountBatch[];
  marketRows: readonly MaicoinMarket[];
  statementBatches: readonly MaicoinStatementBatch[];
  snapshots: readonly MaicoinAccountSnapshot[];
  valuationQuotes: ReadonlyMap<string, MaicoinTwdQuote>;
  statementValues: ReadonlyMap<string, number | null>;
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
  const snapshots = buildSnapshots(accountBatches, tickerSnapshot.tickers);
  const valuationQuotes = valuationQuotesForAccounts(accounts, marketRows, tickerSnapshot);
  const capturedAt = options.now();
  await options.onWalletsCollected?.(snapshots.length);

  await options.onStatementsStarted?.();
  const statementBatches = await fetchStatement(
    client,
    selection.walletTypes,
    options.statementLimit ?? MAICOIN_STATEMENT_LIMIT,
  );
  const statementValues = await statementValueMap(client, statementBatches, markets);
  const statementCount = statementBatches.reduce((count, batch) => count + batch.rows.length, 0);
  await options.onStatementsCollected?.(statementCount);
  options.signal?.throwIfAborted();

  return {
    providerEmail: selection.providerEmail,
    walletTypes: selection.walletTypes,
    accountBatches,
    marketRows,
    statementBatches,
    snapshots,
    valuationQuotes,
    statementValues,
    capturedAt,
  };
}

async function statementValueTwd(
  client: MaxClient,
  markets: Set<string>,
  cache: Map<string, Promise<number | null>>,
  rowType: string,
  row: Record<string, unknown>,
) {
  const timestamp = createdAtMillis(row);
  if (!timestamp) return null;

  if (rowType === "trade") {
    const units = marketUnits(stringValue(row.market));
    const quotePrice = units ? await historicalPriceTwd(client, markets, cache, units.quote, timestamp) : null;
    return quotePrice === null ? null : amount(row.funds) * quotePrice;
  }

  if (rowType === "convert") {
    const price = await historicalPriceTwd(client, markets, cache, stringValue(row.from_currency), timestamp);
    return price === null ? null : amount(row.from_amount) * price;
  }

  if (rowType === "deposit" || rowType === "reward" || rowType === "withdrawal") {
    const price = await historicalPriceTwd(client, markets, cache, stringValue(row.currency), timestamp);
    return price === null ? null : amount(row.amount) * price;
  }

  return null;
}

async function historicalPriceTwd(
  client: MaxClient,
  markets: Set<string>,
  cache: Map<string, Promise<number | null>>,
  currency: string | null,
  timestamp: number,
) {
  const normalized = currency?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "twd") return 1;
  const day = dayStartSeconds(timestamp);
  const key = `${normalized}:${day}`;
  if (!cache.has(key)) {
    cache.set(key, historicalPriceTwdUncached(client, markets, normalized, day));
  }
  return cache.get(key)!;
}

async function historicalPriceTwdUncached(
  client: MaxClient,
  markets: Set<string>,
  normalized: string,
  dayStart: number,
) {
  const directMarket = `${normalized}twd`;
  if (markets.has(directMarket)) return historicalMarketClose(client, directMarket, dayStart);

  const viaUsdtMarket = `${normalized}usdt`;
  if (!markets.has(viaUsdtMarket) || !markets.has("usdttwd")) return null;
  const [viaUsdt, usdtTwd] = await Promise.all([
    historicalMarketClose(client, viaUsdtMarket, dayStart),
    historicalMarketClose(client, "usdttwd", dayStart),
  ]);
  return viaUsdt === null || usdtTwd === null ? null : viaUsdt * usdtTwd;
}

async function historicalMarketClose(client: MaxClient, market: string, dayStart: number) {
  try {
    const rows = await client.publicGet<KLine[]>("/api/v3/k", {
      market,
      period: 1440,
      limit: 2,
      timestamp: dayStart,
    });
    const row = rows.find((item) => Number(item[0]) >= dayStart && Number(item[0]) < dayStart + 86400) ?? rows[0];
    return numeric(row?.[4]);
  } catch {
    client.throwIfAborted();
    return null;
  }
}

function dayStartSeconds(timestamp: number) {
  return Math.floor(timestamp / 86_400_000) * 86_400;
}

function marketUnits(market: string | null) {
  if (!market) return null;
  for (const quote of ["usdt", "usdc", "twd", "btc", "eth"]) {
    if (market.endsWith(quote) && market.length > quote.length) {
      return { base: market.slice(0, -quote.length), quote };
    }
  }
  return null;
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
  const specs: StatementSpec[] = [
    ...walletTypes.map((walletType) => ({
      endpoint: `/api/v3/wallet/${walletType}/trades`,
      walletType,
      rowType: "trade" as const,
    })),
    {
      endpoint: "/api/v3/fund_transactions/deposits",
      walletType: null,
      rowType: "deposit" as const,
    },
    {
      endpoint: "/api/v3/fund_transactions/withdrawals",
      walletType: null,
      rowType: "withdrawal" as const,
    },
    {
      endpoint: "/api/v3/fund_transactions/transfers",
      walletType: null,
      rowType: "transfer" as const,
    },
    {
      endpoint: "/api/v3/rewards",
      walletType: null,
      rowType: "reward" as const,
    },
    {
      endpoint: "/api/v3/converts",
      walletType: null,
      rowType: "convert" as const,
    },
  ];

  const batches: StatementBatch[] = [];
  for (const spec of specs) {
    const rows = await fetchFullStatementRows(client, spec.endpoint, limit);
    batches.push({ ...spec, rows });
  }
  return batches;
}

async function fetchFullStatementRows(client: MaxClient, endpoint: string, limit: number) {
  const rows: Record<string, unknown>[] = [];
  let timestamp = 1512950400000;
  while (true) {
    const page = await client.privateGet<Record<string, unknown>[]>(endpoint, {
      order: "asc",
      limit,
      timestamp,
    });
    if (!Array.isArray(page)) throw new Error(`MAX statement response for ${endpoint} is not an array.`);
    if (page.some((row) => typeof row !== "object" || row === null || Array.isArray(row)))
      throw new Error(`MAX statement response for ${endpoint} contains an invalid row.`);
    if (page.length === 0) break;

    rows.push(...page);
    const nextTimestamp = Math.max(...page.map((row) => createdAtMillis(row))) + 1;
    if (page.length < limit) break;
    if (nextTimestamp <= timestamp)
      throw new Error(`MAX statement pagination for ${endpoint} did not advance.`);
    timestamp = nextTimestamp;
  }
  return rows;
}

function buildSnapshots(
  accountBatches: Array<{ walletType: WalletType; accounts: Account[] }>,
  tickers: Map<string, Ticker>,
) {
  const snapshots: MaicoinAccountSnapshot[] = [];
  for (const batch of accountBatches) {
    for (const account of batch.accounts) {
      const price = priceForCurrency(account.currency, tickers);
      const quantity = totalQuantity(account);
      snapshots.push({
        walletType: batch.walletType,
        account,
        price,
        totalQuantity: quantity,
        valueTwd: price.price === null ? null : quantity * price.price,
      });
    }
  }
  return snapshots;
}

export function pgliteSnapshotRows(
  syncRunId: string,
  capturedAt: string,
  subAccount: string,
  snapshots: readonly MaicoinAccountSnapshot[],
): PGliteMaicoinSnapshot[] {
  return snapshots.map((snapshot) => ({
    snapshotId: randomUUID(), syncRunId, capturedAt, subAccount,
    walletType: snapshot.walletType,
    currency: snapshot.account.currency.toLowerCase(),
    balance: amount(snapshot.account.balance),
    locked: amount(snapshot.account.locked),
    staked: numeric(snapshot.account.staked),
    principal: numeric(snapshot.account.principal),
    interest: numeric(snapshot.account.interest),
    totalQuantity: snapshot.totalQuantity,
    priceMarket: snapshot.price.market,
    priceCurrency: snapshot.price.currency,
    price: snapshot.price.price,
    valueTwd: snapshot.valueTwd,
    priceAt: snapshot.price.at,
    rawAccountJson: JSON.stringify(snapshot.account),
    rawPriceJson: snapshot.price.raw === null ? null : JSON.stringify(snapshot.price.raw),
  }));
}

export function pgliteStatementRows(
  syncRunId: string,
  capturedAt: string,
  statement: readonly StatementBatch[],
  statementValues: ReadonlyMap<string, number | null>,
): PGliteMaicoinStatementRow[] {
  return statement.flatMap((batch) => batch.rows.map((row) => {
    const statementId = statementIdFor(batch, row);
    return {
      statementId, syncRunId, capturedAt,
      endpoint: batch.endpoint,
      walletType: batch.walletType,
      rowType: batch.rowType,
      externalId: statementExternalId(row),
      occurredAt: isoFromTimestamp(row.created_at),
      currency: stringValue(row.currency),
      amount: numeric(row.amount ?? row.volume ?? row.funds),
      fee: numeric(row.fee),
      feeCurrency: stringValue(row.fee_currency),
      market: stringValue(row.market),
      side: stringValue(row.side),
      price: numeric(row.price),
      valueTwd: statementValues.get(statementId) ?? null,
      rawPayloadJson: JSON.stringify(row),
    };
  }));
}

/** Keep each authenticated socket frame below its 4 MiB transport ceiling. */
export function* maicoinRpcChunks<T>(rows: readonly T[]): Iterable<readonly T[]> {
  let chunk: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > 1_000_000) throw new Error("MaiCoin source row exceeds the PGlite RPC limit.");
    if (chunk.length === 100 || bytes + size > 1_000_000) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length > 0) yield chunk;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
