# Running the Yuanta Trade column probe

The Yuanta Trade column probe is a development-only command. It answers one question: does a Yuanta Trade transaction report have a settlement-date column, such as `交割日` or `交割日期`? If it does, the ledger can take the settlement date from the provider instead of computing it from a Taiwan holiday calendar.

The workflow in `src/workflows/yuanta-trade-statements.ts` parses every grid column of a report page but keeps only the columns it names, and the App never writes workflow output to a log. So the probe reads the same report pages and prints only their column lists. It signs in with the workflow's own code, writes no files, never writes to the ledger, and the installer does not include it.

## Before you run it

1. Have your Taiwan ID number, Yuanta Securities password, certificate file (`.pfx` or `.p12`), and certificate password ready. These are the same four values the App asks for.
2. Install the YuanTa security component (ServiSign). Without it, the sign-in stops with a `servisign-unavailable` event.
3. Close other Yuanta Trade sessions.

## Run the probe

Put the credentials in the environment without typing them on the command line. In zsh:

```sh
read -rs "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID?Taiwan ID number: "; echo
read -rs "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD?Yuanta Securities password: "; echo
read -r "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH?Certificate file path: "
read -rs "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD?Certificate password: "; echo
export LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD
npm run probe:yuanta-trade-columns -- --allow-live-source
```

`--help` prints the usage and exits without network access. `--headless` hides the browser window. The probe opens the same visible, non-persistent development browser as `npm run workflow:dev`, with the Yuanta Trade browser profile. Stage events go to stderr. The report goes to stdout as JSON.

The probe does these steps in order:

1. It signs in at `https://global.yuanta.com.tw/NexusWebTrade/Login/OTPLogin?urlid=6020` with the workflow's sign-in code. The App's local solver answers the audio code, CAPTCHA checkbox, and image challenge, the same route `npm run workflow:dev -- run-app yuanta-trade-statements` uses. If the solver cannot answer a stage, the probe stops before the report.
2. It reads the ten trade reports the workflow reads, with the workflow's own form parameters, over the workflow's 91-day range ending today in Taipei. The order is `OverseaTrade` and `InternationalSecuritiesTrade` (foreign securities), then `StockTrade` (domestic), then `SecuritiesLendingTrade`, `UnlimitedUseLendingTrade`, `LedgerTrade`, `FuturesTrade`, `WealthTrade`, `BondTrade`, and `DerivativeTrade`.

A report that fails is recorded as `failed`, and the next report still runs.

The exit code is 0 when every report was read, 1 when a report or the sign-in failed, and 2 for a usage error or a missing environment variable.

## Output

The report has these top-level fields:

- `complete`: whether every report was read.
- `rangeDays`: the length of the queried range.
- `reports`: one entry per report type. A read report lists its `grids` and `dataKeysOutsideColumns`. A failed report names its reason: a provider response check such as `response-endpoint`, an error class name, or `capture-failed`.
- `settlementDateCandidates`: every column, and every data key, whose field or title matches `交割日`, `交割日期`, `SettleDate`, `SettlementDate`, or `DeliveryDate`, in any letter case.

Each grid has these fields:

- `gridId` and `category`: the grid's element ID and the category the workflow derives from it. An ID with six or more consecutive digits shows as `{segment}`.
- `rowCount`: how many rows the grid held.
- `columns`: every `{ field, title }` pair, in page order. A field that is not a plain identifier, or has four or more consecutive digits, shows as `{key}`. A title longer than 40 characters, or with four or more consecutive digits, shows as `withheld`.

`dataKeysOutsideColumns` lists the object keys in the page's inline JSON that no grid shows as a column, such as `MarketNo`. A settlement date can be in the row data without a visible column, and this list shows that case. Keys are sanitized like fields.

The report never contains row values, account numbers, names, amounts, dates, or error messages.

## What to paste back

Before you paste, search the report for long digit runs:

```sh
npm run -s probe:yuanta-trade-columns -- --allow-live-source > yuanta-trade-columns.json
grep -nE '[0-9]{4,}' yuanta-trade-columns.json
```

There should be no matches. If anything matches, do not paste the report. Report the matching line number and field name instead. Otherwise, paste only `settlementDateCandidates` and each report's `columns` lists, then delete the file.
