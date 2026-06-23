# Libretto Playground

Minimal Libretto project for experimenting with browser automation workflows.

## Setup

Install dependencies:

```bash
npm install
```

Run Libretto's first-time setup:

```bash
npm run libretto:setup
```

The basic browser workflow does not require an OpenAI API key. Copy `.env.example` to `.env` only if your own workflow uses OpenAI-backed recovery, extraction, or other model calls.

## Run The Example

```bash
npm run run:example
```

The example workflow opens `https://example.com`, reads the page title and heading, and returns them as JSON.

Check TypeScript:

```bash
npm run typecheck
```

## Useful Commands

```bash
npm run libretto:status
npx libretto open https://example.com --headed --session demo
npx libretto snapshot --session demo
npx libretto exec --session demo "return await page.title()"
npm run libretto:close-session -- demo
npm run libretto:close-all
```

`libretto:close-session` passes the session name after `--`, so
`npm run libretto:close-session -- demo` runs `libretto close --session demo`.
Use `libretto:close-all` after failed or interrupted workflows to clean up
unused `Google Chrome for Testing` windows.

## Fubon Statements Workflow

Fill these values in `.env` before running:

```bash
LIBRETTO_CLOUD_FUBON_USER_ID=
LIBRETTO_CLOUD_FUBON_ACCOUNT=
LIBRETTO_CLOUD_FUBON_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA and may require OTP:

```bash
npm run run:fubon-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, the workflow downloads the past year by running both bank ranges: `180` and `180_365`. The bank UI limits each query to roughly six months, so the workflow saves one file per account per range under `downloads/fubon-statements/` and returns the file metadata. It does not print statement rows to stdout.

## Fubon Credit Card Statements Workflow

Use the same `.env` values:

```bash
LIBRETTO_CLOUD_FUBON_USER_ID=
LIBRETTO_CLOUD_FUBON_ACCOUNT=
LIBRETTO_CLOUD_FUBON_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA and may require OTP:

```bash
npm run run:fubon-credit-card-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow parses credit card `帳單明細` for the six visible period tabs (`本期` through `前五期`) and parses `未出帳單消費明細`. It writes CSV files under `downloads/fubon-credit-card-statements/` and returns only file metadata, period labels, and masked card labels.

Optional filters can be passed with Libretto params:

```bash
npx libretto run src/workflows/fubon-credit-card-statements.ts --headed --params '{"periodOffsets":[1,2,3,4,5,6],"statementCardLabels":["4281","6704"],"unbilledCardNumbers":["6704","4281"]}'
```

## Fubon Loan Statements Workflow

Use the same `.env` values:

```bash
LIBRETTO_CLOUD_FUBON_USER_ID=
LIBRETTO_CLOUD_FUBON_ACCOUNT=
LIBRETTO_CLOUD_FUBON_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA and may require OTP:

```bash
npm run run:fubon-loan-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow selects every available loan account, runs all discovered loan query items for `近六個月`, downloads `EXCEL`, and saves files under `downloads/fubon-loan-statements/`. The workflow returns file metadata only; it does not print loan statement rows to stdout.

Optional filters and date ranges can be passed with Libretto params:

```bash
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"loanAccountLabels":["<loan-account-label>"],"quickMonths":"6","downloadFormat":"EXCEL"}'
```

```bash
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"dateRange":{"startDate":"2026/01/01","endDate":"2026/06/21"},"downloadFormat":"EXCEL"}'
```

To run only one loan query item:

```bash
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"queryItem":"TRANSACTION_DETAIL_QUERY","downloadFormat":"EXCEL"}'
```

## YuanTa Domestic-Currency Statements Workflow

Fill these values in `.env` before running. `YUANTA_ACCOUNT` is the YuanTa `使用者代號` login field.

