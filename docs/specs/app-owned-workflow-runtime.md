# App-owned workflow runtime

This is the production contract for automation and the implementation baseline for new workflows. [ADR 0032](../adr/0032-app-owned-workflow-runtime.md) records the architectural decision. All 13 production task entries currently run through the desktop App's typed execution path. Provider collection code does not start its own production command or choose its own persistence route.

## Production boundary

Browser providers register a `WorkflowDefinition` with an ID, financial-commit requirement, and `run(context, input)` handler. The shared type does not currently carry a runtime input schema; each provider validates its input before browser activity. The App owns task listing, run creation, scheduling, cancellation, observation, worker supervision, and dependency construction. UI requests and scheduled starts use the same task runner. All thirteen production tasks run in App-supervised workers, including exchange rates, MaiCoin, and E-Invoice. Every browser workflow uses the same headless Chromium worker path.

`WorkflowContext` injects narrow ports for browser access, strict source-text decoding and integrity checks, human assistance, stage events, cancellation, and the existing Canonical Financial Commit. The App's browser host supplies the Playwright page. Financial workflows receive only a typed commit capability; they cannot open the financial database or select an alternate persistence route. MaiCoin uses its own injected operational-persistence port.

The executor emits typed events with a run ID, stage, code, timestamp, and optional bounded counts. Events are not reconstructed from stdout. The operational database keeps a bounded number per run and prunes events older than 30 days at startup and daily. A sanitized outcome, stable error code, and compact count summary stay with the run record; raw exception text and process output are not persisted.

Failure classification also preserves the last operation stage when a provider throws an otherwise unclassified exception: authentication timeout, interrupted login dialog, incomplete verification, authentication execution failure, or source collection failure. The worker protocol, outcome sanitizer, and App explanations use the same finite error-code vocabulary. These categories describe observed execution, not an inferred bank rejection or a new CAPTCHA retry trigger; cancellation, integrity checks, and uncertain commit outcomes retain their existing precedence. Historical `workflow-failed` records are not backfilled with guessed causes.

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

## Live source acceptance

On 2026-09-29, all eleven browser workflows completed live App runs through the typed Chromium worker path, with successful Canonical Financial Commit completion events. E-Invoice completed twice; each run committed 328 of 328 records. Yuanta Bank all-statements admitted 15 items with 186 rows and 33 captures. The run IDs below are sanitized execution identifiers; no transaction values, source files, or raw responses are retained here.

| Browser workflow | App run ID | Live result |
| --- | --- | --- |
| Taipei Fubon | `3f5cac7e-5ccf-4424-9f1e-05ed3d464d53` | Canonical commit completed |
| E.SUN | `c482afa2-3c65-40cf-bc78-fbf14c9a6bd5` | Canonical commit completed |
| Yuanta Bank all-statements | `1e774555-99a1-4d1a-8e8e-a6db06ada6e5` | Commit completed: 15 items, 186 rows, 33 captures |
| Yuanta Trade | `9c837349-29eb-47c3-b16a-d3049b2a5778` | Canonical commit completed |
| Cathay United | `747d2bcb-fb92-4898-a0c4-18bf455690c7` | Canonical commit completed |
| HNCB | `97e209c5-66f0-4461-b562-8d2d7f20558e` | Canonical commit completed |
| CTBC | `2c37a44d-9c42-4421-86a9-783e04e0fe9e` | Canonical commit completed |
| Chunghwa Post | `506fbb27-9634-4747-a0f6-d9d0bdc518c8` | Canonical commit completed |
| SinoPac | `c5ae6722-0725-4860-bdf0-782b677dc49d` | Canonical commit completed |
| LINE Bank | `68d65203-ea81-43f1-a1ff-3c765fbab28e` | Canonical commit completed |
| E-Invoice — first run | `1cc30e3d-e102-4677-a0b0-ec36ca83cec9` | Commit completed: 328 of 328 records |
| E-Invoice — repeat run | `c213ae4f-a92f-4194-b7e5-758d1c2d6444` | Commit completed: 328 of 328 records |

This table records live App evidence, not a guarantee that an external site's future behavior will remain unchanged.

On 2026-09-29, the packaged macOS arm64 App passed the local browser smoke. The packaged payload contained only the manifest-selected Chromium headless shell and FFmpeg directories. A host-Node check loaded Playwright from the packaged app root and launched the actual shell executable inside the packaged browser root; the normal packaged Electron launch then completed one fixture workflow and cancelled a second through the App worker without an injected `PLAYWRIGHT_BROWSERS_PATH`. Both runs reported profile `default` revision 1 and Chromium 151.0.7922.34 matching the live browser and navigator versions. Browser context, host page, temporary profile, and isolated user-data root were removed, and the persisted fixture records passed the sanitization check. This verifies the macOS arm64 artifact only; other OS package targets were not built.

