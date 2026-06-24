# Octopus Beak

Octopus Beak is a personal banking automation project built on Libretto. It opens supported Taiwan online banking portals in a real browser, lets you complete required CAPTCHA, OTP, or certificate steps, then downloads or parses account, card, loan, fund, and trading records into local files.

The project is designed for personal record keeping. Credentials and downloaded financial data stay local and must not be committed.

## What It Does

- Automates supported bank workflows in headed browser mode.
- Pauses when manual CAPTCHA, OTP, email verification, or certificate selection is required.
- Saves downloaded or parsed records under `downloads/`.
- Returns only file metadata, row counts, selected labels, and masked account/card labels to stdout.
- Keeps `.env`, `downloads/`, `.libretto/sessions/`, and `.libretto/profiles/` out of git through `.gitignore`.

## Security Notes

Treat this repository as sensitive when it contains local runtime data.

- Put real credentials only in `.env`; never commit `.env`.
- Do not publish or share `downloads/`; it contains personal banking exports.
- Do not publish or share `.libretto/sessions/`; browser network logs may contain session tokens, form tokens, request bodies, and account fields.
- Use placeholder values in documentation and examples, such as `<account-suffix>` or `<loan-account-label>`.
- Review generated filenames before sharing files, because some bank downloads include account suffixes in filenames.

## Setup

Install dependencies:

```bash
npm install
```

Run Libretto's first-time setup:

```bash
npm run libretto:setup
```

Copy `.env.example` to `.env`, then fill only the credentials needed for the workflow you want to run:

```bash
cp .env.example .env
```

The basic Libretto example does not require an OpenAI API key. Add `OPENAI_API_KEY` only if you build workflows that use OpenAI-backed recovery, extraction, or model calls.

Check TypeScript:

```bash
npm run typecheck
```

## Running A Workflow

Most bank workflows must run in headed mode because banking sites usually require manual CAPTCHA, OTP, email verification, or certificate confirmation.

Run a workflow:

```bash
npm run run:fubon-statements
```

When the workflow pauses, complete the requested step in the browser, then resume:

```bash
npx libretto resume --session <session-name>
```

Clean up browser sessions after failed or interrupted runs:

```bash
npm run libretto:close-all
```

## Local CSV Import

```bash
npm run run:import-downloads-csv
```

本命令是本機 TypeScript Node CLI，不是 Libretto browser workflow。第一階段只做入庫 raw ledger：掃描 `downloads/**/*.csv`、保留可重跑與可稽核 metadata、標記 duplicate，不做 dashboard、轉帳配對或卡費對帳。

CSV 會先經過表格 layout 正規化：有些下載檔第一列就是 header，有些會先出現報表標題、查詢條件、帳戶資料，再到真正的「查詢結果」表格。若檔案第一列是 workflow 產生的 `column_1` / `column_2` 位置欄名，CLI 會保守保留後續列，不猜測中間 section header。CLI 會逐檔記錄 `csvLayout`，包含 header row、data start row、preamble row count 與 warning；raw row 的 `sourceRowIndex` 仍是原 CSV 的 1-based 列號，方便回查原始檔。

它不會解析 `.xls` / `.xlsx` / `.json`。同名原始檔會保留在 `relatedRawFiles`、`relatedRawFileRelativePaths` 與 `relatedRawFileMetadata`，作為後續稽核與對帳的原始憑證鏈接。metadata 只記錄 bytes、modifiedAt、hash，不解析內容。

Raw ledger contract: [docs/raw-ledger.md](docs/raw-ledger.md)
Financial model and dashboard contract: [docs/financial-model.md](docs/financial-model.md)

匯入結果會 append 到：

- `data/ledger/import_run_events.jsonl`
- `data/ledger/import_runs.jsonl`
- `data/ledger/import_batches.jsonl`
- `data/ledger/raw_transaction_occurrences.jsonl`

正式匯入會先寫入 `started` event；完成時寫入 `completed` event；如果匯入流程中途丟錯，會寫入帶有 `activeSourceFile` 的 `failed` event，方便稽核中斷或失敗的 run。

命令輸出欄位可直接當成第一階段報表：

