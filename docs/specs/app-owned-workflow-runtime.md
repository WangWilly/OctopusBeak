# App-owned workflow runtime: implementation contract

This is the target contract for production automation. [ADR 0032](../adr/0032-app-owned-workflow-runtime.md) records the architectural decision. Existing workflows move to this contract one at a time; the old production path is deleted after the last migration.

## Module boundary

The App owns a single **Workflow Executor** module. Its public operations are `list`, `start`, `cancel`, and `observe`; scheduling and resume decisions call `start` through the same interface as the UI. A workflow registers a typed definition with an ID, declared capabilities, input schema, and a `run(context, input)` handler. Provider modules own browser navigation, source collection, and capture construction. The executor owns worker supervision, run state, stage sequencing, cancellation, and dependency construction.

`WorkflowContext` supplies narrow ports for browser access, decoding and source-text integrity, human assistance, stage events, and Canonical Financial Commit. It also supplies a clock and cancellation signal. Financial workflows receive a typed commit capability; nonfinancial workflows do not need one. A worker uses a typed IPC adapter to reach the App-owned Canonical Financial Commit module. A workflow cannot open a financial database or choose an alternate persistence path.

Stage events have a stable run ID, stage, event code, timestamp, and bounded counts or sanitized detail. Stages include preparation, authentication, collection, decoding, validation, commit, and finalization; workflow-specific stages may extend them. Events are emitted as typed values, not parsed from stdout. The App streams them to the UI and persists them in the operational database. It keeps at most a bounded number per run and removes events older than 30 days; run outcome, error code, and compact summary remain. Event detail excludes credentials, account data, raw responses, and unredacted process output.

## Source and failure rules

Provider exports may arrive through a browser download or HTTP response, but are consumed as bounded byte streams or in-memory values without saving an original file. No production workflow writes generated CSV/JSON or a file log. Explicit source charset and strict decoding are injected through the text port. Invalid byte sequences, replacement characters in critical source fields, incomplete pages, or failed source admission stop that source before Canonical Financial Commit. The existing commit module performs financial validation and persistence after the source passes its collection preflight. A commit failure is recorded with a stable category; ambiguous commit outcomes are not automatically replayed.

Browser authentication state may be persisted where needed for login continuity. The App performs startup and periodic cleanup of state older than the default 30 days. It does not retain Libretto `logs.jsonl`, `network.jsonl`, `actions.jsonl`, or `raw-network/` from production runs. Closing the App interrupts active and human-waiting runs; on the next launch those runs are marked interrupted and can start again from the source beginning. A missed schedule produces no more than one catch-up run per workflow.

## Developer workflow

A project-owned development command loads the same typed workflow definition and injects development implementations of the ports. Its guide states how to inspect pages, run locally, supply test credentials, exercise human assistance, and verify source admission without using generic Libretto `run` commands as the workflow contract. Development-only CLI artifacts are kept separate from production user data. New workflows must implement this definition from the start.

## Migration and acceptance

Migrate each existing provider by replacing command metadata and direct file/commit helpers with the typed definition and injected ports. Include the nonbrowser exchange-rate and MaiCoin tasks in the final unified catalog. A workflow switches only after tests cover successful collection and commit, malformed text rejection before commit, cancellation, stage/error reporting, and absence of production source/output/log/telemetry files. The App does not add a compatibility adapter or migration badge. Once every task uses the new executor, remove the old command runner, per-workflow `run:*` production scripts, log-path/log-tail processing, Libretto production session plumbing, and obsolete dependencies. Retain only the documented development CLI entry.

The current App catalog has 13 migration units. Parent tasks also own their invoked statement-specific modules; migrating only the parent command entry is insufficient.

| Unit | Current collection surface |
| --- | --- |
| `fubon-all-statements` | Libretto, invokes Fubon deposit, credit card, and loan modules |
| `esun-credit-card-statements` | Libretto |
| `yuanta-all-statements` | Libretto, invokes Yuanta deposit, foreign currency, loan, credit card, and fund modules |
| `yuanta-trade-statements` | Libretto and external security component |
| `cathay-all-statements` | Libretto, invokes domestic and foreign modules |
| `hncb-statements` | Libretto, bank-provided export in memory |
| `ctbc-statements` | Libretto |
| `post-statements` | Libretto |
| `sinopac-statements` | Libretto and CAPTCHA assistance |
| `linebank-statements` | Libretto |
| `einvoice-personal-invoices` | Libretto and Canonical Financial Commit |
| `exchange-rates` | App-injected synchronization callback today |
| `sync-maicoin` | Standalone Node command today |

The first implementation slice establishes the port interfaces, strict text decoder, UTF-8 frame safety, E-Invoice commit injection seam, operational run events with 30-day cleanup, browser-state cleanup, and interrupted-run finalization. The App's exchange-rate execution now passes through the new executor, persists typed events, and has no production command in the task catalog. Its run row still carries the legacy log-path field. No browser provider has completed the production switch; legacy commands and file artifacts remain until each unit passes the acceptance checks above.
