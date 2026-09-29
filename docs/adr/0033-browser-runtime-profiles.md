# Browser Runtime profiles

Status: accepted; implementation and migration acceptance remain pending.

Browser Runtime retains `WorkflowBrowserPort.withPage(...)` as its workflow-facing interface and owns launch configuration, browser lifetime, state handling, worker connection, and cleanup as a deep module. The workflow catalog selects a named Browser execution profile rather than exposing engine choices or arbitrary launch flags to provider code. All workflows share a normal Chrome User-Agent derived from the bundled Chromium version by default; a run uses one selected profile and does not silently rotate profiles on failure.

Fresh E-Invoice comparisons through the App browser module isolated the default `HeadlessChrome` User-Agent as the cause of a reproducible login-entry rejection: changing only User-Agent yielded 403/200/200/403 in interleaved default/custom/custom/default probes. The Chromium profile reaches the login form, but full authentication, collection, commit, and supervised-worker acceptance are still required before replacing ADR 0032's existing Firefox exception.

The agreed configuration, development-runtime sharing, and acceptance contract are tracked in the [design record](../specs/browser-runtime-design.md). The user confirmed the design on 2026-09-29. This ADR does not claim that source migration or live acceptance is complete.

The production desktop payload contains only Chromium headless shell; developer-headed browsing uses a separately installed full Chromium. Packaging explicitly excludes full Chromium and Firefox left by earlier installations, so runtime payload selection is deterministic rather than dependent on the developer's existing browser directory.

Profiles initially vary only observed User-Agent strategies, tested Chromium compatibility switches, and cookie retention or source-domain reset policies. Runtime invariants remain module-owned, and adding configuration requires source evidence. Acceptance includes one complete App run for every browser source and a second E-Invoice run; unavailable external sources remain pending rather than being certified through fixtures.

App and developer composition share profile resolution and defaults. Development mode may launch headed Chromium, while production always uses headless shell and supervised workers. Run summaries retain profile ID/revision, Chromium version, and sanitized error codes, without raw launch settings or browser state. After development-App source acceptance, packaged-App local fixtures verify actual worker/browser execution, profile identification, cancellation, cleanup, and payload exclusions.
