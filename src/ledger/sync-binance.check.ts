import assert from "node:assert/strict";
import test from "node:test";
import {
  binanceHistoryWindows,
  binanceTwdQuotes,
  boundedTradePairs,
  classifyBinanceResponse,
  collectBinanceSource,
  parseDeposits,
  parseExchangeInfo,
  parseFundingAssets,
  parseTickerPrices,
  parseTransferPage,
  parseWithdrawals,
  signBinanceQuery,
  withoutEarnBalances,
  type BinanceSymbol,
} from "./sync-binance.ts";
import { BINANCE_COLLECTION_PERIODS, BINANCE_QUOTE_ASSETS } from "../lib/automation/server/sources/binance.ts";

const taipei = (date: string, time = "00:00:00.000") => Date.parse(`${date}T${time}+08:00`);
const amount = (coefficient: string, scale = 0) => ({ coefficient, scale });

test("a signed query is the HMAC-SHA256 hex of the exact query string", () => {
  // Binance's published signing example.
  assert.equal(
    signBinanceQuery({
      symbol: "LTCBTC", side: "BUY", type: "LIMIT", timeInForce: "GTC",
      quantity: "1", price: "0.1", recvWindow: "5000", timestamp: "1499827319559",
    }, "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"),
    "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559"
      + "&signature=c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
  );
});

test("each response is read as its JSON body or as the failure it proves", () => {
  const kind = (status: number, text: string) => {
    const result = classifyBinanceResponse(status, text, "/api/v3/account");
    return result.ok ? "ok" : result.error.kind;
  };
  assert.equal(kind(200, '{"balances":[]}'), "ok");
  assert.equal(kind(200, "[]"), "ok", "an empty list is an answer");
  assert.equal(kind(200, "<html>maintenance</html>"), "invalid-response", "a non-JSON 200 is never an empty answer");
  assert.equal(kind(200, ""), "invalid-response");
  for (const code of [-2014, -2015, -1022])
    assert.equal(kind(401, JSON.stringify({ code, msg: "x" })), "credential", `code ${code}`);
  assert.equal(kind(400, JSON.stringify({ code: -2015, msg: "x" })), "credential");
  assert.equal(kind(451, "{}"), "region-blocked");
  assert.equal(kind(403, "<html>CloudFront</html>"), "region-blocked", "a 403 without a Binance code is the edge refusing the region");
  assert.equal(kind(429, JSON.stringify({ code: -1003 })), "unavailable");
  assert.equal(kind(418, JSON.stringify({ code: -1003 })), "unavailable");
  assert.equal(kind(502, "bad gateway"), "unavailable");
  assert.equal(kind(400, JSON.stringify({ code: -1121, msg: "Invalid symbol." })), "rejected");
});

test("the three-month period splits into 90-day fund windows and 30-day transfer windows", () => {
  const now = taipei("2026-10-31", "15:00:00.000");
  assert.deepEqual(binanceHistoryWindows(BINANCE_COLLECTION_PERIODS.fundHistory, "2026-10-31", now), [
    { startTime: taipei("2026-08-03"), endTime: now },
    { startTime: taipei("2026-08-01"), endTime: taipei("2026-08-02", "23:59:59.999") },
  ]);
  const transfers = binanceHistoryWindows(BINANCE_COLLECTION_PERIODS.transfers, "2026-10-31", now);
  assert.deepEqual(transfers.map(({ startTime }) => new Date(startTime).toISOString()), [
    "2026-10-01T16:00:00.000Z",
    "2026-09-01T16:00:00.000Z",
    "2026-08-02T16:00:00.000Z",
    "2026-07-31T16:00:00.000Z",
  ]);
  for (const { startTime, endTime } of transfers) assert.ok(endTime - startTime < 30 * 86_400_000);
  assert.deepEqual(binanceHistoryWindows(BINANCE_COLLECTION_PERIODS.trades, "2026-10-31", now), [
    { startTime: taipei("2026-08-01"), endTime: now },
  ]);
});

