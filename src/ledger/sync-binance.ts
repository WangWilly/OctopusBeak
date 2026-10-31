import { createHmac } from "node:crypto";
import {
  addExact,
  divideExact,
  multiplyExact,
  normalizeExact,
  type ExactAmount,
} from "../lib/shared-money/exact-money.ts";
import {
  collectionPeriod,
  taipeiToday,
  type CollectionPeriodDeclaration,
} from "../lib/automation/collection-period.ts";
import { parseExactDecimalLexeme } from "./canonical/exact-decimal-lexeme.ts";
import type {
  BinanceBalance,
  BinanceFundMovement,
  BinancePriceComponent,
  BinanceProviderDate,
  BinanceTrade,
  BinanceTransfer,
  BinanceTwdQuote,
  BinanceWallet,
  BinanceWalletSnapshot,
} from "./canonical/binance-crypto-adapters.ts";

const API_BASE_URL = "https://api.binance.com";
const MAX_API_BASE_URL = "https://max-api.maicoin.com";
const RECV_WINDOW_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1_000, 2_000];
const HISTORY_PAGE_LIMIT = 1000;
const TRANSFER_PAGE_SIZE = 100;

export type BinanceCredentials = Readonly<{ apiKey: string; apiSecret: string }>;

/**
 * Why a Binance request failed, as the workflow names it to the person. A
 * response is classified once, here, and never read as an empty answer.
 */
export type BinanceFailureKind =
  | "credential"
  | "region-blocked"
  | "unavailable"
  | "invalid-response"
  | "rejected";

export class BinanceSourceError extends Error {
  readonly kind: BinanceFailureKind;

  constructor(kind: BinanceFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BinanceSourceError";
    this.kind = kind;
  }
}

/** -2014 bad key format, -2015 invalid key, IP or permission, -1022 invalid signature. */
const CREDENTIAL_ERROR_CODES: ReadonlySet<number> = new Set([-2014, -2015, -1022]);

type Classified = Readonly<{ ok: true; body: unknown }> | Readonly<{ ok: false; error: BinanceSourceError }>;

/** Turns one HTTP answer into its JSON body or the failure it proves. */
export function classifyBinanceResponse(status: number, text: string, path: string): Classified {
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  const code = body && typeof body === "object" && "code" in body && typeof (body as { code: unknown }).code === "number"
    ? (body as { code: number }).code
    : undefined;
  const fail = (kind: BinanceFailureKind) =>
    ({ ok: false, error: new BinanceSourceError(kind, `Binance ${path} failed with HTTP ${status}${code === undefined ? "" : ` code ${code}`}.`) }) as const;
  if (status >= 200 && status < 300)
    return body === undefined ? fail("invalid-response") : { ok: true, body };
  if (status === 451 || (status === 403 && code === undefined)) return fail("region-blocked");
  if (code !== undefined && CREDENTIAL_ERROR_CODES.has(code)) return fail("credential");
  if (status === 401) return fail("credential");
  if (status === 418 || status === 429 || status >= 500) return fail("unavailable");
  return fail("rejected");
}

/** HMAC-SHA256 hex over the exact query string, appended as `signature`. */
export function signBinanceQuery(params: Readonly<Record<string, string>>, apiSecret: string): string {
  const query = new URLSearchParams(params).toString();
  return `${query}&signature=${createHmac("sha256", apiSecret).update(query).digest("hex")}`;
}

type BinanceResponse = Readonly<{ body: unknown; providerDate: string | null }>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryAfterMs(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60_000) : fallback;
}

/** Sends one request at a time, so a run never spends request weight in parallel. */
export class BinanceClient {
  #clockOffsetMs = 0;
  readonly #credentials: BinanceCredentials;
  readonly #signal?: AbortSignal;
  readonly #fetch: typeof fetch;

  constructor(credentials: BinanceCredentials, signal?: AbortSignal, fetchImpl: typeof fetch = fetch) {
    this.#credentials = credentials;
    this.#signal = signal;
    this.#fetch = fetchImpl;
  }