## Source, files, and failure rules

Provider exports may arrive as browser downloads or HTTP responses, but the workflow consumes them as bounded byte streams or in-memory values. Production workflows do not save original exports, generated CSV/JSON, raw response bodies, file logs, or Libretto session telemetry. Charset handling and strict decoding go through the text port. Invalid encodings, critical replacement characters, incomplete pages, and failed source admission stop the source before Canonical Financial Commit. A commit failure receives a stable category; an ambiguous commit outcome is not replayed automatically.

The App runs production browser workflows in headless Chromium while its viewer and worker attach to the exact live page through CDP. All eleven browser workflows, including E-Invoice, use the same Chromium worker path. The App retains only validated browser cookies, encrypted with Electron safeStorage, in its dedicated browser-state directory. It never falls back to plaintext when encryption is unavailable. Each run uses a private temporary browser profile, removed when the run ends. Startup and daily cleanup remove abandoned temporary profiles for inactive tasks and retained cookies older than the default 30 days. A task that needs localStorage to preserve login may require a fresh login on its next run. The development CLI uses a temporary, non-persistent browser context and does not share App-managed authentication state.

The App defaults to the `solver` Verification Actor for challenge contracts and preserves an explicit per-source `human` setting. Fubon, Yuanta Bank, HNCB, Chunghwa Post, E-Invoice, and SinoPac text CAPTCHAs, plus Yuanta Trade audio CAPTCHA, are routed through the App-owned ten-round campaign. Each provider keeps its declared OCR, speech, confidence, and answer-shape profile; the executor injects the local solver and provider verification adapter. Solver exhaustion opens a new browser execution within the same run. A submitted answer is retried only when the provider-specific probe proves rejection. The run fails if a solver challenge has no App route; it never silently changes actor. Yuanta Trade's image-selection challenge has no supported local vision solver: solver mode fails explicitly if it appears after switching to audio, while an explicitly selected human actor may use Assist. Native ServiSign certificate selection remains an explicit assistance stage.

## Run lifecycle and scheduling

Providers that observe submission results inside the workflow return a typed CAPTCHA rejection through the existing allowlisted execution outcome. The App waits for that execution and its browser cleanup before starting the next round; it does not race a second dialog handler against the workflow. E-Invoice's explicit CAPTCHA rejection and Yuanta Bank's exact CAPTCHA alert use this path alongside SinoPac. Other authentication failures remain non-retryable. Post resolves its declared CAPTCHA input by a provider-owned selector and verifies retained text, so layout changes cannot redirect a solver answer into a sign-in identifier field. The workflow's document freshness check still applies after assistance.

One App-owned FIFO queue limits all manual, Sync all, and scheduled workflow runs to three concurrent executions. Verification waits and internal retry rounds retain a slot. Additional runs are persisted as `queued`; their browsers and workers start only after admission. Queued runs can be cancelled or force-terminated without provider activity. Shutdown stops dispatch and finalizes queued runs as interrupted, preserving the restart-from-beginning policy. No separate batch or scheduler can bypass this queue.

Cancellation and App shutdown abort active typed work. Persisted active or human-waiting runs that are abandoned at shutdown are reconciled as interrupted on the next App start; the App does not reconnect to their old browser process. A retry creates a new run from the beginning of source collection.

The App does not run schedules while closed. The current scheduled task is `exchange-rates`; after App startup its scheduler considers at most the latest missed occurrence. The exact scheduled UTC occurrence is persisted to prevent that occurrence from being launched twice, including after a restart. This is a catch-up policy for scheduled workflows, not a loop over every missed clock tick.

## Operational database baseline

The current operational schema is fresh baseline version 2. There is no runtime migration from baseline version 1: startup fails closed with a reset-required error and does not delete or transform the old database. To use v2 with a v1 local store, close the App and reset the local PGlite data directory, then let the App create a fresh baseline. Reset discards the prior contents of that PGlite directory; data must be rebuilt through the application's supported collection and sync paths.

## Development interface

Use the project-owned `npm run workflow:dev` interface described in the [workflow development guide](../agents/workflow-development.md). It loads the same provider definition as the App and injects development ports. A workflow's local financial-commit port is a dry-run, so passing it does not prove Canonical Financial Commit admission. Commands that may contact a real service require the explicit `--allow-live-source` flag. Generic Libretto `run` commands are not the workflow development contract; new workflows must implement the typed interface from the start.

## Acceptance for provider changes

Focused provider checks should exercise complete collection, strict decoding and source admission before the first commit, cancellation, stage events, and the injected Canonical Financial Commit. They should also verify that the production path creates no source, output, log, or telemetry artifacts. For in-memory exports such as HNCB, checks should cover the byte format and request/response contract using fixtures. These tests are code and fixture evidence; separately record a controlled live-site run before describing a provider as live accepted.
