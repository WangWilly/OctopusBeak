![OctopusBeak banner](docs/assets/octopusbeak-readme-banner.webp)

# OctopusBeak

[繁體中文版](README.zh-TW.md)

Personal banking and E-Invoice automation with local portfolio and spending dashboards for Taiwan services.

OctopusBeak uses Libretto to run browser workflows for bank portals, download statement data, normalize files into CSV/JSON outputs, import them into a local SQLite ledger, and inspect the result in Svelte dashboards.

All downloaded statements, browser sessions, ledger databases, credentials, and local automation config are sensitive local data. Keep `downloads/`, `data/`, `.libretto/`, `.env`, `.env.local`, `settings.json`, `credentials.json`, and `~/Library/Application Support/OctopusBeak/` out of commits and shared archives.

## What It Does

- Runs guided browser automations for supported Taiwan banking portals.
- Pauses for manual steps such as CAPTCHA, OTP, email verification, or certificate selection.
- Provides an in-app `#/automation` panel for credentials, task runs, logs, retries, and human assist.
- Saves clean local statement exports under `downloads/<workflow-name>/`.
- Imports downloaded CSV files into `data/ledger/ledger.sqlite`.
- Fetches personal E-Invoices in a headless browser and pauses for CAPTCHA assistance when required.
- Shows local portfolio views at `#/overview`, `#/assets`, and `#/liabilities`.
- Shows confirmed personal invoice spending at `#/spending`, with monthly and daily category charts, invoice details, and editable item categories.
- Syncs MAX/MaiCoin balances and statement rows into the same ledger.

## Automation Demo

![Portfolio automation waiting for Fubon CAPTCHA assist](docs/assets/portfolio-automation-fubon-captcha-60s.gif)

The automation panel queues bank statement tasks, pauses when a Fubon CAPTCHA needs human assist, and resumes the run after verification.

## Quick Start

```bash
npm install
npm run libretto:setup
npm run typecheck
```

Start the desktop UI:

```bash
npm run desktop:dev
```

The desktop UI is Electron-only and opens the static renderer through `#/overview`.

## Desktop App

OctopusBeak runs as a macOS Electron app. The desktop app loads a static Svelte renderer and sends data, automation, settings, credentials, and human-assist actions through the Electron preload API. Runtime state is stored under:

```text
~/Library/Application Support/OctopusBeak/
```

That directory contains desktop `settings.json`, local `credentials.json` after credentials are saved, Libretto state, `downloads/`, automation logs, and `data/ledger/ledger.sqlite`.

Run locally in Electron:

```bash
npm run desktop:dev
```

Build an unsigned local app:

```bash
npm run desktop:package
open out/OctopusBeak-darwin-arm64/OctopusBeak.app
```

Build signed and notarized macOS release artifacts:

```bash
OCTOPUSBEAK_SIGN=1 OCTOPUSBEAK_NOTARY_PROFILE=OctopusBeakNotary npm run desktop:make
```

Artifacts are written to `out/make/`. See [Desktop Release](docs/desktop-release.md) for signing setup and smoke-test steps.

## Recommended Flow

1. Start the desktop app and open `#/automation`.
2. Save the credentials needed for the sources you use.
3. Run the crawler/sync tasks from the task table.
4. Complete manual browser checks from the Assist modal when a task is waiting for human input.
5. Run CSV import after every enabled producing crawler has a completed or partial run for the business day.
6. Review `#/overview`, `#/assets`, `#/liabilities`, or `#/spending`.

The same flow is still available from the CLI:

```bash
npm run run:fubon-all-statements
npx libretto resume --session <session-name>
npm run run:import-downloads-csv
npm run desktop:dev
```

Clean up interrupted browser sessions:

```bash
npm run libretto:close-all
```

## Automation Panel

