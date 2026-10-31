# Binance live probe

Status: Proposed. Nothing below has been run against a live account yet.

[ADR 0083](../adr/0083-binance-declares-bounded-trade-history.md) requires the project owner to verify the Binance source with their own account before it merges. The source was built from Binance's public Spot API documentation and synthetic fixtures. This checklist names the facts the code assumes and how to confirm each one. Record each result in this file and change the status to Accepted when every item passes.

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
- [ ] **Region.** From the owner's network, no request answers HTTP 451 or a 403 without a Binance code. If one does, the run fails as `source-access-challenged`.
- [ ] **UID.** `GET /api/v3/account` returns a numeric `uid`. The source connection depends on it.
- [ ] **HTTP Date.** The account and `get-funding-asset` responses carry a `Date` header. Holdings use it as their as-of time.
- [ ] **Spot inventory.** Spot holdings in the App match the Binance spot wallet. `LD`-prefixed Simple Earn balances are absent, and a listed asset such as `LDO` is still shown.
- [ ] **Funding inventory.** Funding holdings match the funding wallet, counting `free + locked + freeze + withdrawing`.
- [ ] **Deposit wallet.** Each deposit and withdrawal row has `walletType` 0 (spot) or 1 (funding), and the movement appears on that account.
- [ ] **Deposit and withdrawal status.** Only deposits with status 1 or 6 and withdrawals with status 6 appear. Note whether a pending withdrawal has already left the balance.
- [ ] **Withdrawal amount.** Compare one completed withdrawal's `amount` and `transactionFee` with the balance change. The source records `amount` only, as MaiCoin does.
- [ ] **Windows.** Deposit and withdrawal requests accept 90-day windows, and `/sapi/v1/asset/transfer` accepts 30-day windows, with no -1127 or -1131 error.
- [ ] **Transfers.** A spot-to-funding transfer appears once as an outflow on spot and an inflow on funding, with the same date.
- [ ] **Trade paging.** `myTrades` with `symbol` and `startTime` returns fills in ascending `id` order from `startTime`, and `fromId` continues after the first page. A pair with more than 1000 fills in three months confirms the paging.
- [ ] **Bounded pairs.** Note how many pairs the run requested and whether any trade the owner remembers is missing. A missing trade in a pair outside "observed asset × USDT, FDUSD, USDC, BTC, BNB, ETH" is expected (ADR 0083).
- [ ] **Commission.** For one trade whose commission is in BNB, confirm the trade's quantity and quote amount. The commission is not recorded, as MaiCoin's fee is not.
- [ ] **Request weight.** Note the largest `X-MBX-USED-WEIGHT-1M` seen during the run. It should stay well under 6000.
- [ ] **Valuation.** Holdings are valued in TWD through the Binance USDT price and MAX `usdttwd`. With MAX blocked, for example by a firewall rule, the run still completes and Overview shows each crypto holding in its own units.
- [ ] **Recapture.** A second run adds no investment transaction.

## Results

Not yet recorded.
