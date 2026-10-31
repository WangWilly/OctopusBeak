# Binance declares a bounded trade history

Status: accepted

Builds on the MaiCoin Verified source (issue #138), [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md) and [ADR 0077](0077-a-verified-product-declares-its-collection-period.md). The read-only-key and wallet facts were learned from the MIT-licensed [all-set-tw](https://github.com/TedLin1993/all-set-tw) `binance` connector, which collects holdings only; no code is copied from it.

Binance becomes a Verified source shaped like MaiCoin: `NONBROWSER`, a read-only API key and secret signed with HMAC-SHA256, Institution `binance`. Unlike MAX, Binance's `myTrades` answers only for one named trading pair, so no request can prove that every trade was collected. **The Binance source therefore declares a [Bounded trade history](../../CONTEXT.md): it collects trades only for the pairs formed by every observed asset and a fixed list of quote assets, and its contract never claims the trade history is complete.**

- **Observed assets** are the assets in the current spot and funding snapshots plus every asset in the collected deposit, withdrawal and internal-transfer history. The quote assets are a constant in the source definition (USDT, FDUSD, USDC, BTC, BNB, ETH at first). Only pairs that exist in `exchangeInfo` are queried.
- **Accounts.** Spot and funding are two Crypto financial accounts, because each has its own balance and history. Earn, futures, margin and other wallets are out of scope for now; their balances are not reported rather than folded into spot.
- **Collection period.** Trades, deposits and withdrawals look back two years, so an account that trades rarely still shows its history. Internal transfers (`MAIN_FUNDING`, `FUNDING_MAIN`) look back six months, because Binance refuses an older range with -5026. Deposit and withdrawal history is requested in windows of at most 90 days, internal transfers in windows of at most 30 days, and each internal transfer is one movement between the two accounts. Trades are read from the newest page; only a pair with more fills than one page holds is read further back in 24-hour ranges, which over two years can take several minutes of Binance's request weight for that pair.
- **Holdings stay complete.** The spot and funding snapshots are complete Holding observations; only the trade history is bounded. A balance change the bounded trades cannot explain is expected and is not an admission error.
- **Valuation.** Each asset is priced in USDT from Binance's own ticker (direct pair, inverse pair, or through BTC), then converted with MAX's public `usdttwd`. When `usdttwd` is unavailable, the holdings stay in their own units and Net position falls back to per-currency, instead of failing the run.
- **Live verification** uses the project owner's own Binance account, recorded in `docs/research/` before the source merges.

## Considered options

- **Query every listed pair.** Rejected: over a thousand signed requests per run against Binance's request-weight limits.
- **Ask the person which pairs they trade.** Rejected: a forgotten pair would silently hide trades, and the person cannot see which pairs the source missed.
- **Holdings only, as all-set-tw does.** Rejected: the project owner wants trades, deposits and withdrawals like MAX.

## Consequences

- A trade in a pair whose base asset was never held during the window and never deposited, withdrawn or transferred, or whose quote asset is not in the list, is missed. Adding a quote asset is a source-definition change.
- Convert (閃兌) history, Earn interest and other wallets are separate later additions, each with its own endpoints and actions.