- `schemaVersion`：raw ledger record 格式版本，目前為 `raw-ledger.v1`
- `recordType`：stdout 結果與 JSONL records 的用途標記
- `importerName` / `importerVersion`：產生 raw ledger records 的 importer 標記
- `importRunId`：本次執行 ID，可用來追蹤這次匯入造成的 batch 與 raw rows
- `runEventLogPath`：正式匯入時寫入 run lifecycle events 的路徑
- `runLogPath`：正式匯入時寫入 run-level manifest 的路徑
- `scannedCsvFiles`：本次實際掃到並符合 filter 的 csv 數
- `importedRows`：本次新增的原始列總數（含 duplicate）
- `uniqueRows`：本次判定為新列
- `duplicateRows`：本次判定為重複列（保留 row，但 `dedupeStatus=duplicate`）
- `batchesWritten`：本次建立的 import batch 數
- `files`：逐檔摘要，包含每個 csv 的 `sourceRelativePath`、`sourceFileMetadata`、`sourceSheetName`、`csvLayout`、headers、recordKeys、row 數、unique/duplicate 數與 related raw file metadata

第一階段的 duplicate 判斷使用 `sourceHash`，它由來源檔 hash、來源列號與 raw row hash 組成，用來偵測同一來源列被重跑。`contentHash` 會保留下來給後續分析，但不在第一階段用來直接判 duplicate。

可選擇只跑某些來源：

```bash
npm run run:import-downloads-csv -- --params '{"bankFilters":["yuanta"],"productFilters":["statements"]}'
```

會只處理 `downloads/yuanta-statements/**` 下的 csv 檔（`productFilters` 由第一層資料夾名去掉銀行前綴推導）。

第一次執行可先 dry run，不寫入 ledger：

```bash
npm run run:import-downloads-csv -- --params '{"dryRun":true}'
```

dry run 仍會回傳 `files` 摘要，可先確認本次會吃進哪些 CSV 與關聯哪些原始檔。

正式匯入若沒有任何符合條件的 CSV，預設會失敗並留下 `failed` event，避免誤記空 run。若你確定要記錄空 run，可明確傳入：

```bash
npm run run:import-downloads-csv -- --params '{"allowEmpty":true}'
```

## Local Financial Dashboard

Raw ledger 建好後，可以建立第二層 parser/model 與本機 dashboard：

```bash
npm run run:build-financial-dashboard
```

輸出會寫到：

- `data/ledger/financial_model.json`
- `data/ledger/financial_model_quality.json`
- `data/ledger/financial_dashboard.html`

Dashboard 會顯示整合資產狀態、幣別 totals、parser coverage 與 data quality。`includeInTotals=false` 的項目只做稽核展示，不納入總額，避免把券商或基金 summary rollup 與明細重複計算。

## Supported Workflows

| Bank   | Records                                                                         | Command                                          | Output                                          |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Fubon  | Deposit, credit card, and loan statements in one login session                  | `npm run run:fubon-all-statements`               | `downloads/fubon-*/`                            |
| Fubon  | Deposit statements                                                              | `npm run run:fubon-statements`                   | `downloads/fubon-statements/`                   |
| Fubon  | Credit card statements and unbilled details                                     | `npm run run:fubon-credit-card-statements`       | `downloads/fubon-credit-card-statements/`       |
| Fubon  | Loan statements                                                                 | `npm run run:fubon-loan-statements`              | `downloads/fubon-loan-statements/`              |
| YuanTa | TWD, foreign-currency, loan, credit card, and fund statements in one session    | `npm run run:yuanta-all-statements`              | Multiple `downloads/yuanta-*/` folders          |
| YuanTa | TWD account statements                                                          | `npm run run:yuanta-statements`                  | `downloads/yuanta-statements/`                  |
| YuanTa | Nexus WebTrade statements and holdings                                          | `npm run run:yuanta-trade-statements`            | `downloads/yuanta-trade-statements/`            |
| YuanTa | Foreign-currency statements                                                     | `npm run run:yuanta-foreign-currency-statements` | `downloads/yuanta-foreign-currency-statements/` |
| YuanTa | Loan statements                                                                 | `npm run run:yuanta-loan-statements`             | `downloads/yuanta-loan-statements/`             |
| YuanTa | Credit card statements                                                          | `npm run run:yuanta-credit-card-statements`      | `downloads/yuanta-credit-card-statements/`      |
| YuanTa | Fund portfolio, investment details, historical fund orders, and off-hour orders | `npm run run:yuanta-fund-statements`             | `downloads/yuanta-fund-statements/`             |
| Cathay | TWD account statements                                                          | `npm run run:cathay-statements`                  | `downloads/cathay-statements/`                  |
| Cathay | TWD and foreign-currency statements in one login session                        | `npm run run:cathay-all-statements`              | `downloads/cathay-statements/`, `downloads/cathay-foreign-statements/` |
| Cathay | Foreign-currency statements                                                     | `npm run run:cathay-foreign-statements`          | `downloads/cathay-foreign-statements/`          |

## Credentials

### Fubon

Used by Fubon deposit, credit card, and loan workflows.