The `#/automation` page wraps the existing npm scripts. It stores non-secret switches in `settings.json`, stores secret credential values in local `credentials.json`, records task history in `data/ledger/ledger.sqlite`, writes full task logs under `data/automation/logs/`, and keeps only the latest log tail in SQLite.

`import downloads csv` stays locked until every enabled producing crawler has a completed or partial run for the current business day.

Under **Credentials → Statements to collect**, non-secret statement-type selections are saved in `settings.json`. After upgrading, multi-type banks need an explicit first selection; single-type banks initialize their current type, and newly supported types stay off until selected. Selected types for one bank reuse one login session. Partial runs keep their successful downloads and allow Import with a warning.

`credentials.json` is local, ignored, and encrypted by Electron `safeStorage` in desktop runtime. If `safeStorage` encryption is unavailable, the desktop app fails startup instead of writing plaintext credentials.

Useful `settings.json` keys:

```json
{
  "AUTOMATION_BUSINESS_TIMEZONE": "Asia/Taipei",
  "LIBRETTO_CLOUD_FUBON_ENABLED": true,
  "LIBRETTO_CLOUD_ESUN_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES": "deposit,foreign_currency,credit_card",
  "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED": true,
  "LIBRETTO_CLOUD_CATHAY_ENABLED": true,
  "LIBRETTO_CLOUD_HNCB_ENABLED": true,
  "LIBRETTO_CLOUD_LINEBANK_ENABLED": true,
  "LIBRETTO_CLOUD_EINVOICE_ENABLED": true,
  "MAX_ENABLED": true,
  "MAX_SUB_ACCOUNT": "main"
}
```

Set a group flag to `false` or to a string such as `"0"`, `"no"`, `"off"`, or `"disabled"` to hide that source from the automation panel. Import remains visible because it has no credentials.

For direct `libretto run src/workflows/foo.ts` development, provide credentials through exported shell env. If you keep them in ignored `.env.local`, load them first with `set -a; source .env.local; set +a`; Libretto does not auto-load that file. Workflow files still read `process.env`; the desktop JSON store is only injected by the automation runner.

## Supported Workflows

| Source      | Command                                          | Output                                                    |
| ----------- | ------------------------------------------------ | --------------------------------------------------------- |
| Fubon       | `npm run run:fubon-all-statements`               | deposit, credit card, loan statements                     |
| Fubon       | `npm run run:fubon-statements`                   | deposit statements                                        |
| Fubon       | `npm run run:fubon-credit-card-statements`       | credit card statements                                    |
| Fubon       | `npm run run:fubon-loan-statements`              | loan statements                                           |
| ESun        | `npm run run:esun-credit-card-statements`        | credit card statements                                    |
| Yuanta      | `npm run run:yuanta-all-statements`              | TWD, foreign-currency, loan, credit card, fund statements |
| Yuanta      | `npm run run:yuanta-statements`                  | TWD account statements                                    |
| Yuanta      | `npm run run:yuanta-foreign-currency-statements` | foreign-currency statements                               |
| Yuanta      | `npm run run:yuanta-loan-statements`             | loan statements                                           |
| Yuanta      | `npm run run:yuanta-credit-card-statements`      | credit card statements                                    |
| Yuanta      | `npm run run:yuanta-fund-statements`             | fund holdings and transactions                            |
| Yuanta      | `npm run run:yuanta-trade-statements`            | brokerage holdings and trade records                      |
| Cathay      | `npm run run:cathay-all-statements`              | TWD and foreign-currency statements                       |
| Cathay      | `npm run run:cathay-statements`                  | TWD account statements                                    |
| Cathay      | `npm run run:cathay-foreign-statements`          | foreign-currency statements                               |
| HNCB        | `npm run run:hncb-statements`                    | TWD account statements                                    |
| CTBC        | `npm run run:ctbc-statements`                    | TWD account statements                                    |
| Post Office | `npm run run:post-statements`                    | TWD account statements                                    |
| SinoPac     | `npm run run:sinopac-statements`                 | TWD and foreign-currency statements                       |
| LINE Bank   | `npm run run:linebank-statements`                | TWD and foreign-currency statements                       |
| E-Invoice   | `npm run run:einvoice-personal-invoices`         | personal invoices and purchased items                     |
| MAX/MaiCoin | `npm run run:sync-maicoin`                       | crypto balances and statement rows                        |