const SYMBOLS: readonly BinanceSymbol[] = [
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" },
  { symbol: "ETHBTC", baseAsset: "ETH", quoteAsset: "BTC" },
  { symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT" },
  { symbol: "SOLFDUSD", baseAsset: "SOL", quoteAsset: "FDUSD" },
  { symbol: "SOLTRY", baseAsset: "SOL", quoteAsset: "TRY" },
  { symbol: "USDTTRY", baseAsset: "USDT", quoteAsset: "TRY" },
  { symbol: "DOGEBTC", baseAsset: "DOGE", quoteAsset: "BTC" },
  { symbol: "LDOUSDT", baseAsset: "LDO", quoteAsset: "USDT" },
];

test("trades are requested only for an observed base against a declared quote that exchangeInfo lists", () => {
  const pairs = boundedTradePairs(new Set(["ETH", "SOL", "USDT", "NOTLISTED"]), SYMBOLS, BINANCE_QUOTE_ASSETS);
  assert.deepEqual(pairs.map(({ symbol }) => symbol), ["ETHBTC", "ETHUSDT", "SOLFDUSD"]);
  assert.ok(!pairs.some(({ symbol }) => symbol === "SOLTRY"), "TRY is not a declared quote asset");
  assert.ok(!pairs.some(({ symbol }) => symbol === "BTCUSDT"), "BTC was never observed");
});

test("Simple Earn balances mirrored into spot are left out, and a listed LD asset is kept", () => {
  const listed = new Set(SYMBOLS.flatMap(({ baseAsset, quoteAsset }) => [baseAsset, quoteAsset]));
  const kept = withoutEarnBalances([
    { asset: "LDBTC", quantity: amount("1") },
    { asset: "LDO", quantity: amount("2") },
    { asset: "BTC", quantity: amount("3") },
  ], listed);
  assert.deepEqual(kept.map(({ asset }) => asset), ["LDO", "BTC"]);
});

test("each asset is priced in TWD through USDT directly, inversely or through BTC", () => {
  const prices = new Map([
    ["BTCUSDT", "60000.00"],
    ["ETHBTC", "0.05"],
    ["USDTTRY", "40"],
    ["DOGEBTC", "0.00000000"],
  ]);
  const quotes = binanceTwdQuotes(["USDT", "BTC", "ETH", "TRY", "DOGE", "SOL"], SYMBOLS, prices, "32.5");
  assert.deepEqual(quotes.get("USDT"), { price: amount("325", 1), components: [{ market: "max:usdttwd", price: "32.5" }] });
  assert.deepEqual(quotes.get("BTC")?.price, amount("1950000"));
  assert.deepEqual(quotes.get("ETH"), {
    price: amount("97500"),
    components: [
      { market: "ETHBTC", price: "0.05" },
      { market: "BTCUSDT", price: "60000.00" },
      { market: "max:usdttwd", price: "32.5" },
    ],
  });
  assert.deepEqual(quotes.get("TRY")?.price, amount("8125", 4), "1/40 USDT per TRY");
  assert.equal(quotes.has("DOGE"), false, "a zero price is no price");
  assert.equal(quotes.has("SOL"), false, "an asset without a USDT route stays unvalued");
  assert.equal(binanceTwdQuotes(["BTC"], SYMBOLS, prices, null).size, 0, "without usdttwd every holding stays in its own units");
});

test("history rows become typed movements only when the wallet already holds them", () => {
  assert.deepEqual(parseDeposits([
    { id: "d1", coin: "BTC", amount: "0.5", status: 1, walletType: 0, insertTime: 1_790_000_000_000 },
    { id: "d2", coin: "ETH", amount: "2", status: 6, walletType: 1, insertTime: 1_790_000_000_001 },
    { id: "d3", coin: "ETH", amount: "2", status: 0, walletType: 1, insertTime: 1_790_000_000_002 },
  ]).map(({ id, wallet, amount: value }) => [id, wallet, value]), [
    ["d1", "spot", amount("5", 1)],
    ["d2", "funding", amount("2")],
  ]);
  assert.deepEqual(parseWithdrawals([
    { id: "w1", coin: "USDT", amount: "10.00", status: 6, walletType: 0, applyTime: "2026-09-01 00:00:00", completeTime: "2026-09-01 01:00:00" },
    { id: "w2", coin: "USDT", amount: "10", status: 4, walletType: 0, applyTime: "2026-09-01 00:00:00" },
  ]).map(({ id, time, amount: value }) => [id, new Date(time).toISOString(), value]), [
    ["w1", "2026-09-01T01:00:00.000Z", amount("10")],
  ]);
  assert.throws(() => parseDeposits([{ id: "d", coin: "BTC", amount: 0.5, status: 1, walletType: 0, insertTime: 1 }]), /decimal string/u);
  assert.throws(() => parseDeposits([{ id: "d", coin: "BTC", amount: "1", status: 1, walletType: 2, insertTime: 1 }]), /no supported wallet/u);
  assert.deepEqual(parseTransferPage({ total: 0 }, "MAIN_FUNDING"), { total: 0, pageSize: 0, rows: [] });
  assert.throws(() => parseTransferPage({ total: 3 }, "MAIN_FUNDING"), /not a list/u, "rows may be omitted only for an empty total");
  assert.deepEqual(parseTransferPage({ total: 1, rows: [
    { asset: "USDT", amount: "5", type: "FUNDING_MAIN", status: "CONFIRMED", tranId: 77, timestamp: 1_790_000_000_000 },
  ] }, "FUNDING_MAIN").rows, [{ tranId: "77", from: "funding", to: "spot", asset: "USDT", amount: amount("5"), time: 1_790_000_000_000 }]);
  assert.deepEqual(parseFundingAssets([
    { asset: "USDT", free: "1", locked: "0.5", freeze: "0", withdrawing: "0.25" },
    { asset: "BNB", free: "0", locked: "0", freeze: "0", withdrawing: "0" },
  ]), [{ asset: "USDT", quantity: amount("175", 2) }]);
});

type Call = Readonly<{ method: string; path: string; params: URLSearchParams; apiKey: string | null }>;

function binanceFake(overrides: Readonly<Record<string, (params: URLSearchParams) => Response>> = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { Date: "Sat, 31 Oct 2026 07:00:00 GMT", ...headers } });
  const routes: Record<string, (params: URLSearchParams) => Response> = {
    "/api/v3/time": () => json({ serverTime: Date.parse("2026-10-31T07:00:00.000Z") }),
    "/api/v3/exchangeInfo": () => json({ symbols: SYMBOLS }),
    "/api/v3/account": () => json({ uid: 123456789, balances: [
      { asset: "BTC", free: "0.1", locked: "0" },
      { asset: "LDBTC", free: "1", locked: "0" },
    ] }),
    "/sapi/v1/asset/get-funding-asset": () => json([{ asset: "USDT", free: "100", locked: "0", freeze: "0", withdrawing: "0" }]),
    "/sapi/v1/capital/deposit/hisrec": (params) => json(params.get("offset") === "0" && params.get("startTime") === String(taipei("2026-08-03"))
      ? [{ id: "d1", coin: "ETH", amount: "1", status: 1, walletType: 0, insertTime: taipei("2026-09-01") }]
      : []),
    "/sapi/v1/capital/withdraw/history": () => json([]),
    "/sapi/v1/asset/transfer": () => json({ total: 0 }),
    "/api/v3/myTrades": (params) => json(params.get("symbol") === "BTCUSDT"
      ? [
        { symbol: "BTCUSDT", id: 1, qty: "0.1", quoteQty: "6000", isBuyer: true, time: taipei("2026-07-01") },
        { symbol: "BTCUSDT", id: 2, qty: "0.1", quoteQty: "6000", isBuyer: true, time: taipei("2026-09-01") },
      ]
      : []),
    "/api/v3/ticker/price": () => json([{ symbol: "BTCUSDT", price: "60000" }, { symbol: "ETHUSDT", price: "3000" }]),
    "/api/v3/ticker": () => json({ market: "usdttwd", last: "32" }),
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({ method: init?.method ?? "GET", path: url.pathname, params: url.searchParams, apiKey: new Headers(init?.headers).get("X-MBX-APIKEY") });
    const override = overrides[url.pathname];
    if (override) return override(url.searchParams);
    const route = routes[url.pathname];
    if (!route) throw new Error(`Unexpected endpoint ${url.pathname}`);
    return route(url.searchParams);
  }) as typeof fetch;
  return { calls, fetch: fakeFetch };
}