```bash
LIBRETTO_CLOUD_FUBON_USER_ID=
LIBRETTO_CLOUD_FUBON_ACCOUNT=
LIBRETTO_CLOUD_FUBON_PASSWORD=
```

### YuanTa Internet Banking

Used by YuanTa TWD, foreign-currency, loan, credit card, and fund workflows. `YUANTA_ACCOUNT` is the YuanTa `使用者代號` login field.

```bash
LIBRETTO_CLOUD_YUANTA_USER_ID=
LIBRETTO_CLOUD_YUANTA_ACCOUNT=
LIBRETTO_CLOUD_YUANTA_PASSWORD=
```

### YuanTa Nexus WebTrade

Used by the YuanTa WebTrade workflow. The certificate path and certificate password are separate from the WebTrade login credentials.

```bash
LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID=
LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD=
LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH=
LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD=
```

### Cathay

Used by Cathay TWD and foreign-currency workflows. `CATHAY_ACCOUNT` is the Cathay `用戶代號` login field.

```bash
LIBRETTO_CLOUD_CATHAY_USER_ID=
LIBRETTO_CLOUD_CATHAY_ACCOUNT=
LIBRETTO_CLOUD_CATHAY_PASSWORD=
```

## Workflow Details

### Fubon All Statements

```bash
npm run run:fubon-all-statements
```

Logs in to Fubon once, then runs the deposit, credit card, and loan workflows in the same browser session. This avoids repeating CAPTCHA/OTP for the three separate Fubon workflows. Output is grouped in the workflow result as `statements`, `creditCards`, and `loans`; files are still written to the same per-workflow folders:

- `downloads/fubon-statements/`
- `downloads/fubon-credit-card-statements/`
- `downloads/fubon-loan-statements/`

The nested params match the original workflow params:

```bash
npx libretto run src/workflows/fubon-all-statements.ts --headed --params '{"statements":{"dateRanges":["180","180_365"],"downloadFormat":"EXCEL"},"creditCards":{"periodOffsets":[1,2,3,4,5,6]},"loans":{"quickMonths":"6","downloadFormat":"EXCEL"}}'
```

For Fubon deposit and loan `EXCEL` downloads, the workflow keeps the original bank file and also writes a sibling `.csv` file. The result metadata includes the original `path`/`bytes` plus `csvPath`/`csvBytes`.

### Fubon Deposit Statements

```bash
npm run run:fubon-statements
```

Downloads the past year by running both bank ranges, `180` and `180_365`, because the bank UI limits each query to roughly six months. The workflow saves one file per account per range and does not print statement rows to stdout. For `EXCEL` downloads, it also writes a sibling `.csv` file and returns `csvPath`/`csvBytes`.

### Fubon Credit Card Statements

```bash
npm run run:fubon-credit-card-statements
```

Parses credit card `帳單明細` for the six visible period tabs, `本期` through `前五期`, and parses `未出帳單消費明細`. It writes CSV files and returns only file metadata, period labels, and masked card labels.

Optional filters:

```bash
npx libretto run src/workflows/fubon-credit-card-statements.ts --headed --params '{"periodOffsets":[1,2,3,4,5,6],"statementCardLabels":["<card-label>"],"unbilledCardNumbers":["<card-suffix>"]}'
```

### Fubon Loan Statements

```bash
npm run run:fubon-loan-statements
```

Selects every available loan account, runs all discovered loan query items for `近六個月`, downloads `EXCEL`, and returns file metadata only.

Some loan accounts expose only a subset of the query item options. By default, the workflow reads the visible options for each account and runs only the available query items, avoiding long `selectOption` timeouts for unavailable items. If you explicitly pass `queryItem` or `queryItems`, unavailable items are reported in `skippedAccounts`.

For `EXCEL` downloads, the workflow keeps the original bank file and also writes a sibling `.csv` file with `csvPath`/`csvBytes` in the output metadata.

Optional filters and date ranges:

```bash
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"loanAccountLabels":["<loan-account-label>"],"quickMonths":"6","downloadFormat":"EXCEL"}'
```

```bash
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"dateRange":{"startDate":"YYYY/MM/DD","endDate":"YYYY/MM/DD"},"downloadFormat":"EXCEL"}'
```

Run only one loan query item:

```bash
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"queryItem":"TRANSACTION_DETAIL_QUERY","downloadFormat":"EXCEL"}'
```

### YuanTa TWD Statements

```bash
npm run run:yuanta-statements
```

Opens `臺幣交易明細查詢`, uses the `三個月` date range by default, iterates all domestic-currency account options, downloads each `下載CSV檔`, re-encodes the bank's Big5 CSV as UTF-8, and returns only file metadata and masked account labels.