  /** Signed requests carry Binance's clock, so a skewed machine is not refused with -1021. */
  async syncClock(): Promise<void> {
    const { body } = await this.#request("GET", API_BASE_URL, "/api/v3/time", "", {});
    const serverTime = record(body, "server time").serverTime;
    if (typeof serverTime !== "number" || !Number.isSafeInteger(serverTime))
      throw invalid("Binance server time is not an instant.");
    this.#clockOffsetMs = serverTime - Date.now();
  }

  now(): number {
    return Date.now() + this.#clockOffsetMs;
  }

  publicGet(path: string, params: Readonly<Record<string, string>> = {}): Promise<BinanceResponse> {
    return this.#request("GET", API_BASE_URL, path, new URLSearchParams(params).toString(), {});
  }

  signed(method: "GET" | "POST", path: string, params: Readonly<Record<string, string>> = {}): Promise<BinanceResponse> {
    return this.#request(method, API_BASE_URL, path, () => signBinanceQuery({
      ...params,
      recvWindow: String(RECV_WINDOW_MS),
      timestamp: String(this.now()),
    }, this.#credentials.apiSecret), { "X-MBX-APIKEY": this.#credentials.apiKey });
  }

  maxPublicGet(path: string, params: Readonly<Record<string, string>>): Promise<BinanceResponse> {
    return this.#request("GET", MAX_API_BASE_URL, path, new URLSearchParams(params).toString(), {});
  }

  async #request(
    method: "GET" | "POST",
    base: string,
    path: string,
    query: string | (() => string),
    headers: Readonly<Record<string, string>>,
  ): Promise<BinanceResponse> {
    for (let attempt = 0; ; attempt += 1) {
      this.#signal?.throwIfAborted();
      const search = typeof query === "function" ? query() : query;
      let response: Response;
      try {
        response = await this.#fetch(`${base}${path}${search ? `?${search}` : ""}`, {
          method,
          headers: { Accept: "application/json", ...headers },
          signal: this.#signal
            ? AbortSignal.any([this.#signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
            : AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        this.#signal?.throwIfAborted();
        if (attempt >= RETRY_DELAYS_MS.length)
          throw new BinanceSourceError("unavailable", `Binance ${path} could not be reached.`, { cause: error });
        await sleep(RETRY_DELAYS_MS[attempt]!, this.#signal);
        continue;
      }
      const classified = classifyBinanceResponse(response.status, await response.text(), path);
      if (classified.ok) return { body: classified.body, providerDate: response.headers.get("date") };
      // 418 is an IP ban; retrying it only lengthens the ban.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw classified.error;
      await sleep(retryAfterMs(response, RETRY_DELAYS_MS[attempt]!), this.#signal);
    }
  }
}

// Boundary parsers: every provider value becomes a typed model here or fails
// the run as an invalid response.

function invalid(message: string): BinanceSourceError {
  return new BinanceSourceError("invalid-response", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`Binance ${label} is not an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(`Binance ${label} is not a list.`);
  return value;
}

/** Binance lists non-Latin tickers such as `币安人生`, so a code is any run of uppercase or uncased letters and digits. */
function asset(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[\p{Lu}\p{Lo}\p{Nd}]{1,20}$/u.test(value)) throw invalid(`Binance ${label} has an invalid asset code.`);
  return value;
}

/** A non-negative decimal string, never a JSON number whose digits are already lost. */
function decimal(value: unknown, label: string): ExactAmount {
  if (typeof value !== "string") throw invalid(`Binance ${label} is not a decimal string.`);
  let parsed;
  try {
    parsed = parseExactDecimalLexeme(value);
  } catch {
    throw invalid(`Binance ${label} is not a decimal string.`);
  }
  if (parsed.coefficient < 0n) throw invalid(`Binance ${label} is negative.`);
  return normalizeExact({ coefficient: parsed.coefficient.toString(), scale: parsed.scale });
}

function identifier(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/u.test(value)) return value;
  throw invalid(`Binance ${label} has no usable ID.`);
}

function instant(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw invalid(`Binance ${label} has no valid time.`);
}

/** Withdrawal times are UTC text such as `2026-08-01 12:00:00`. */
function utcText(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) throw invalid(`Binance ${label} has no valid time.`);
  const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed)) throw invalid(`Binance ${label} has no valid time.`);
  return parsed;
}

export function parseBinanceProviderDate(value: string | null): BinanceProviderDate {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  if (value === null || !Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value.trim())
    throw invalid("Binance wallet response has no valid HTTP Date; the local clock cannot stand in for it.");
  return { sourceValue: value.trim(), effectiveAt: new Date(parsed).toISOString() };
}

export type BinanceSymbol = Readonly<{ symbol: string; baseAsset: string; quoteAsset: string }>;

export function parseExchangeInfo(body: unknown): readonly BinanceSymbol[] {
  return array(record(body, "exchange information").symbols, "exchange symbols").map((value) => {
    const row = record(value, "exchange symbol");
    const symbol = asset(row.symbol, "exchange symbol");
    return { symbol, baseAsset: asset(row.baseAsset, `${symbol} base`), quoteAsset: asset(row.quoteAsset, `${symbol} quote`) };
  });
}

function balances(rows: readonly unknown[], label: string, parts: readonly string[]): BinanceBalance[] {
  return rows.map((value) => {
    const row = record(value, label);
    const code = asset(row.asset, label);
    const quantity = parts.reduce<ExactAmount>(
      (sum, part) => addExact(sum, decimal(row[part] ?? "0", `${code} ${part}`)),
      { coefficient: "0", scale: 0 },
    );
    return { asset: code, quantity };
  }).filter(({ quantity }) => quantity.coefficient !== "0");
}

export function parseSpotAccount(body: unknown): Readonly<{ uid: string; balances: readonly BinanceBalance[] }> {
  const account = record(body, "spot account");
  if (typeof account.uid !== "number" || !Number.isSafeInteger(account.uid) || account.uid <= 0)
    throw invalid("Binance spot account has no UID.");
  return { uid: String(account.uid), balances: balances(array(account.balances, "spot balances"), "spot balance", ["free", "locked"]) };
}

export function parseFundingAssets(body: unknown): readonly BinanceBalance[] {
  return balances(array(body, "funding assets"), "funding asset", ["free", "locked", "freeze", "withdrawing"]);
}

/**
 * Simple Earn shows its positions in the spot account as `LD` plus the asset.
 * Earn is out of scope (ADR 0084), so such a balance is not reported. A
 * listed asset that merely starts with LD, such as LDO, is kept.
 */
export function withoutEarnBalances(rows: readonly BinanceBalance[], listedAssets: ReadonlySet<string>): BinanceBalance[] {
  return rows.filter(({ asset: code }) =>
    !(code.startsWith("LD") && !listedAssets.has(code) && listedAssets.has(code.slice(2))));
}

const WALLET_TYPES: Readonly<Record<number, BinanceWallet>> = { 0: "spot", 1: "funding" };

function wallet(value: unknown, label: string): BinanceWallet {
  const result = typeof value === "number" ? WALLET_TYPES[value] : undefined;
  if (!result) throw invalid(`Binance ${label} names no supported wallet.`);
  return result;
}

/** Deposit statuses whose amount is already in the wallet: 1 success, 6 credited but locked. */
const CREDITED_DEPOSIT_STATUSES: ReadonlySet<number> = new Set([1, 6]);
const COMPLETED_WITHDRAWAL_STATUS = 6;

export function parseDeposits(body: unknown): readonly BinanceFundMovement[] {
  return array(body, "deposit history").flatMap((value) => {
    const row = record(value, "deposit");
    if (!CREDITED_DEPOSIT_STATUSES.has(row.status as number)) return [];
    return [{
      kind: "deposit" as const,
      id: identifier(row.id, "deposit"),
      wallet: wallet(row.walletType, "deposit"),
      asset: asset(row.coin, "deposit"),
      amount: decimal(row.amount, "deposit amount"),
      time: instant(row.insertTime, "deposit"),
    }];
  });
}

export function parseWithdrawals(body: unknown): readonly BinanceFundMovement[] {
  return array(body, "withdrawal history").flatMap((value) => {
    const row = record(value, "withdrawal");
    if (row.status !== COMPLETED_WITHDRAWAL_STATUS) return [];
    return [{
      kind: "withdrawal" as const,
      id: identifier(row.id, "withdrawal"),
      wallet: wallet(row.walletType, "withdrawal"),
      asset: asset(row.coin, "withdrawal"),
      amount: decimal(row.amount, "withdrawal amount"),
      time: utcText(row.completeTime ?? row.applyTime, "withdrawal"),
    }];
  });
}

export const BINANCE_TRANSFER_TYPES = {
  MAIN_FUNDING: { from: "spot", to: "funding" },
  FUNDING_MAIN: { from: "funding", to: "spot" },
} as const satisfies Readonly<Record<string, Readonly<{ from: BinanceWallet; to: BinanceWallet }>>>;

export type BinanceTransferType = keyof typeof BINANCE_TRANSFER_TYPES;

export function parseTransferPage(
  body: unknown,
  type: BinanceTransferType,
): Readonly<{ total: number; rows: readonly BinanceTransfer[]; pageSize: number }> {
  const page = record(body, "transfer history");
  const total = page.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw invalid("Binance transfer history has no total.");
  // An empty page may omit its rows, but only when the total says so.
  const rows = page.rows === undefined && total === 0 ? [] : array(page.rows, "transfer rows");
  return {
    total,
    pageSize: rows.length,
    rows: rows.flatMap((value) => {
      const row = record(value, "transfer");
      if (row.type !== type) throw invalid("Binance transfer history answered another transfer type.");
      if (row.status !== "CONFIRMED") return [];
      return [{
        tranId: identifier(row.tranId, "transfer"),
        ...BINANCE_TRANSFER_TYPES[type],
        asset: asset(row.asset, "transfer"),
        amount: decimal(row.amount, "transfer amount"),
        time: instant(row.timestamp, "transfer"),
      }];
    }),
  };
}

export function parseTrades(body: unknown, pair: BinanceSymbol): readonly BinanceTrade[] {
  return array(body, `${pair.symbol} trades`).map((value) => {
    const row = record(value, `${pair.symbol} trade`);
    if (row.symbol !== pair.symbol) throw invalid("Binance trade history answered another pair.");
    if (typeof row.isBuyer !== "boolean") throw invalid(`Binance ${pair.symbol} trade has no side.`);
    return {
      symbol: pair.symbol,
      id: identifier(row.id, `${pair.symbol} trade`),
      baseAsset: pair.baseAsset,
      quoteAsset: pair.quoteAsset,
      side: row.isBuyer ? "buy" : "sell",
      quantity: decimal(row.qty, `${pair.symbol} trade quantity`),
      quoteQuantity: decimal(row.quoteQty, `${pair.symbol} trade quote quantity`),
      time: instant(row.time, `${pair.symbol} trade`),
    } satisfies BinanceTrade;
  });
}

/** Every listed price, kept as the lexeme Binance sent. */
export function parseTickerPrices(body: unknown): ReadonlyMap<string, string> {
  const prices = new Map<string, string>();
  for (const value of array(body, "ticker prices")) {
    const row = record(value, "ticker price");
    const symbol = asset(row.symbol, "ticker");
    decimal(row.price, `${symbol} price`);
    prices.set(symbol, row.price as string);
  }
  return prices;
}

// Collection period, pairs and pricing.

export type BinanceHistoryWindow = Readonly<{ startTime: number; endTime: number }>;

/**
 * The run's Collection period (ADR 0077) as Binance millisecond windows. Each
 * window spans whole Taipei days and never ends after `nowMs`.
 */
export function binanceHistoryWindows(
  declaration: CollectionPeriodDeclaration,
  today: string,
  nowMs: number,
): readonly BinanceHistoryWindow[] {
  return collectionPeriod({ today, ...declaration }).windows.map(({ start, end }) => ({
    startTime: Date.parse(`${start}T00:00:00.000+08:00`),
    endTime: Math.min(Date.parse(`${end}T23:59:59.999+08:00`), nowMs),
  }));
}

/**
 * ADR 0084: the pairs whose trades are requested, each an observed base
 * asset against a declared quote asset, as listed in exchangeInfo.
 */
export function boundedTradePairs(
  observedAssets: ReadonlySet<string>,
  symbols: readonly BinanceSymbol[],
  quoteAssets: readonly string[],
): readonly BinanceSymbol[] {
  return symbols
    .filter(({ baseAsset, quoteAsset }) => observedAssets.has(baseAsset) && quoteAssets.includes(quoteAsset))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

type UsdtPrice = Readonly<{ price: ExactAmount; components: readonly BinancePriceComponent[] }>;

type PriceBook = Readonly<{
  bySides: ReadonlyMap<string, string>;
  prices: ReadonlyMap<string, string>;
}>;

function listed(book: PriceBook, base: string, quote: string): BinancePriceComponent | null {
  const symbol = book.bySides.get(`${base}/${quote}`);
  const price = symbol === undefined ? undefined : book.prices.get(symbol);
  return symbol === undefined || price === undefined || decimal(price, symbol).coefficient === "0" ? null : { market: symbol, price };
}

const amountOf = (component: BinancePriceComponent): ExactAmount => decimal(component.price, component.market);

/** Each way to reach USDT, tried in order: the asset itself, direct, inverse, then through BTC. */
const USDT_ROUTES: readonly ((asset: string, book: PriceBook) => UsdtPrice | null)[] = [
  (code) => code === "USDT" ? { price: { coefficient: "1", scale: 0 }, components: [] } : null,
  (code, book) => {
    const direct = listed(book, code, "USDT");
    return direct && { price: amountOf(direct), components: [direct] };
  },
  (code, book) => {
    const inverse = listed(book, "USDT", code);
    const price = inverse && divideExact({ coefficient: "1", scale: 0 }, amountOf(inverse));
    return inverse && price && { price, components: [inverse] };
  },
  (code, book) => {
    const viaBtc = listed(book, code, "BTC");
    const btc = listed(book, "BTC", "USDT");
    return viaBtc && btc && { price: multiplyExact(amountOf(viaBtc), amountOf(btc)), components: [viaBtc, btc] };
  },
];

/**
 * Each asset's TWD price: its USDT price from Binance times MAX's public
 * `usdttwd`. Without `usdttwd`, or without a USDT route, the asset gets no
 * quote and its holding stays unvalued in its own units.
 */
export function binanceTwdQuotes(
  assets: Iterable<string>,
  symbols: readonly BinanceSymbol[],
  prices: ReadonlyMap<string, string>,
  usdtTwd: string | null,
): ReadonlyMap<string, BinanceTwdQuote> {
  const quotes = new Map<string, BinanceTwdQuote>();
  if (usdtTwd === null) return quotes;
  const book: PriceBook = {
    bySides: new Map(symbols.map(({ symbol, baseAsset, quoteAsset }) => [`${baseAsset}/${quoteAsset}`, symbol])),
    prices,
  };
  const usdtTwdComponent = { market: "max:usdttwd", price: usdtTwd };
  for (const code of assets) {
    const usdt = USDT_ROUTES.reduce<UsdtPrice | null>((found, route) => found ?? route(code, book), null);
    if (usdt) quotes.set(code, {
      price: multiplyExact(usdt.price, decimal(usdtTwd, "MAX usdttwd")),
      components: [...usdt.components, usdtTwdComponent],
    });
  }
  return quotes;
}

// Collection.

export type BinanceSourceCollection = Readonly<{
  uid: string;
  wallets: readonly BinanceWalletSnapshot[];
  trades: readonly BinanceTrade[];
  fundMovements: readonly BinanceFundMovement[];
  transfers: readonly BinanceTransfer[];
  valuationQuotes: ReadonlyMap<string, BinanceTwdQuote>;
  pairCount: number;
}>;

export type BinanceCollectionOptions = Readonly<{
  quoteAssets: readonly string[];
  periods: Readonly<Record<"trades" | "fundHistory" | "transfers", CollectionPeriodDeclaration>>;
  /** The run's clock; it decides the Taipei date the periods end on. */
  now(): string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onWalletsCollected?(count: number): void | Promise<void>;
  onHistoryCollected?(count: number): void | Promise<void>;
}>;

/** One row per provider ID; a repeated ID must repeat the same row. */
function unique<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Map<string, string>();
  const result: T[] = [];
  for (const row of rows) {
    const id = key(row);
    const payload = JSON.stringify(row);
    const previous = seen.get(id);
    if (previous === undefined) {
      seen.set(id, payload);
      result.push(row);
    } else if (previous !== payload) {
      throw invalid("Binance history returned two different rows for one ID.");
    }
  }
  return result;
}

async function offsetPages<T>(
  windows: readonly BinanceHistoryWindow[],
  fetchPage: (window: BinanceHistoryWindow, offset: number) => Promise<Readonly<{ size: number; rows: readonly T[] }>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const window of windows) {
    for (let offset = 0; ; offset += HISTORY_PAGE_LIMIT) {
      const page = await fetchPage(window, offset);
      rows.push(...page.rows);
      if (page.size < HISTORY_PAGE_LIMIT) break;
    }
  }
  return rows;
}

async function transferHistory(
  client: BinanceClient,
  type: BinanceTransferType,
  windows: readonly BinanceHistoryWindow[],
): Promise<BinanceTransfer[]> {
  const rows: BinanceTransfer[] = [];
  for (const window of windows) {
    let seen = 0;
    for (let current = 1; ; current += 1) {
      const page = parseTransferPage((await client.signed("GET", "/sapi/v1/asset/transfer", {
        type,
        startTime: String(window.startTime),
        endTime: String(window.endTime),
        current: String(current),
        size: String(TRANSFER_PAGE_SIZE),
      })).body, type);
      rows.push(...page.rows);
      seen += page.pageSize;
      if (page.pageSize < TRANSFER_PAGE_SIZE || seen >= page.total) break;
    }
  }
  return rows;
}

async function pairTrades(client: BinanceClient, pair: BinanceSymbol, startTime: number): Promise<BinanceTrade[]> {
  const rows: BinanceTrade[] = [];
  let cursor: Readonly<Record<string, string>> = { startTime: String(startTime) };
  for (;;) {
    const page = parseTrades((await client.signed("GET", "/api/v3/myTrades", {
      symbol: pair.symbol,
      limit: String(HISTORY_PAGE_LIMIT),
      ...cursor,
    })).body, pair);
    rows.push(...page);
    if (page.length < HISTORY_PAGE_LIMIT) break;
    const lastId = page.reduce((highest, trade) => Math.max(highest, Number(trade.id)), 0);
    cursor = { fromId: String(lastId + 1) };
  }
  // A startTime request may still answer older fills; the period decides.
  return rows.filter((trade) => trade.time >= startTime);
}

async function maxUsdtTwd(client: BinanceClient, signal?: AbortSignal): Promise<string | null> {
  try {
    const last = record((await client.maxPublicGet("/api/v3/ticker", { market: "usdttwd" })).body, "MAX ticker").last;
    return decimal(last, "MAX usdttwd").coefficient === "0" ? null : last as string;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BinanceSourceError) return null;
    throw error;
  }
}

/** Collect every Binance value of one run in memory before anything is committed. */
export async function collectBinanceSource(
  credentials: BinanceCredentials,
  options: BinanceCollectionOptions,
): Promise<BinanceSourceCollection> {
  const client = new BinanceClient(credentials, options.signal, options.fetch);
  await client.syncClock();
  const today = taipeiToday(options.now());

  const symbols = parseExchangeInfo((await client.publicGet("/api/v3/exchangeInfo")).body);
  const listedAssets = new Set(symbols.flatMap(({ baseAsset, quoteAsset }) => [baseAsset, quoteAsset]));
  const spotResponse = await client.signed("GET", "/api/v3/account", { omitZeroBalances: "true" });
  const spot = parseSpotAccount(spotResponse.body);
  const fundingResponse = await client.signed("POST", "/sapi/v1/asset/get-funding-asset");
  const wallets: BinanceWalletSnapshot[] = [
    {
      wallet: "spot",
      providerDate: parseBinanceProviderDate(spotResponse.providerDate),
      balances: withoutEarnBalances(spot.balances, listedAssets),
    },
    {
      wallet: "funding",
      providerDate: parseBinanceProviderDate(fundingResponse.providerDate),
      balances: parseFundingAssets(fundingResponse.body),
    },
  ];
  await options.onWalletsCollected?.(wallets.length);

  const fundWindows = binanceHistoryWindows(options.periods.fundHistory, today, client.now());
  const history = (endpoint: string, parse: (body: unknown) => readonly BinanceFundMovement[]) =>
    async ({ startTime, endTime }: BinanceHistoryWindow, offset: number) => {
      const { body } = await client.signed("GET", endpoint, {
        startTime: String(startTime),
        endTime: String(endTime),
        offset: String(offset),
        limit: String(HISTORY_PAGE_LIMIT),
      });
      return { size: array(body, endpoint).length, rows: parse(body) };
    };
  const fundMovements = unique([
    ...await offsetPages(fundWindows, history("/sapi/v1/capital/deposit/hisrec", parseDeposits)),
    ...await offsetPages(fundWindows, history("/sapi/v1/capital/withdraw/history", parseWithdrawals)),
  ], ({ kind, id }) => `${kind}:${id}`);
  const transferWindows = binanceHistoryWindows(options.periods.transfers, today, client.now());
  const transfers: BinanceTransfer[] = [];
  for (const type of Object.keys(BINANCE_TRANSFER_TYPES) as BinanceTransferType[])
    transfers.push(...await transferHistory(client, type, transferWindows));

  const observed = new Set([
    ...wallets.flatMap(({ balances: rows }) => rows.map(({ asset: code }) => code)),
    ...fundMovements.map(({ asset: code }) => code),
    ...transfers.map(({ asset: code }) => code),
  ]);
  const pairs = boundedTradePairs(observed, symbols, options.quoteAssets);
  const [tradeWindow] = binanceHistoryWindows(options.periods.trades, today, client.now());
  const trades: BinanceTrade[] = [];
  for (const pair of pairs) trades.push(...await pairTrades(client, pair, tradeWindow!.startTime));

  const prices = parseTickerPrices((await client.publicGet("/api/v3/ticker/price")).body);
  const valuationQuotes = binanceTwdQuotes(
    new Set(wallets.flatMap(({ balances: rows }) => rows.map(({ asset: code }) => code))),
    symbols,
    prices,
    await maxUsdtTwd(client, options.signal),
  );
  const uniqueTrades = unique(trades, ({ symbol, id }) => `${symbol}:${id}`);
  const uniqueTransfers = unique(transfers, ({ tranId }) => tranId);
  await options.onHistoryCollected?.(uniqueTrades.length + fundMovements.length + uniqueTransfers.length);
  return {
    uid: spot.uid,
    wallets,
    trades: uniqueTrades,
    fundMovements,
    transfers: uniqueTransfers,
    valuationQuotes,
    pairCount: pairs.length,
  };
}
