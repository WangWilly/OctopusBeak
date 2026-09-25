# App-owned workflow runtime

This is the production contract for automation and the implementation baseline for new workflows. [ADR 0032](../adr/0032-app-owned-workflow-runtime.md) records the architectural decision. All 13 production task entries currently run through the desktop App's typed execution path. Provider collection code does not start its own production command or choose its own persistence route.

## Production boundary

Browser providers register a `WorkflowDefinition` with an ID, financial-commit requirement, and `run(context, input)` handler. The shared type does not currently carry a runtime input schema; each provider validates its input before browser activity. The App owns task listing, run creation, scheduling, cancellation, observation, worker supervision, and dependency construction. UI requests and scheduled starts use the same task runner.

`WorkflowContext` injects narrow ports for browser access, strict source-text decoding and integrity checks, human assistance, stage events, cancellation, and the existing Canonical Financial Commit. The App's browser host supplies the Playwright page. Financial workflows receive only a typed commit capability; they cannot open the financial database or select an alternate persistence route. MaiCoin uses its own injected operational-persistence port.

The executor emits typed events with a run ID, stage, code, timestamp, and optional bounded counts. Events are not reconstructed from stdout. The operational database keeps a bounded number per run and prunes events older than 30 days at startup and daily. A sanitized outcome, stable error code, and compact count summary stay with the run record; raw exception text and process output are not persisted.

## App task catalog

Each row is an App production task routed through the typed runtime. The eleven statement and invoice tasks use browser provider definitions and the injected Canonical Financial Commit. The exchange-rate and MaiCoin tasks use typed non-browser workflows.

| Task ID | Collection or sync path |
| --- | --- |
| `fubon-all-statements` | Taipei Fubon browser workflow |
| `esun-credit-card-statements` | E.SUN browser workflow |
| `yuanta-all-statements` | Yuanta Bank browser workflow |
| `yuanta-trade-statements` | Yuanta Trade browser workflow and external ServiSign prerequisite |
| `cathay-all-statements` | Cathay United browser workflow |
| `hncb-statements` | HNCB browser flow; bank export is consumed in memory |
| `ctbc-statements` | CTBC browser workflow |
| `post-statements` | Chunghwa Post browser workflow |
| `sinopac-statements` | SinoPac browser workflow with human verification assistance |
| `linebank-statements` | LINE Bank browser workflow |
| `einvoice-personal-invoices` | E-Invoice browser workflow |
| `exchange-rates` | Typed exchange-rate synchronization workflow |
| `sync-maicoin` | Typed MaiCoin synchronization workflow with injected persistence |

The task catalog and executor wiring establish which path the App starts; fixture tests establish behavior for the inputs they exercise. Neither proves that a bank's current live login or export page still matches those fixtures. In particular, HNCB checks use synthetic CP950/Big5 export bytes and a local HTTP/browser fixture to exercise in-memory collection, parsing, and injected commit behavior. They do not constitute a live HNCB login or export acceptance run. This document does not claim live-bank acceptance for any provider based solely on repository tests.

## Source, files, and failure rules

Provider exports may arrive as browser downloads or HTTP responses, but the workflow consumes them as bounded byte streams or in-memory values. Production workflows do not save original exports, generated CSV/JSON, raw response bodies, file logs, or Libretto session telemetry. Charset handling and strict decoding go through the text port. Invalid encodings, critical replacement characters, incomplete pages, and failed source admission stop the source before Canonical Financial Commit. A commit failure receives a stable category; an ambiguous commit outcome is not replayed automatically.

Browser authentication state may be kept in the App's dedicated browser-state directory for login continuity. Startup and daily cleanup remove inactive state older than the default 30 days. State still active in a run is not removed by cleanup. The development CLI uses a temporary, non-persistent browser context and does not share this App state directory.

## Run lifecycle and scheduling

Cancellation and App shutdown abort active typed work. Persisted active or human-waiting runs that are abandoned at shutdown are reconciled as interrupted on the next App start; the App does not reconnect to their old browser process. A retry creates a new run from the beginning of source collection.

The App does not run schedules while closed. The current scheduled task is `exchange-rates`; after App startup its scheduler considers at most the latest missed occurrence. The exact scheduled UTC occurrence is persisted to prevent that occurrence from being launched twice, including after a restart. This is a catch-up policy for scheduled workflows, not a loop over every missed clock tick.

## Operational database baseline

The current operational schema is fresh baseline version 2. There is no runtime migration from baseline version 1: startup fails closed with a reset-required error and does not delete or transform the old database. To use v2 with a v1 local store, close the App and reset the local PGlite data directory, then let the App create a fresh baseline. Reset discards the prior contents of that PGlite directory; data must be rebuilt through the application's supported collection and sync paths.

## Development interface

Use the project-owned `npm run workflow:dev` interface described in the [workflow development guide](../agents/workflow-development.md). It loads the same provider definition as the App and injects development ports. A workflow's local financial-commit port is a dry-run, so passing it does not prove Canonical Financial Commit admission. Commands that may contact a real service require the explicit `--allow-live-source` flag. Generic Libretto `run` commands are not the workflow development contract; new workflows must implement the typed interface from the start.

## Acceptance for provider changes

Focused provider checks should exercise complete collection, strict decoding and source admission before the first commit, cancellation, stage events, and the injected Canonical Financial Commit. They should also verify that the production path creates no source, output, log, or telemetry artifacts. For in-memory exports such as HNCB, checks should cover the byte format and request/response contract using fixtures. These tests are code and fixture evidence; separately record a controlled live-site run before describing a provider as live accepted.
