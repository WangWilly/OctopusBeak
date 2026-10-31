# Binance live probe

Status: Accepted in part on 2026-10-31. The owner's live run passed the items marked below; the owner chose to merge with the unverified items left open. See [Results](#results).

[ADR 0084](../adr/0084-binance-declares-bounded-trade-history.md) requires the project owner to verify the Binance source with their own account before it merges. The source was built from Binance's public Spot API documentation and synthetic fixtures. This checklist names the facts the code assumes and how to confirm each one. Record each result in this file and change the status to Accepted when every item passes.

## Setup

1. In Binance API Management, create a system-generated key with only **Enable Reading**.
2. Export the key in a shell. Do not write it to a file in the repository.

   ```sh
   export LIBRETTO_CLOUD_BINANCE_API_KEY=...
   export LIBRETTO_CLOUD_BINANCE_API_SECRET=...
   ```

3. Run the workflow with a dry-run commit. It writes nothing to the database.

   ```sh
   npm run workflow:dev -- run-app sync-binance --allow-live-source
   ```

4. Then run **Binance sync** once in the desktop App and open Overview.

## Checklist

Record pass, fail, or the observed value for each item. Do not paste keys, UIDs, balances, or transaction IDs.

- [ ] **Sign-in.** The run completes. A wrong secret fails as `authentication-failed` (codes -2014, -2015 or -1022).
- [x] **Region.** From the owner's network, no request answers HTTP 451 or a 403 without a Binance code. If one does, the run fails as `source-access-challenged`.
- [x] **UID.** `GET /api/v3/account` returns a numeric `uid`. The source connection depends on it.
- [x] **HTTP Date.** The account and `get-funding-asset` responses carry a `Date` header. Holdings use it as their as-of time.
- [ ] **Spot inventory.** Spot holdings in the App match the Binance spot wallet. `LD`-prefixed Simple Earn balances are absent, and a listed asset such as `LDO` is still shown.
- [ ] **Funding inventory.** Funding holdings match the funding wallet, counting `free + locked + freeze + withdrawing`.
- [x] **Deposit wallet.** Each deposit and withdrawal row has `walletType` 0 (spot) or 1 (funding), and the movement appears on that account.
- [ ] **Deposit and withdrawal status.** Only deposits with status 1 or 6 and withdrawals with status 6 appear. Note whether a pending withdrawal has already left the balance.
- [ ] **Withdrawal amount.** Compare one completed withdrawal's `amount` and `transactionFee` with the balance change. The source records `amount` only, as MaiCoin does.
- [x] **Windows.** Deposit and withdrawal requests accept 90-day windows, and `/sapi/v1/asset/transfer` accepts 30-day windows, with no -1127 or -1131 error.
- [ ] **Transfers.** A spot-to-funding transfer appears once as an outflow on spot and an inflow on funding, with the same date.
- [ ] **Trade paging.** `myTrades` with only `symbol` returns the newest fills. When a pair has 1000 fills in the newest page, the source reads the older days of the period in `startTime`/`endTime` ranges of at most 24 hours. A pair with more than 1000 fills in the period confirms the paging.
- [ ] **Bounded pairs.** Note how many pairs the run requested and whether any trade the owner remembers is missing. A missing trade in a pair outside "observed asset × USDT, FDUSD, USDC, BTC, BNB, ETH" is expected (ADR 0084).
- [ ] **Commission.** For one trade whose commission is in BNB, confirm the trade's quantity and quote amount. The commission is not recorded, as MaiCoin's fee is not.
- [ ] **Request weight.** Note the largest `X-MBX-USED-WEIGHT-1M` seen during the run. It should stay well under 6000.
- [ ] **Valuation.** Holdings are valued in TWD through the Binance USDT price and MAX `usdttwd`. With MAX blocked, for example by a firewall rule, the run still completes and Overview shows each crypto holding in its own units.
- [ ] **Recapture.** A second run adds no investment transaction.

## Results

Recorded on 2026-10-31 from the owner's account, through **Binance sync** in the desktop App (not the dry run). No key, UID, balance or ID is recorded here.

- **First run failed** with `source-validation-failed` while collecting wallets. Binance lists non-Latin tickers such as `币安人生USDT` and `牛来USDT`, which the ASCII-only asset-code pattern refused. Fixed by accepting uppercase and uncased letters and digits; both live `exchangeInfo` and `ticker/price` (about 3,740 symbols each) then parsed.
- **Sign-in:** pass. The run completed with the read-only key. A wrong secret was not tried.
- **Region:** pass. No request answered 451 or an uncoded 403 from the owner's network.
- **UID** and **HTTP Date:** pass. Both were present; the run would have failed without them.
- **Spot and funding:** two Crypto financial accounts were created. Spot was valued in TWD. An empty funding wallet, after the overview fix in this PR, shows zero instead of "no balance collected yet". The owner did not compare holdings line by line with the Binance wallets, and no `LD` or `LDO` balance was present.
- **Windows:** pass. The 90-day deposit and withdrawal windows and the 30-day transfer windows were accepted without -1127 or -1131.
- **History (3 months, the original period):** no fills, deposits, withdrawals or transfers.
- **History (2 years, one-off run):** with the look-back widened locally for one run (not committed), deposit and withdrawal history over two years returned both deposits and withdrawals, all on the spot account, so `walletType` 0 maps to spot. There were no fills, so trade paging, bounded pairs and commission remain unverified.
- **Transfer history limit:** `/sapi/v1/asset/transfer` refused a range older than about six months with HTTP 400 code -5026, reported as `source-collection-failed`. After this run the owner set the period to two years for trades, deposits and withdrawals and six months for transfers (ADR 0084).
- **Valuation:** pass for the normal path (Binance USDT price × MAX `usdttwd`). The MAX-blocked path was not tried live.
- **Request weight** and **Recapture:** not recorded.

A review before merge found that the original trade paging sent only `startTime`, which Binance answers with the next 24 hours, so later fills would have been dropped. The paging was rewritten as described under **Trade paging** and checked against a fake that applies Binance's 24-hour rule. That fix has not run against a live account with fills.