```bash
LIBRETTO_CLOUD_YUANTA_USER_ID=
LIBRETTO_CLOUD_YUANTA_ACCOUNT=
LIBRETTO_CLOUD_YUANTA_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA:

```bash
npm run run:yuanta-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow opens `臺幣交易明細查詢`, uses the `三個月` date range, iterates all domestic-currency account options, downloads each `下載CSV檔`, and saves the files under `downloads/yuanta-statements/`. It returns only file metadata and masked account labels.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-statements.ts --headed --params '{"dateRange":"three_months","accountFilters":["<account-suffix>"],"replaceActiveSession":true}'
```

Supported `dateRange` values are `one_week`, `one_month`, and `three_months`. Set `replaceActiveSession` to `false` if you do not want the workflow to click YuanTa's active-session replacement prompt.

## YuanTa Nexus WebTrade Statements And Holdings Workflow

Fill these values in `.env` before running. The certificate path and certificate password use separate settings from the WebTrade login credentials.

```bash
LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID=
LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD=
LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH=
LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD=
```

Run the workflow in headed mode because YuanTa Nexus WebTrade requires the image challenge and may require the local certificate selection flow:

```bash
npm run run:yuanta-trade-statements
```

When the workflow pauses, solve the YuanTa challenge in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

If the certificate file prompt remains open after resume, select the certificate file in the browser and resume again. By default, the workflow queries all discovered AssetReport holding pages and all matching trade-detail pages for the last 90 days, then writes CSV files under `downloads/yuanta-trade-statements/`. Grid CSVs use the site table headers. `*-summary-*` CSVs are raw mixed page-summary rows, so they use synthetic `column_1`, `column_2`, etc. headers to avoid treating an unrelated page row as the CSV schema. It also writes a JSON manifest for audit/debugging, and returns only counts and file metadata to stdout.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-trade-statements.ts --headed --params '{"startDate":"2026/03/24","endDate":"2026/06/22","accountIndex":-1}'
```

YuanTa enforces a 90-day custom date range limit in the UI.

## YuanTa Foreign-Currency Statements Workflow

Use the same `.env` values:

```bash
LIBRETTO_CLOUD_YUANTA_USER_ID=
LIBRETTO_CLOUD_YUANTA_ACCOUNT=
LIBRETTO_CLOUD_YUANTA_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA:

```bash
npm run run:yuanta-foreign-currency-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow opens `外幣交易明細查詢`, uses the `三個月` date range, iterates all available foreign-currency account options, selects `全部` currency when available, downloads each `下載CSV檔`, and saves files under `downloads/yuanta-foreign-currency-statements/`. It returns only file metadata, masked account labels, and currency labels.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-foreign-currency-statements.ts --headed --params '{"dateRange":"one_month","accountFilters":["<account-suffix>"],"currencyFilters":["USD"],"channelType":"mobile_bank","replaceActiveSession":true}'
```

Supported `dateRange` values are `one_week`, `one_month`, and `three_months`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces the range limits shown in its UI.

## YuanTa Loan Statements Workflow

Use the same `.env` values:

```bash
LIBRETTO_CLOUD_YUANTA_USER_ID=
LIBRETTO_CLOUD_YUANTA_ACCOUNT=
LIBRETTO_CLOUD_YUANTA_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA:

```bash
npm run run:yuanta-loan-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow opens `貸款繳款明細查詢`, uses the `一年` date range, iterates all available loan account options, parses the result table on the page, and writes CSV and JSON files under `downloads/yuanta-loan-statements/`. It returns only file metadata and masked loan account labels.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-loan-statements.ts --headed --params '{"dateRange":"six_months","loanAccountFilters":["<loan-account-suffix>"],"replaceActiveSession":true}'
```

Supported `dateRange` values are `three_months`, `six_months`, and `one_year`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces the range limits shown in its UI.

## YuanTa Credit Card Statements Workflow

Use the same `.env` values:

```bash
LIBRETTO_CLOUD_YUANTA_USER_ID=
LIBRETTO_CLOUD_YUANTA_ACCOUNT=
LIBRETTO_CLOUD_YUANTA_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA:

```bash
npm run run:yuanta-credit-card-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow opens `歷史帳單明細查詢`, parses all visible statement months, then parses `未出帳明細查詢`, `近三個月繳款明細查詢`, and `信用卡總覽`. YuanTa does not provide download buttons for these tables, so the workflow writes parsed CSV and JSON files under `downloads/yuanta-credit-card-statements/` and returns file metadata. It also writes aggregate CSV/JSON files named `*-aggregate-*.csv` and `*-aggregate-*.json` for transaction-style tables, grouped by table type such as `transactions` and `payment-details`.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-credit-card-statements.ts --headed --params '{"monthIndexes":[0,1,2],"includeUnbilled":true,"includePaymentDetails":true,"includeSummary":false,"replaceActiveSession":true}'
```

`monthIndexes` maps to YuanTa's visible statement links: `0` is the current visible statement month, `1` is the next older month, and so on. Omit it to parse every visible statement month.

## YuanTa Fund Statements Workflow

Use the same `.env` values:

```bash
LIBRETTO_CLOUD_YUANTA_USER_ID=
LIBRETTO_CLOUD_YUANTA_ACCOUNT=
LIBRETTO_CLOUD_YUANTA_PASSWORD=
```

Run the workflow in headed mode because the bank login requires manual CAPTCHA:

```bash
npm run run:yuanta-fund-statements
```

When the workflow pauses, enter the CAPTCHA in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow opens `基金歸戶總覽`, `基金投資明細總覽`, each fund's `基金歷史交易明細查詢`, and `營業時間外交易查詢與取消`. YuanTa does not provide download buttons for these tables, so the workflow parses the pages and writes raw CSV/JSON files under `downloads/yuanta-fund-statements/`. It also writes schema-stable aggregate CSV/JSON files named `*-aggregate-*.csv` and `*-aggregate-*.json` for real data tables such as `portfolio-summary`, `investment-detail`, `buy-details`, and `redemption-details`; reference, query-form, and header-only empty tables are kept as raw files but skipped from aggregates.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-fund-statements.ts --headed --params '{"dateRange":"six_months","fundFilters":["<fund-code-or-name>"],"includeOffHourOrders":true,"replaceActiveSession":true}'
```

Supported `dateRange` values are `three_months`, `six_months`, and `one_year`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces a maximum query interval of one year.

## Cathay Domestic-Currency Statements Workflow

Fill these values in `.env` before running. `CATHAY_ACCOUNT` is the Cathay `用戶代號` login field.

```bash
LIBRETTO_CLOUD_CATHAY_USER_ID=
LIBRETTO_CLOUD_CATHAY_ACCOUNT=
LIBRETTO_CLOUD_CATHAY_PASSWORD=
```

Run the workflow in headed mode because Cathay may require Email OTP verification:

```bash
npm run run:cathay-statements
```

When the workflow pauses, enter the Email OTP in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow uses the authenticated Cathay statement APIs to fetch `近 1 年` for every TWD account and writes CSV files under `downloads/cathay-statements/`. It returns only file metadata, row counts, and masked account labels.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/cathay-statements.ts --headed --params '{"dateRange":"six_months","accountFilters":["<account-suffix>"],"trustDevice":false}'
```

Supported `dateRange` values are `one_week`, `one_month`, `three_months`, `six_months`, and `one_year`. Set `trustDevice` to `true` only if you want the workflow to opt into Cathay's trusted-device prompt when it appears.

## Cathay Foreign-Currency Statements Workflow

Use the same Cathay `.env` values. `CATHAY_ACCOUNT` is the Cathay `用戶代號` login field.

```bash
LIBRETTO_CLOUD_CATHAY_USER_ID=
LIBRETTO_CLOUD_CATHAY_ACCOUNT=
LIBRETTO_CLOUD_CATHAY_PASSWORD=
```

Run the workflow in headed mode because Cathay may require Email OTP verification:

```bash
npm run run:cathay-foreign-statements
```

When the workflow pauses, enter the Email OTP in the browser and resume:

```bash
npx libretto resume --session <session-name>
```

By default, this workflow uses the authenticated Cathay foreign-currency APIs to fetch `近 1 年` for every foreign-currency account and all available currencies, then writes CSV files under `downloads/cathay-foreign-statements/`. It returns only file metadata, row counts, selected currencies, and masked account labels.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/cathay-foreign-statements.ts --headed --params '{"dateRange":"six_months","accountFilters":["<account-suffix>"],"currencyFilters":["USD"],"trustDevice":false}'
```

Supported `dateRange` values are `one_week`, `one_month`, `three_months`, `six_months`, and `one_year`. Set `trustDevice` to `true` only if you want the workflow to opt into Cathay's trusted-device prompt when it appears.
