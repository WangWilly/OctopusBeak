# Browser Runtime design interview

Status: design accepted; App implementation and live source acceptance complete; packaged App acceptance pending.

## Requested outcome

- Make Browser Runtime a deep module with a small interface for workflow callers.
- Supply a dependable default Chromium configuration and support explicit source-specific settings.
- Correct the E-Invoice Chromium login-entry failure identified by comparison with `main`.
- Reduce the desktop browser payload and remove unnecessary browser execution paths.
- Preserve headless execution, injected verification and Canonical Financial Commit, bounded events, and the existing state-retention rules.

The existing workflow-facing seam is `WorkflowBrowserPort.withPage(...)`. Browser configuration, browser lifetime, worker connection, state handling, and cleanup should have locality inside Browser Runtime rather than spread across provider definitions and the executor.

## Observed evidence — 2026-09-29

`main` uses Libretto 0.6.45 with Playwright 1.62.1. The installed comparison runtime and the current lockfile use the same Playwright version. Main's Libretto launcher explicitly configures a Chrome 143 User-Agent, the `AutomationControlled` flag, and a non-persistent browser context. The App's Chromium launcher uses a persistent context without an explicit User-Agent.

Fresh, credential-free E-Invoice login-entry probes produced:

| Configuration | Result |
| --- | --- |
| App Chromium defaults | HTTP 403; no login form |
| App defaults plus CTBC's Chromium flag | HTTP 403; no login form |
| App persistent context plus the flag and main's User-Agent | HTTP 200; login form present, twice |
| Main's launch configuration | HTTP 200; login form present, twice |
| Main's launch configuration without explicit User-Agent | HTTP 403; no login form, twice |
| Current Chromium version with `Chrome` instead of `HeadlessChrome` in the User-Agent; no CTBC flag | HTTP 200; login form present, twice |

The final comparison crossed the real App browser module and changed only User-Agent, with all contexts fresh. Interleaved default/custom/custom/default runs returned 403/200/200/403. The normal Chrome User-Agent retained the actual Chromium 151 version. This establishes the configuration difference responsible for this reproducible entry failure; it does not reveal the remote challenge system's internal policy.

### Pre-migration inspection — 2026-09-29

Before the migration, the latest E-Invoice run observed through CDP completed under the inline Firefox route. Firefox did not expose the Chromium CDP connection used by supervised workers, which is why E-Invoice was temporarily owned by the App main process. The old installer also installed full Chromium, headless shell, and Firefox; this was the pre-migration package state, not the final architecture.