const collect = (fake: ReturnType<typeof binanceFake>) => collectBinanceSource({ apiKey: "test-key", apiSecret: "test-secret" }, {
  quoteAssets: BINANCE_QUOTE_ASSETS,
  periods: BINANCE_COLLECTION_PERIODS,
  now: () => "2026-10-31T07:00:00.000Z",
  fetch: fake.fetch,
});

test("a collection signs private requests, bounds trades to observed pairs, and values holdings", async () => {
  const fake = binanceFake();
  const source = await collect(fake);
  for (const call of fake.calls.filter(({ path }) => path.startsWith("/sapi") || ["/api/v3/account", "/api/v3/myTrades"].includes(path))) {
    assert.equal(call.apiKey, "test-key", call.path);
    assert.match(call.params.get("signature") ?? "", /^[0-9a-f]{64}$/u, call.path);
    assert.equal(call.params.get("recvWindow"), "10000");
  }
  assert.equal(fake.calls.find(({ path }) => path === "/api/v3/exchangeInfo")?.apiKey, null, "public endpoints carry no key");
  assert.deepEqual(fake.calls.filter(({ path }) => path === "/sapi/v1/capital/deposit/hisrec").length, 2, "one request per 90-day window");
  assert.deepEqual(fake.calls.filter(({ path }) => path === "/sapi/v1/asset/transfer").map(({ params }) => params.get("type")),
    ["MAIN_FUNDING", "MAIN_FUNDING", "MAIN_FUNDING", "MAIN_FUNDING", "FUNDING_MAIN", "FUNDING_MAIN", "FUNDING_MAIN", "FUNDING_MAIN"]);
  assert.deepEqual(fake.calls.filter(({ path }) => path === "/api/v3/myTrades").map(({ params }) => params.get("symbol")),
    ["BTCUSDT", "ETHBTC", "ETHUSDT"], "BTC is held, ETH was deposited, USDT is only a quote");
  assert.equal(source.uid, "123456789");
  assert.deepEqual(source.wallets.map(({ wallet, balances }) => [wallet, balances.map(({ asset }) => asset)]), [["spot", ["BTC"]], ["funding", ["USDT"]]]);
  assert.deepEqual(source.trades.map(({ id }) => id), ["2"], "a fill before the period is not collected");
  assert.deepEqual(source.valuationQuotes.get("BTC")?.price, amount("1920000"));
  assert.deepEqual(source.valuationQuotes.get("USDT")?.price, amount("32"));
});

