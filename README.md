# Octopus Beak

Personal banking automation built on Libretto. Workflows open supported Taiwan online banking portals in a headed browser, pause for required manual steps, and save clean local statement files under `downloads/`.

Downloaded financial data, browser sessions, and credentials are sensitive local data. Do not commit or share them.

## Setup

```bash
npm install
npm run libretto:setup
cp .env.example .env
npm run typecheck
```

Fill `.env` only with the credentials needed for the workflow you run. The variable names are documented in `.env.example`.

## Running Workflows

Bank workflows usually require headed mode because CAPTCHA, OTP, email verification, or certificate selection may be required.

```bash
npm run run:fubon-all-statements
npm run run:esun-credit-card-statements
npm run run:yuanta-all-statements
npm run run:yuanta-trade-statements
npm run run:cathay-all-statements
npm run run:hncb-statements
```

When a workflow pauses, complete the requested browser step, then resume the Libretto session:

```bash
npx libretto resume --session <session-name>
```

Clean up interrupted browser sessions:

```bash
npm run libretto:close-all
```

## Supported Workflows

| Bank   | Command                                          | Output                                                    |
| ------ | ------------------------------------------------ | --------------------------------------------------------- |
| Fubon  | `npm run run:fubon-all-statements`               | deposit, credit card, loan statements                     |
| Fubon  | `npm run run:fubon-statements`                   | deposit statements                                        |
| Fubon  | `npm run run:fubon-credit-card-statements`       | credit card statements                                    |
| Fubon  | `npm run run:fubon-loan-statements`              | loan statements                                           |
| ESun   | `npm run run:esun-credit-card-statements`        | credit card statements                                    |
| YuanTa | `npm run run:yuanta-all-statements`              | TWD, foreign-currency, loan, credit card, fund statements |
| YuanTa | `npm run run:yuanta-statements`                  | TWD account statements                                    |
| YuanTa | `npm run run:yuanta-foreign-currency-statements` | foreign-currency statements                               |
| YuanTa | `npm run run:yuanta-loan-statements`             | loan statements                                           |
| YuanTa | `npm run run:yuanta-credit-card-statements`      | credit card statements                                    |
| YuanTa | `npm run run:yuanta-fund-statements`             | fund holdings and transactions                            |
| YuanTa | `npm run run:yuanta-trade-statements`            | brokerage holdings and trade records                      |
| Cathay | `npm run run:cathay-all-statements`              | TWD and foreign-currency statements                       |
| Cathay | `npm run run:cathay-statements`                  | TWD account statements                                    |
| Cathay | `npm run run:cathay-foreign-statements`          | foreign-currency statements                               |
| HNCB   | `npm run run:hncb-statements`                    | TWD account statements                                    |

## Output Shape

Workflow outputs are written to `downloads/<workflow-name>/`.

Current workflows should prefer:

- one clean CSV table per exported dataset
- a matching JSON metadata file with the same timestamped basename
- rows sorted by time from newest to oldest when the source provides time data
- no mixed metadata rows inside CSV tables

## Ledger

Import new CSV files from `downloads/` into the local SQLite ledger:

```bash
npm run run:import-downloads-csv
```

Generated files:

- `data/ledger/ledger.sqlite`

`ledger.sqlite` is the primary local ledger store. It tracks imported source files and only reads a download path once. Statement rows are stored in typed tables such as account transactions, credit card lines, loan transactions, fund records, and brokerage records. Schema changes are applied through SQLite migrations.

## Development

```bash
npm run typecheck
npm run run:example
```
