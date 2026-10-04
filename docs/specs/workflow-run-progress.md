# Workflow run progress

Status: Current. This presentation contract complements the [App-owned workflow runtime](app-owned-workflow-runtime.md), which remains authoritative for execution, typed events, product outcomes, and finalization.

## Progress presentation

Each Automation task shows progress for its own run. A new run starts at zero; queued work does not appear to be executing. While a run is active, the bar reflects structured workflow stages and uses a localized work label. When stage metadata identifies a selected statement type, the label includes that product; collection metadata distinguishes querying from downloading. The renderer does not derive labels from raw event text.

The percentage is an approximate indication of stage advancement, not elapsed time or remaining duration. Product work is projected across an approximate 18–90% band, weighted by selected product and stage; generic workflow boundaries use coarse values from preparation through commit. Event counts refine a stage only when a meaningful total is available. Time alone never advances progress. Within a run, progress is monotonic and nonterminal work is capped below 100%; only a successfully classified completed outcome reaches 100%.

The bar animates while work is active, including automatic verification. Manual assistance waits keep the last percentage and stop the animation until work resumes. Failed, cancelled, interrupted, and partial outcomes keep their last percentage and stop animating. Partial runs retain the existing product outcome list so successful and failed products remain identifiable. Existing exchange-rate progress remains supported.

The bar exposes `role="progressbar"`, its numeric value when known, and localized stage/status text through `aria-valuetext`. Reduced-motion preferences disable the active sweep animation. Progress and labels are localized in English and Traditional Chinese.

## Verification evidence and limits

The implementation is covered by workflow progress projection, runtime synchronization, page-model, and Automation dashboard checks, plus repository typecheck and build. Electron CDP inspection confirmed the Automation screen renders with non-overlapping wrapped table headers in an isolated fixture. Synthetic runtime snapshots could not be injected into the live renderer: the Playwright Electron harness timed out before opening a renderer window, so stage-by-stage visual acceptance remains unverified. No provider workflow was run for this inspection.