Optional params:

```bash
npx libretto run src/workflows/yuanta-statements.ts --headed --params '{"dateRange":"three_months","accountFilters":["<account-suffix>"],"replaceActiveSession":true}'
```

Supported `dateRange` values are `one_week`, `one_month`, and `three_months`. Set `replaceActiveSession` to `false` if you do not want the workflow to click YuanTa's active-session replacement prompt.

### YuanTa Nexus WebTrade

```bash
npm run run:yuanta-trade-statements
```

Runs in headed mode because YuanTa Nexus WebTrade requires an image challenge and may require local certificate selection. If the certificate file prompt remains open after resume, select the certificate file in the browser and resume again.

By default, the workflow queries discovered AssetReport holding pages and matching trade-detail pages for the last 90 days. It writes CSV files plus a JSON manifest for audit/debugging, and returns only counts and file metadata to stdout.

Optional params:

```bash
npx libretto run src/workflows/yuanta-trade-statements.ts --headed --params '{"startDate":"YYYY/MM/DD","endDate":"YYYY/MM/DD","accountIndex":-1}'
```

YuanTa enforces a 90-day custom date range limit in the UI.

### YuanTa All Internet Banking Statements

```bash
npm run run:yuanta-all-statements
```

Runs the YuanTa Internet Banking TWD, foreign-currency, loan, credit card, and fund workflows through the same headed browser session. Complete the CAPTCHA once, resume the session, and the wrapper reuses the authenticated page for the remaining workflows. The fund workflow runs last because the existing fund workflow logs out when it finishes.

The wrapper uses the existing individual workflow components and writes each workflow's files to its own existing output folder. YuanTa TWD and foreign-currency statement downloads are parsed into clean timestamped CSV/JSON table pairs.

Run only selected components:

```bash
npm run run:yuanta-all-statements -- --params '{"include":{"statements":true,"foreignCurrency":true,"loan":false,"creditCard":false,"fund":false}}'
```

Pass options through to individual components:

```bash
npm run run:yuanta-all-statements -- --params '{"statements":{"dateRange":"one_month","accountFilters":["<account-suffix>"]},"foreignCurrency":{"currencyFilters":["USD"]},"creditCard":{"monthIndexes":[0,1,2]},"continueOnError":true}'
```

By default, every component is enabled, `prepareBetweenComponents` is `true`, and `continueOnError` is `false`. If a run fails between components, keep only the `yuanta-all-*` log lines and the final error when sharing diagnostics; avoid sharing account rows or downloaded file contents.

### YuanTa Foreign-Currency Statements

```bash
npm run run:yuanta-foreign-currency-statements
```

Opens `外幣交易明細查詢`, uses the `三個月` date range by default, iterates all available foreign-currency account options, selects `全部` currency when available, parses the bank's Big5 CSV downloads, and writes one clean table pair:

- `downloads/yuanta-foreign-currency-statements/foreign-currency-transactions-{timestamp}.csv`
- `downloads/yuanta-foreign-currency-statements/foreign-currency-transactions-{timestamp}.json`

The CSV contains only headers and transaction rows, sorted by `交易日期` and `交易時間` from newest to oldest. Metadata such as source download filenames, accounts, currencies, date range, and channel type is stored in the JSON file.

Optional params:

```bash
npx libretto run src/workflows/yuanta-foreign-currency-statements.ts --headed --params '{"dateRange":"one_month","accountFilters":["<account-suffix>"],"currencyFilters":["USD"],"channelType":"mobile_bank","replaceActiveSession":true}'
```

Supported `dateRange` values are `one_week`, `one_month`, and `three_months`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces the range limits shown in its UI.

### YuanTa Loan Statements

```bash
npm run run:yuanta-loan-statements
```

Opens `貸款繳款明細查詢`, uses the `一年` date range by default, iterates all available loan account options, parses the result table, and writes one clean table pair:

- `downloads/yuanta-loan-statements/loan-statements-{timestamp}.csv`
- `downloads/yuanta-loan-statements/loan-statements-{timestamp}.json`

The CSV splits `交易日/記帳日` into `交易日` and `記帳日`, splits `提息起日/提息迄日` into `提息起日` and `提息迄日`, includes the source `貸款帳戶`, and sorts rows by `交易日` from newest to oldest. Metadata such as source accounts, row counts, and date range is stored in the JSON file.

Optional params:

```bash
npx libretto run src/workflows/yuanta-loan-statements.ts --headed --params '{"dateRange":"six_months","loanAccountFilters":["<loan-account-suffix>"],"replaceActiveSession":true}'
```