After correcting the default User-Agent and completing the shared Chromium worker path, all eleven browser workflows passed live App collection, validation, and Canonical Financial Commit. E-Invoice passed twice, with both runs committing 328 of 328 records. Sanitized run IDs and outcomes are in the [live source acceptance table](app-owned-workflow-runtime.md#live-source-acceptance). Packaged-App payload and worker-fixture acceptance remain pending.

E-Invoice now uses the common headless Chromium worker and its CDP viewer path. The earlier Firefox route and inline main-process exception have been removed after live acceptance.

Local unpacked browser directories measured approximately 356 MiB for full Chromium, 196 MiB for Chromium headless shell, and 282 MiB for Firefox. These are local directory sizes, not compressed installer-size estimates. The production browser installer now requests Chromium headless shell only and prunes stale local full-Chromium and Firefox payloads; an actual packaged-App build and worker fixture smoke remain to verify the shipped contents.

## Design tree

### Settled constraints

- Formal workflow execution is App-owned and headless.
- Provider code receives browser access through an injected interface.
- Source data remains in memory, with existing validation before financial commit.
- No source files, raw responses, or file logs are added by this design.
- CAPTCHA solver selection and finite retry contracts remain source-owned and explicit.
- Q1: all browser workflows share a normal Chrome User-Agent derived from the actual bundled Chromium version; source-specific differences are explicit. Headless execution remains mandatory. Verify existing sources after changing this default.
- Q2: the workflow catalog selects a named Browser execution profile. Browser Runtime owns its controlled settings; provider code does not receive arbitrary flags, engine selection, or launch functions.
- Q3: a run uses its selected profile and fails explicitly for an unsupported source-access challenge or incompatible configuration. It does not automatically rotate profiles or User-Agents. Existing declared CAPTCHA retry contracts remain unchanged.
- Q4: the production App ships only Chromium headless shell. Full Chromium is installed separately for developer use. Packaging explicitly excludes leftover full Chromium and Firefox directories rather than relying only on the installation command.
- Q5: initially support only observed User-Agent strategies, tested Chromium compatibility switches, and cookie retention/source-domain reset policies. New source needs require evidence before extending the controlled settings. Headless execution, the single engine, artifact restrictions, and worker supervision remain module-owned invariants.
- Q6: require one complete App run for each of the eleven browser sources and an additional E-Invoice repeat run. This live gate passed on 2026-09-29; fixture checks remain separate from live acceptance.
- Q7: run summaries retain profile ID/revision, Chromium version, and sanitized failure code, without full User-Agent, raw flags, cookies, or network responses. Existing operational event retention remains 30 days.
- Q8: the App and `workflow:dev` share Browser Runtime profile resolution and defaults. Only development mode permits headed/headless selection; live-source opt-in and dry-run financial commit remain unchanged.
- Q9: after development-App live acceptance, verify the packaged App with local fixtures for workers, bundled headless shell, profile application, cancellation, and cleanup, and confirm the absence of full Chromium/Firefox. This package gate remains pending. Do not repeat all real-source logins solely for packaging acceptance.

### Round 1 — settled

All three decisions are captured above.

### Pre-migration additional facts — 2026-09-29

The development `workflow:dev` CLI deliberately uses headed Chromium. Its developer runtime need does not require shipping full Chromium in the production App. Before this migration, package preparation did not prune previously installed browser directories, so changing the install command alone would not reliably exclude leftover full Chromium or Firefox.

Before this migration, browser choices lived in the host, catalog, and execution dispatcher. The E-Invoice exception forced inline execution; routing it through the common Chromium worker required removing this exception as well as the Firefox launch implementation.

### Round 2 — settled

All three decisions are captured above.

### Round 3 — settled

All three decisions are captured above.

### Final confirmation

The user confirmed the complete design on 2026-09-29. The App implementation and all required live source runs completed on 2026-09-29. Packaged-App acceptance remains open until the actual package contains only the selected browser payload and passes the local worker fixture.

## Intended implementation sequence

Preserve the user's existing one-commit-per-phase requirement:

1. **Complete.** Record the confirmed design and vocabulary; introduce the deep runtime module, shared defaults, controlled/versioned profiles, and diagnostic identification; wire App and developer composition through the same resolution. Retain `WorkflowBrowserPort.withPage(...)` as the provider interface and verify it through deterministic tests.
2. **Complete.** E-Invoice uses Chromium headless shell and the common supervised worker path. Two complete live runs passed authentication, source collection, validation, and Canonical Financial Commit; Firefox launch support and the inline E-Invoice exception were removed without a compatibility fallback.
3. **Live-source portion complete; packaging pending.** All eleven browser sources passed a complete App run. The shell-only installer and deterministic payload exclusions are implemented, separate developer installation is documented, and the packaged App fixture harness is ready. Build the actual package and run the worker/profile/cancellation/cleanup fixture before marking overall acceptance complete.

No runtime fallback to an alternative engine or profile is introduced during migration. Source access failures remain explicit; an unavailable external source is reported and left pending acceptance.

## Reviewable target interface and ownership

- Provider interface: the injected `WorkflowBrowserPort.withPage(run)` remains unchanged. Workflows do not learn browser launch options or process strategy.
- Composition interface: App and development composition select an execution mode and optional named Browser execution profile. The default is automatic; production mode always launches headlessly.
- Profile declaration: each module-owned profile has an ID and revision. Initial declarations cover the shared normal Chrome User-Agent strategy, existing CTBC compatibility switch, and existing cookie reuse/source-domain reset differences. The catalog names a profile; it does not embed flags or a custom launcher.
- Runtime implementation: resolve the bundled browser and its actual version, apply platform-appropriate normal Chrome User-Agent, resolve controlled profile settings, create one owned browser context, restore permitted encrypted cookies, provide the exact worker/viewer page, propagate cancellation, and clean up run-scoped state. Deriving User-Agent must not pin a historical browser version or launch a separate probe browser on every run.
- Test injection: launch/version resolution dependencies belong inside the runtime module's composition/test seam; provider definitions never receive them. Tests cross the same runtime interface used by App/development callers.
- Configuration errors: reject an unknown profile or unsupported setting before source activity with a stable sanitized error. Profile access failure never triggers implicit setting rotation.
- Diagnostics: associate profile ID/revision and Chromium version with the run summary, including failed runs where the information is available. Store no raw launch settings or browser state. Diagnostic persistence uses the existing operational store, not new file logs.
- Packaging: select headless shell and required runtime support assets deterministically; merely stopping future downloads does not remove existing unwanted directories. Developer browser installs do not widen the packaged production payload.

## Acceptance evidence

- Deterministic checks: profile/default resolution, User-Agent version derivation, supported overrides, configuration rejection, cookie-domain isolation, identical App/developer resolution, worker/viewer ownership, cancellation, and cleanup.
- Live App: all eleven browser sources completed collection, validation, and financial commit under the selected profile; E-Invoice completed twice, with 328 of 328 records committed in each run. See the [sanitized run table](app-owned-workflow-runtime.md#live-source-acceptance).
- Packaged App: confirm only the intended browser payload is included and launch the actual packaged browser through the actual worker path using local fixtures; verify profile identification, cancellation, and cleanup.
- Final repository gates: required checks, typecheck, clean temporary diagnostics, updated runtime/developer/package documentation, and phase commits. Fixture success never substitutes for an outstanding live-source gate.

## Documentation work

ADR 0032's Firefox exception was removed after the replacement passed live acceptance. This decision is recorded in ADR 0033, and the agreed profile terminology is in `CONTEXT.md`; the packaged-App gate remains pending.
