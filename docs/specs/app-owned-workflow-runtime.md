# App-owned workflow runtime

This is the production contract for automation and the implementation baseline for new workflows. [ADR 0032](../adr/0032-app-owned-workflow-runtime.md) records the architectural decision. All 13 production task entries currently run through the desktop App's typed execution path. Provider collection code does not start its own production command or choose its own persistence route.

## Production boundary

Browser providers register a `WorkflowDefinition` with an ID, financial-commit requirement, and `run(context, input)` handler. The shared type does not currently carry a runtime input schema; each provider validates its input before browser activity. The App owns task listing, run creation, scheduling, cancellation, observation, worker supervision, and dependency construction. UI requests and scheduled starts use the same task runner. Twelve production tasks run in App-supervised workers, including exchange rates and MaiCoin. E-Invoice runs the same typed executor inside the App main process to use headless Firefox; it remains App-owned but does not gain worker process fault isolation.

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
| `sinopac-statements` | SinoPac browser workflow with App-owned CAPTCHA verification |
| `linebank-statements` | LINE Bank browser workflow |
| `einvoice-personal-invoices` | E-Invoice browser workflow |
| `exchange-rates` | Typed exchange-rate synchronization workflow |
| `sync-maicoin` | Typed MaiCoin synchronization workflow with injected persistence |

The task catalog and executor wiring establish which path the App starts; fixture tests establish behavior for the inputs they exercise. Neither proves that a bank's current live login or export page still matches those fixtures. In particular, HNCB checks use synthetic CP950/Big5 export bytes and a local HTTP/browser fixture to exercise in-memory collection, parsing, and injected commit behavior. They do not constitute a live HNCB login or export acceptance run. This document does not claim live-bank acceptance for any provider based solely on repository tests.

## Source, files, and failure rules

Provider exports may arrive as browser downloads or HTTP responses, but the workflow consumes them as bounded byte streams or in-memory values. Production workflows do not save original exports, generated CSV/JSON, raw response bodies, file logs, or Libretto session telemetry. Charset handling and strict decoding go through the text port. Invalid encodings, critical replacement characters, incomplete pages, and failed source admission stop the source before Canonical Financial Commit. A commit failure receives a stable category; an ambiguous commit outcome is not replayed automatically.

The App runs production browser workflows in headless Chromium by default while its viewer and worker attach to the exact live page through CDP. E-Invoice uses headless Firefox because its login page rejects headless Chromium in live checks; the App main process owns that page and exposes it to the same viewer without a CDP worker connection. The desktop package includes both browser engines. The App retains only validated browser cookies, encrypted with Electron safeStorage, in its dedicated browser-state directory. It never falls back to plaintext when encryption is unavailable. Each run uses a private temporary browser profile, removed when the run ends. Startup and daily cleanup remove abandoned temporary profiles for inactive tasks and retained cookies older than the default 30 days. A task that needs localStorage to preserve login may require a fresh login on its next run. The development CLI uses a temporary, non-persistent browser context and does not share App-managed authentication state.

The App defaults to the `solver` Verification Actor for challenge contracts and preserves an explicit per-source `human` setting. Fubon, Yuanta Bank, HNCB, Chunghwa Post, E-Invoice, and SinoPac text CAPTCHAs, plus Yuanta Trade audio CAPTCHA, are routed through the App-owned ten-round campaign. Each provider keeps its declared OCR, speech, confidence, and answer-shape profile; the executor injects the local solver and provider verification adapter. Solver exhaustion opens a new browser execution within the same run. A submitted answer is retried only when the provider-specific probe proves rejection. The run fails if a solver challenge has no App route; it never silently changes actor. Yuanta Trade's image-selection challenge has no supported local vision solver: solver mode fails explicitly if it appears after switching to audio, while an explicitly selected human actor may use Assist. Native ServiSign certificate selection remains an explicit assistance stage.

## Run lifecycle and scheduling

Cancellation and App shutdown abort active typed work. Persisted active or human-waiting runs that are abandoned at shutdown are reconciled as interrupted on the next App start; the App does not reconnect to their old browser process. A retry creates a new run from the beginning of source collection.

The App does not run schedules while closed. The current scheduled task is `exchange-rates`; after App startup its scheduler considers at most the latest missed occurrence. The exact scheduled UTC occurrence is persisted to prevent that occurrence from being launched twice, including after a restart. This is a catch-up policy for scheduled workflows, not a loop over every missed clock tick.

## Operational database baseline

The current operational schema is fresh baseline version 2. There is no runtime migration from baseline version 1: startup fails closed with a reset-required error and does not delete or transform the old database. To use v2 with a v1 local store, close the App and reset the local PGlite data directory, then let the App create a fresh baseline. Reset discards the prior contents of that PGlite directory; data must be rebuilt through the application's supported collection and sync paths.

## Development interface

Use the project-owned `npm run workflow:dev` interface described in the [workflow development guide](../agents/workflow-development.md). It loads the same provider definition as the App and injects development ports. A workflow's local financial-commit port is a dry-run, so passing it does not prove Canonical Financial Commit admission. Commands that may contact a real service require the explicit `--allow-live-source` flag. Generic Libretto `run` commands are not the workflow development contract; new workflows must implement the typed interface from the start.

## Acceptance for provider changes

Focused provider checks should exercise complete collection, strict decoding and source admission before the first commit, cancellation, stage events, and the injected Canonical Financial Commit. They should also verify that the production path creates no source, output, log, or telemetry artifacts. For in-memory exports such as HNCB, checks should cover the byte format and request/response contract using fixtures. These tests are code and fixture evidence; separately record a controlled live-site run before describing a provider as live accepted.