Supported `dateRange` values are `three_months`, `six_months`, and `one_year`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces the range limits shown in its UI.

### YuanTa Credit Card Statements

```bash
npm run run:yuanta-credit-card-statements
```

Opens `歷史帳單明細查詢`, parses all visible statement months, then parses `未出帳明細查詢`, `近三個月繳款明細查詢`, and `信用卡總覽`. YuanTa does not provide download buttons for these tables, so the workflow writes parsed CSV and JSON files. It also writes aggregate CSV/JSON files for transaction-style tables, grouped by table type such as `transactions` and `payment-details`.

Optional params:

```bash
npx libretto run src/workflows/yuanta-credit-card-statements.ts --headed --params '{"monthIndexes":[0,1,2],"includeUnbilled":true,"includePaymentDetails":true,"includeSummary":false,"replaceActiveSession":true}'
```

`monthIndexes` maps to YuanTa's visible statement links: `0` is the current visible statement month, `1` is the next older month, and so on. Omit it to parse every visible statement month.

### YuanTa Fund Statements

```bash
npm run run:yuanta-fund-statements
```

Opens `基金歸戶總覽`, `基金投資明細總覽`, each fund's `基金歷史交易明細查詢`, and `營業時間外交易查詢與取消`. YuanTa does not provide download buttons for these tables, so the workflow parses the pages and writes raw CSV/JSON files. It also writes schema-stable aggregate CSV/JSON files for real data tables such as `portfolio-summary`, `investment-detail`, `buy-details`, and `redemption-details`.

Optional params:

```bash
npx libretto run src/workflows/yuanta-fund-statements.ts --headed --params '{"dateRange":"six_months","fundFilters":["<fund-code-or-name>"],"includeOffHourOrders":true,"replaceActiveSession":true}'
```

Supported `dateRange` values are `three_months`, `six_months`, and `one_year`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces a maximum query interval of one year.

### Cathay TWD Statements

```bash
npm run run:cathay-statements
```

Uses authenticated Cathay statement APIs to fetch `近 1 年` for every TWD account and writes CSV files. Cathay may require Email OTP verification.

Optional params:

```bash
npx libretto run src/workflows/cathay-statements.ts --headed --params '{"dateRange":"six_months","accountFilters":["<account-suffix>"],"trustDevice":false}'
```

Supported `dateRange` values are `one_week`, `one_month`, `three_months`, `six_months`, and `one_year`. Set `trustDevice` to `true` only if you want the workflow to opt into Cathay's trusted-device prompt when it appears.

### Cathay TWD and Foreign-Currency Statements

```bash
npm run run:cathay-all-statements
```

Logs in once, creates one Cathay API session, then fetches both TWD and foreign-currency statements. It writes TWD CSV files to `downloads/cathay-statements/` and foreign-currency CSV files to `downloads/cathay-foreign-statements/`.

Optional params:

```bash
npx libretto run src/workflows/cathay-all-statements.ts --headed --params '{"statementTypes":["domestic","foreign"],"dateRange":"six_months","domesticAccountFilters":["<twd-account-suffix>"],"foreignAccountFilters":["<foreign-account-suffix>"],"currencyFilters":["USD"],"trustDevice":false}'
```

Supported `statementTypes` values are `domestic` and `foreign`; omit it to fetch both in one login session. `accountFilters` applies to both account families unless `domesticAccountFilters` or `foreignAccountFilters` is provided.

### Cathay Foreign-Currency Statements

```bash
npm run run:cathay-foreign-statements
```

Uses authenticated Cathay foreign-currency APIs to fetch `近 1 年` for every foreign-currency account and all available currencies, then writes CSV files. Cathay may require Email OTP verification.

Optional params:

```bash
npx libretto run src/workflows/cathay-foreign-statements.ts --headed --params '{"dateRange":"six_months","accountFilters":["<account-suffix>"],"currencyFilters":["USD"],"trustDevice":false}'
```

Supported `dateRange` values are `one_week`, `one_month`, `three_months`, `six_months`, and `one_year`. Set `trustDevice` to `true` only if you want the workflow to opt into Cathay's trusted-device prompt when it appears.

## Libretto Utilities

```bash
npm run libretto:status
npx libretto open https://example.com --headed --session demo
npx libretto snapshot --session demo
npx libretto exec --session demo "return await page.title()"
npm run libretto:close-session -- demo
npm run libretto:close-all
```

`libretto:close-session` passes the session name after `--`, so `npm run libretto:close-session -- demo` runs `libretto close --session demo`.

## Development

Run the simple browser example:

```bash
npm run run:example
```

Run TypeScript checks:

```bash
npm run typecheck
```
