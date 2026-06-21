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
