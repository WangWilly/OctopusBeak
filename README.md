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
npx libretto close --session demo
```

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
npx libretto run src/workflows/fubon-loan-statements.ts --headed --params '{"loanAccountLabels":["9498"],"quickMonths":"6","downloadFormat":"EXCEL"}'
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

By default, this workflow opens `臺幣交易明細查詢`, uses the `一個月` date range, iterates all domestic-currency account options, downloads each `下載CSV檔`, and saves the files under `downloads/yuanta-statements/`. It returns only file metadata and masked account labels.

Optional params can be passed with Libretto:

```bash
npx libretto run src/workflows/yuanta-statements.ts --headed --params '{"dateRange":"three_months","accountFilters":["9947"],"replaceActiveSession":true}'
```

Supported `dateRange` values are `one_week`, `one_month`, and `three_months`. Set `replaceActiveSession` to `false` if you do not want the workflow to click YuanTa's active-session replacement prompt.

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
npx libretto run src/workflows/yuanta-foreign-currency-statements.ts --headed --params '{"dateRange":"one_month","accountFilters":["9947"],"currencyFilters":["USD"],"channelType":"mobile_bank","replaceActiveSession":true}'
```

Supported `dateRange` values are `one_week`, `one_month`, and `three_months`. For a custom date range, pass `customDateRange` with `YYYY/MM/DD` dates; YuanTa enforces the range limits shown in its UI.
