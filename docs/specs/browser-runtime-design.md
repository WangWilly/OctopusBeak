# Browser Runtime design interview

Status: design accepted; implementation and migration acceptance remain pending.

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

Chromium login-form visibility is not complete workflow acceptance. Authentication, CAPTCHA solving, collection, validation, commit, cancellation, worker supervision, and artifact cleanup still require verification before removing the Firefox implementation.

The App's latest E-Invoice run observed through CDP was completed under the existing Firefox route. That route uses the App main process because Firefox does not expose the Chromium CDP connection used by supervised workers.

Local unpacked browser directories measured approximately 356 MiB for full Chromium, 196 MiB for Chromium headless shell, and 282 MiB for Firefox. These are local directory sizes, not compressed installer-size estimates. The current install command installs both Chromium variants and Firefox; production Chromium launches use headless shell.

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
- Q6: require one complete App run for each of the eleven browser sources and an additional E-Invoice repeat run. A temporarily unavailable external source remains pending acceptance; fixture checks do not substitute for its live acceptance.
- Q7: run summaries retain profile ID/revision, Chromium version, and sanitized failure code, without full User-Agent, raw flags, cookies, or network responses. Existing operational event retention remains 30 days.
- Q8: the App and `workflow:dev` share Browser Runtime profile resolution and defaults. Only development mode permits headed/headless selection; live-source opt-in and dry-run financial commit remain unchanged.
- Q9: after development-App live acceptance, verify the packaged App with local fixtures for workers, bundled headless shell, profile application, cancellation, and cleanup, and confirm the absence of full Chromium/Firefox. Do not repeat all real-source logins solely for packaging acceptance.

### Round 1 — settled

All three decisions are captured above.

### Additional facts

The development `workflow:dev` CLI deliberately uses headed Chromium. Its developer runtime need does not require shipping full Chromium in the production App. Package preparation currently does not prune previously installed browser directories, so changing the install command alone would not reliably exclude leftover full Chromium or Firefox.

Browser choices currently live in the host, catalog, and execution dispatcher. The E-Invoice exception forces inline execution; routing it through the common Chromium worker requires removing this exception as well as the Firefox launch implementation.

### Round 2 — settled

All three decisions are captured above.

### Round 3 — settled

All three decisions are captured above.

### Final confirmation

The user confirmed the complete design on 2026-09-29. Production implementation may proceed under the agreed sequence below; implementation acceptance remains open until its evidence gates pass.

## Intended implementation sequence

Preserve the user's existing one-commit-per-phase requirement:

1. Record the confirmed design and vocabulary. Introduce the deep runtime module, shared defaults, controlled/versioned profiles, and diagnostic identification; wire App and developer composition through the same resolution. Retain `WorkflowBrowserPort.withPage(...)` as the provider interface and verify it through deterministic tests.
2. Move E-Invoice to Chromium headless shell and the common supervised worker path. Complete authentication, source collection, validation, and Canonical Financial Commit twice. Remove Firefox launch support and the E-Invoice inline exception after acceptance; do not keep a compatibility fallback.
3. Verify one complete App run for each remaining browser source, correcting explicit profiles if evidence requires it. Change package installation and payload selection to shell-only, document separate developer installation, and run the packaged App fixture acceptance. Remove obsolete browser-specific code, tests, documentation, and dependencies. Mark overall acceptance complete only when every required gate passes.

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
- Live App: all eleven browser sources complete collection, validation, and financial commit under the selected profile; E-Invoice completes twice. Record sanitized run outcomes as evidence without retaining source files or raw responses.
- Packaged App: confirm only the intended browser payload is included and launch the actual packaged browser through the actual worker path using local fixtures; verify profile identification, cancellation, and cleanup.
- Final repository gates: required checks, typecheck, clean temporary diagnostics, updated runtime/developer/package documentation, and phase commits. Fixture success never substitutes for an outstanding live-source gate.

## Documentation work

Update ADR 0032's Firefox exception only after a replacement has passed acceptance. Record the final architectural choice in a new ADR. Add project-specific profile terminology to `CONTEXT.md` when its meaning is agreed; general programming terms and launch implementation details do not belong in that glossary.