## Output Format

Workflow outputs are written to `downloads/<workflow-name>/`.

Preferred output shape:

- one CSV table per exported dataset
- one matching JSON metadata file with the same timestamped basename
- rows sorted newest to oldest when the source includes time data
- no mixed metadata rows inside CSV tables

## Local Ledger

Import new downloads:

```bash
npm run run:import-downloads-csv
```

The importer writes to `data/ledger/ledger.sqlite`. Imported source files are tracked so the same download path is normally read once. Statement rows are stored in typed tables for account transactions, credit card lines, loan transactions, fund records, brokerage records, personal invoices, personal invoice items, and crypto records. Automation history is stored in `automation_task_runs` in the same database.

Personal E-Invoice CSV files are intentionally reimportable. Stable invoice and item keys upsert refreshed source fields without duplicating records, while a user's edited `personal_invoice_items.category` value is preserved. New items receive one keyword-based category: `food`, `daily`, `transport`, `shopping`, `home`, `leisure`, or `other`.

Run schema migrations directly when needed:

```bash
npm run run:migrate-ledger-db
```

## Mock Demo Ledger

Generate a local demo SQLite ledger with fake data:

```bash
npm run run:seed-mock-ledger-db
```

This rewrites `data/mock-ledger/ledger.sqlite`. The generated database includes mock rows for the dashboard's bank, foreign-currency, credit-card, loan, fund, brokerage, and MAX/MaiCoin views. `data/` is gitignored, so the generated SQLite file is not committed.

Run the desktop app with only mock data:

```bash
npm run desktop:dev:mock
```

This uses `data/mock-desktop/` as the Electron user data directory, so it does not read the normal desktop ledger in `~/Library/Application Support/OctopusBeak/`.

## MAX/MaiCoin Sync

For direct sync runs, export the required keys first:

```bash
MAX_ACCESS_KEY=...
MAX_SECRET_KEY=...
MAX_SUB_ACCOUNT=main
```

Then sync:

```bash
npm run run:sync-maicoin
```

This writes current balances, M-wallet debt, TWD values, and available trade/deposit/withdraw/transfer/reward/convert statement rows into the local ledger. To also export fetched statement rows as JSON:

```bash
npm run run:sync-maicoin -- --statement-json data/ledger/maicoin-statement.json
```

## Development

```bash
npm run typecheck
npm run build
npm run check:libretto-patch
npm run run:example
```

Useful project paths:

| Path                                                           | Purpose                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `src/workflows/`                                               | Libretto browser workflows                           |
| `src/ledger/`                                                  | importers, parsers, migrations, dashboard model code |
| `src/lib/shared-ledger/`                                       | local ledger query and account summary helpers       |
| `src/lib/assets/`, `src/lib/overview/`, `src/lib/liabilities/` | portfolio dashboard views                            |
| `src/lib/spending/`                                           | personal invoice spending model and UI               |
| `src/lib/automation/`                                          | automation panel UI and server helpers               |
| `src/lib/shared-*`                                             | shared dashboard shell, account, metric, money code  |
| `electron/`                                                    | Electron main process, runtime helpers, probes        |
| `forge.config.cjs`                                             | Electron Forge packaging and signing config          |
| `downloads/`                                                   | local statement exports                              |
| `data/ledger/`                                                 | local SQLite ledger                                  |
| `~/Library/Application Support/OctopusBeak/`                   | packaged desktop app runtime state                   |

Before sharing changes, run:

```bash
npm run privacy-check
npm run secrets-check
```