test("a missing MAX usdttwd leaves holdings unvalued instead of failing the run", async () => {
  const source = await collect(binanceFake({ "/api/v3/ticker": () => new Response(JSON.stringify({ error: { code: 2003 } }), { status: 404 }) }));
  assert.equal(source.valuationQuotes.size, 0);
  assert.equal(source.wallets.length, 2);
});

test("a refused key fails the collection as a credential failure", async () => {
  await assert.rejects(
    collect(binanceFake({ "/api/v3/account": () => new Response(JSON.stringify({ code: -2015, msg: "Invalid API-key" }), { status: 401 }) })),
    (error: unknown) => error instanceof Error && "kind" in error && error.kind === "credential",
  );
  await assert.rejects(
    collect(binanceFake({ "/api/v3/exchangeInfo": () => new Response("{}", { status: 451 }) })),
    (error: unknown) => error instanceof Error && "kind" in error && error.kind === "region-blocked",
  );
});

test("non-Latin tickers Binance lists are read, and a malformed code still fails", () => {
  assert.deepEqual(parseExchangeInfo({ symbols: [
    { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" },
    { symbol: "币安人生USDT", baseAsset: "币安人生", quoteAsset: "USDT" },
  ] }), [
    { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" },
    { symbol: "币安人生USDT", baseAsset: "币安人生", quoteAsset: "USDT" },
  ]);
  assert.equal(parseTickerPrices([{ symbol: "牛来USDT", price: "0.01" }]).get("牛来USDT"), "0.01");
  for (const code of ["btc", "BTC USDT", "BTC/USDT", ""])
    assert.throws(() => parseExchangeInfo({ symbols: [{ symbol: code, baseAsset: "BTC", quoteAsset: "USDT" }] }), /invalid asset code/u, code);
});

test("a pair with more fills than one page reads the older days in 24-hour ranges", async () => {
  const HOUR = 60 * 60 * 1000;
  // Market-wide trade IDs: the person's fills are far apart in ID.
  const fills = Array.from({ length: 1502 }, (_, index) => ({
    symbol: "BTCUSDT",
    id: 4_000_000_000 + index * 9_973,
    qty: "0.001",
    quoteQty: "60",
    isBuyer: index % 2 === 0,
    time: taipei("2026-07-31") + index * HOUR,
  }));
  const ranges: number[] = [];
  const myTrades = (params: URLSearchParams) => {
    const limit = Number(params.get("limit"));
    const page = (rows: typeof fills) => new Response(JSON.stringify(rows), { status: 200, headers: { Date: "Sat, 31 Oct 2026 07:00:00 GMT" } });
    if (params.get("symbol") !== "BTCUSDT") return page([]);
    const start = params.get("startTime");
    const end = params.get("endTime");
    if (start === null && end === null) return page(fills.slice(-limit));
    // Binance: a range is at most 24 hours, and startTime alone means the next 24 hours.
    const from = Number(start);
    const to = end === null ? from + 24 * HOUR : Number(end);
    ranges.push(to - from);
    if (to - from > 24 * HOUR)
      return new Response(JSON.stringify({ code: -1127, msg: "More than 24 hours between startTime and endTime." }), { status: 400 });
    return page(fills.filter(({ time }) => time >= from && time <= to).slice(0, limit));
  };
  const source = await collect(binanceFake({ "/api/v3/myTrades": myTrades }));
  const inPeriod = fills.filter(({ time }) => time >= taipei("2026-08-01"));
  assert.equal(source.trades.length, inPeriod.length, "every fill in the period is collected, none twice");
  assert.deepEqual(new Set(source.trades.map(({ id }) => id)), new Set(inPeriod.map(({ id }) => String(id))));
  assert.ok(ranges.every((range) => range < 24 * 60 * 60 * 1000), "no range request exceeds 24 hours");
});
