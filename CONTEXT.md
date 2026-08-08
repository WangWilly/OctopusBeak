# Octopus Beak

This context covers guided first-run setup and the financial automation needed to collect, import, and review a user's data.

## Language

### Desktop Release

**Desktop application release**:
A versioned, installable OctopusBeak desktop application distributed with the platform-specific installers needed by its supported operating systems. It is distinct from publishing a reusable project package.
_Avoid_: package release, source release

**Package publication**:
Publishing a reusable project package for installation as a dependency. It is outside the desktop application release flow.
_Avoid_: desktop release, installer release

**Release source**:
The protected source line whose selected version becomes the next desktop application release. Release version changes are written back to this source before packaging.
_Avoid_: feature branch, build branch

**Release target**:
A supported operating-system and CPU-architecture combination for which the desktop application produces a distributable artifact.
_Avoid_: package target, runtime platform

**Installable artifact**:
A distributable file produced for a release target and attached to the application release.
_Avoid_: package, source archive

**Immutable release version**:
A version that, once created for release, is never rewritten or replaced as part of normal recovery. Failed packaging or publication is repaired by retrying that same version.
_Avoid_: retry version, replacement version

**Release recovery**:
The operation that resumes packaging and GitHub Release publication for an existing immutable release version after a prior release run failed. It does not change the version or create another tag.
_Avoid_: rerun bump, rollback release

**Release preflight**:
The required verification of source integrity, dependencies, code, and runtime behavior before a new release version may be created. A failed preflight produces no release version.
_Avoid_: post-release check, installer smoke test

**Staged release**:
A release that temporarily holds generated notes and installable artifacts until the complete release target build succeeds. It is not formally published until the release gate passes.
_Avoid_: unpublished version, source draft

**Artifact integrity record**:
A digest record published with installable artifacts so a recipient can verify that each downloaded file is complete and unchanged.
_Avoid_: package integrity, source checksum

### Product

**Onboarding progression**:
The guided sequence that helps a person configure a credential source, collect statements, import them, and confirm the resulting overview. It begins after the person opts in from First-run Welcome or restarts it from Settings; it may pause for human assistance and resume later.
_Avoid_: First-run Welcome, welcome screens

**First-run Welcome**:
A one-time, resumable, swipe-through introduction shown before Onboarding progression for a genuinely empty new user. Existing product data or any existing Onboarding progression state identifies an existing user and bypasses it. First-run Welcome preserves the selected language and current slide across restarts, and completes only after the person explicitly chooses whether to begin bank automation; restarting onboarding from Settings never includes it.
_Avoid_: Welcome screens, onboarding intro

**Credential setup**:
The act of enabling a credential source, entering its credentials, and choosing the statement types required before collection.

**Statement selection**:
The set of statement types chosen for an enabled credential source to collect.

**Trusted financial overview**:
A reviewable, traceable view that unifies a person's imported cash, deposits, liabilities, investments, foreign currency, crypto assets, income, spending, and statement activity across supported sources. Analysis must preserve the distinction between verified data, known gaps, and user-supplied assumptions.
_Avoid_: Dashboard, portfolio view, financial summary

**Local-first AI financial assistant**:
An assistant that lets a person use a locally available language model to explore their trusted financial overview, learn from it, and assess trends and risks with traceable external information. Product and technical boundaries—including privacy, model providers, advice, and external-information handling—are defined by an implementation-ready specification before build work begins.
_Avoid_: Cloud financial advisor, autonomous investment manager

**Personalized financial decision support**:
Evidence-backed explanation, scenario comparison, and risk identification based on a person's trusted financial overview. An unlicensed product limits this to general education, descriptive analysis, and user-directed simulations; actionable recommendations about individual securities or portfolio changes require a licensed investment-advisory route or accountable licensed partnership. It distinguishes sourced facts, model inference, uncertainty, and suggestions, and never executes trades or presents a buy-or-sell conclusion as certain.
_Avoid_: Automated investment advice, autonomous portfolio management

**Unlicensed general financial decision support**:
The first-release product route that provides financial facts, descriptive risk analysis, general education, and user-directed simulations without selecting or recommending an action on an individual security or portfolio. Licensed investment advice or an accountable licensed partnership is a later, separate product stage.
_Avoid_: Unlicensed investment advice, robo-advisor lite

**User-defined financial policy**:
A threshold, target, constraint, or scenario assumption explicitly chosen by the person. The system may calculate and explain deviations from it, but does not choose the policy, convert a simulation into an instruction, or treat a general educational benchmark as the person's target.
_Avoid_: AI-recommended allocation, inferred investment policy

**Financially neutral product revenue**:
First-release software purchase or subscription revenue that is not linked to a financial product, issuer, referral, transaction, asset ranking, or model output. Sponsored placement, transaction-linked compensation, issuer commissions, and paid product promotion are excluded.
_Avoid_: Financial-product monetization, recommendation revenue

**Paid operational value**:
The time and maintenance burden removed by reliable collection automation, model catalog management, maintained external-data access, and scheduled risk monitoring. Financial analysis and conversation are core product capabilities; payment is for dependable ongoing operations, not for a particular investment answer.
_Avoid_: Paid investment answer, advice subscription

**Fact clarification**:
A free capability that helps a person inspect, question, and understand traceable financial facts, calculations, data gaps, and evidence without turning them into an investment instruction.
_Avoid_: Financial recommendation, portfolio diagnosis

**Intent clarification**:
A free conversation that helps a person articulate and restate their own goals, constraints, time horizon, and risk concerns. The assistant does not select a goal, infer a financial policy, or translate the clarified intent into a security trade or portfolio instruction.
_Avoid_: AI-selected goal, inferred risk profile

**Licensed advice stage gate**:
The separate product stage required before any actionable personalized recommendation about an individual security or portfolio may be offered. It requires written Taiwan regulatory counsel review of actual product outputs, an investment-advisory licence or accountable licensed service provider, and the applicable suitability, disclosure, contract, complaint, recordkeeping, and algorithm-governance controls.
_Avoid_: Advice feature flag, disclaimer-based approval

**Local financial data boundary**:
The privacy boundary under which financial accounts, identifiers, transactions, and positions remain on the person's device and may be observed by an authorized local agent when relevant. Authentication secrets are never placed in agent context. Open-weight models process financial data locally; external information is brought onto the device, while outbound discovery queries are minimized and de-identified. Any future cloud-model mode is separately enabled and discloses the data sent for each use.
_Avoid_: Local-only product, anonymous financial data

**Authentication secret**:
A login password, one-time code, session token, cookie, API key, credential answer, or equivalent material that can authenticate as the person. It is never exposed to a model or agent tool, even when other financial data is locally observable.
_Avoid_: Financial account identifier, account data

**Financial context pack**:
A broad, local view of the trusted financial overview supplied so an agent can understand the person's overall situation. The agent may use authorized tools to inspect any additional non-secret financial detail relevant to a new analytical angle; authentication secrets remain excluded.
_Avoid_: Full credential context, fixed dashboard payload

**External local provider trust**:
The lower trust assigned to a separately installed local model daemon whose version, logs, updates, and model sources are not controlled by the product. It receives financial data only after explicit enablement and disclosure, only over an eligible loopback endpoint, and never receives authentication secrets.
_Avoid_: Built-in provider trust, local-equals-trusted

**Active local generation model**:
The single local model currently allowed to generate responses for the application. Switching may release the previous model and its cache from memory, but does not remove its installed artifact from storage.
_Avoid_: Installed model, downloaded model

**Installed model artifact**:
A model file retained in local storage until the person explicitly removes it. Runtime memory release, provider failure, catalog retirement, application restart, and model switching do not delete the artifact or require it to be downloaded again.
_Avoid_: Loaded model, active model

**Model catalog**:
The product-curated index of candidate, verified, deprecated, revoked, and system-provided models, including their provenance, integrity, licensing, device-fit, and lifecycle records. Membership means the model is visible and governed by the catalog; it does not by itself claim verified behavioral quality.
_Avoid_: Verified model catalog, open model registry

**Verified model artifact**:
An exact, immutable model artifact that has passed every first-release conversation, financial explanation, tool use, evidence synthesis, risk reasoning, context, safety, licensing, integrity, and runtime-compatibility gate. Verification promises complete first-release capability and belongs only to that artifact and evaluation version, not to its model family, provider, another quantization, or an externally managed copy.
_Avoid_: Verified model family, approved brand

**Catalog recommendation**:
A contextual label applied to an activatable catalog model for a particular device and user preference. It is recalculated from current evidence rather than treated as a permanent model rank or a claim of verification.
_Avoid_: Best model, universal default

**Catalog candidate**:
An exact model artifact that has passed the activation safety floor but not the complete first-release capability evaluation. It may use every first-release assistant capability after a one-time disclosure; the status limits the product's quality claim, not the model's functional access.
_Avoid_: Verified model, unsupported model

**Model activation safety floor**:
The deterministic provenance, integrity, format, runtime, host-authority, credential-boundary, and device-preflight checks required before a model artifact may be activated. It verifies App-controlled boundaries rather than model intentions and makes no claim about the model's behavioral safety or financial-assistant quality.
_Avoid_: Full model verification, quality benchmark

**Model verification record**:
A product-published record that binds an artifact hash and evaluation version to the results of the fixed complete-capability process. The first-release app consumes and presents signed records; it does not reproduce the full evaluation or grant verification from user-device results.
_Avoid_: Device benchmark result, community rating

**Catalog retirement**:
The catalog transition that stops recommending a deprecated model artifact while leaving it activatable, or prevents loading a revoked artifact because integrity, security, or licensing requires it. Retirement never deletes an installed artifact; storage removal remains the person's decision.
_Avoid_: Model deletion, automatic uninstall

**Evidence-backed current information**:
Time-sensitive market, policy, and international-event information retrieved for the current analysis with visible source, publication time, and retrieval time. Primary sources take precedence; conflicts, staleness, and missing corroboration reduce confidence or prevent a conclusion. Model training memory is not current evidence.
_Avoid_: Model knowledge, latest information

**Traceable financial computation**:
A deterministic calculation of balances, returns, allocation, cash flow, concentration, or exposure whose method and source records can be inspected. Language models may request and explain these results but do not calculate, overwrite, or become the source of financial facts.
_Avoid_: AI-calculated balance, model-derived financial fact

**Local analysis lineage**:
The on-device record needed to reproduce and inspect an analysis: financial-data snapshot time, deterministic calculation and rule versions, external-source timestamps, model and policy versions, answer or refusal, and user corrections. The person can inspect, export, and delete it; provider diagnostics exclude raw assets, transactions, positions, and complete conversations unless separately and explicitly authorized.
_Avoid_: Cloud conversation history, provider financial log

**Transparent model fallback**:
A pre-authorized switch away from the person's selected primary model only when it is unavailable, unfit for the requested capability, or prohibited by a safety gate. The product identifies the actual provider and model, explains the switch, and discloses what conversation context is transferred; it never silently substitutes an unverified model.
_Avoid_: Automatic model substitution, invisible routing

**Authorized tool request**:
A model-proposed request that the host validates against an allowlist, schema, permissions, sensitivity rules, and resource limits before any tool runs. Models and provider adapters hold no direct ledger, filesystem, network, shell, or application authority; rejected requests remain visible in local analysis lineage.
_Avoid_: Model-executed tool, provider permission

**User-directed source retrieval**:
Retrieval of a URL explicitly supplied or selected by the person, performed by the evidence layer without browser identity, financial context, or provider network authority. Retrieved content remains untrusted, is cleaned and provenance-recorded, and does not authorize following additional links or executing embedded instructions.
_Avoid_: Model web browsing, authenticated browser handoff

**Core user**:
A person in Taiwan who manages at least three bank, credit-card, or investment accounts and is tired of consolidating them manually in spreadsheets. This is the initial audience, not a permanent limit on who OctopusBeak may serve.
_Avoid_: macOS user, all personal-finance users

**Supported source**:
A financial institution or service whose data-collection and import path has been verified for the current Beta. A planned or previously working integration is not a supported source.
_Avoid_: Supported bank, available integration

**Statement run summary**:
A compact record of one automation task run's statement collection outcome, including each selected statement type's result and the overall outcome.

**External prerequisite**:
A locally installed or user-controlled dependency outside the app that must be available before an automation task can authenticate or collect data, such as a security component, browser extension, or certificate component.
_Avoid_: Credential, workflow error, generic setup

**External prerequisite recovery**:
The user-assisted sequence that restores an unavailable external prerequisite and then makes the affected automation task ready to run again.
_Avoid_: Manual login, automatic retry

**External prerequisite recovery notice**:
A persistent in-app notice attached to a failed automation task run when an external prerequisite can be restored; the affected task supplies the official download link, and the notice directs the person to run the task again after recovery. One notice exists per task and prerequisite, is updated rather than duplicated on repeated failures, and clears only after a successful retry.
_Avoid_: Toast, generic failure alert, OS notification

**External prerequisite signal**:
A structured workflow result that identifies a recoverable external prerequisite instead of requiring the automation server to infer it from an error string.
_Avoid_: Error-text classification, generic failure

**Automation session finalization**:
The act of relinquishing an owned automation session after a run, including graceful close, daemon teardown when needed, and removal of the session's ownership record.
_Avoid_: Session close (which names only the graceful close operation).

**Automation task**:
A reusable scheduled unit that can be started manually, in a batch, or as a resume.

**Automation task run**:
One persisted execution attempt of an automation task, including its output, status, and any retained session. A run waiting for human input remains that run; resuming creates a new run for the subsequent outcome.

**Automation task run finalization**:
The act of deciding an automation task run's terminal outcome, recording its result, and relinquishing or retaining its automation session.

**Automation task run finalization intent**:
The stated outcome and session disposition that guide how an automation task run is finalized.

**Automation session disposition**:
The decision to retain an automation session for human assistance or relinquish it after a task run.

**Automation task run force-quit**:
An operator-initiated action that ends a task run waiting for human input by relinquishing its exact automation session and finalizing the run as failed.

**Human verification target**:
A workflow-declared browser control or verification modal area that a person may interact with during an automation session. Each target has a workflow-owned semantic identity and current geometry for presentation and coordinate mapping. Assist permits interaction only with declared targets; unrelated viewer regions do not open a floating input and do not count as completed human assistance.
_Avoid_: Generic editable target, nearest input target

**Verification completion**:
The condition that permits an automation task to resume after human assistance. For an independent verification flow, completion requires confirmation from the workflow or host; for inline verification submitted together with login information, the available pre-submit condition is that the declared verification field is non-empty, while login success remains the final correctness check.
_Avoid_: Input has value means verification succeeded

**Verification focus view**:
A zoomed Assist presentation centered on the declared human verification target while preserving the challenge instructions, image, and surrounding context needed to solve it. A person may pan or zoom the presentation to inspect the full challenge context, but viewport manipulation is not a browser operation and only declared targets remain actionable.
_Avoid_: Full-page Assist, arbitrary zoom

**Verification context region**:
A workflow-declared visual region that must remain visible in the verification focus view so a person has the instructions, challenge, and surrounding evidence needed to complete a human verification target. The region may be visible without being actionable.
_Avoid_: Whole-page context, inferred nearest region

**Human assistance contract**:
A structured, persisted description emitted by a workflow when an automation task waits for human assistance. It declares the actionable human verification targets, the verification context regions that must remain visible, and the completion condition that governs resumption. The automation server and task-run persistence are its sole source of truth; the workflow emits structured updates and Assist only reads and presents them. A single task run may publish versioned contract updates as the verification flow changes; the contract ends when the workflow succeeds, fails, or is force-quit. Assist consumes this contract rather than inferring interaction rules from screenshots, DOM proximity, or log text.
_Avoid_: Screenshot-derived affordance, log-derived interaction contract

**Human interaction stage**:
A versioned phase of a human assistance contract with a finite allowlist of actionable targets. A stage may expose multiple explicitly declared controls within one verification modal, but controls outside the stage remain unavailable; completion transitions the task run to the next contract version or out of human assistance.
_Avoid_: Full viewer stage, unrestricted page interaction

**Verification interaction mode**:
The operation explicitly permitted for a human verification target, such as click, type, or drag. The automation server rejects operations that the current target has not declared, even if the underlying browser control could technically receive them.
_Avoid_: Generic viewer capability, inferred operation

**Human verification retry**:
The continuation of a resumed automation task run that discovers the human verification is incomplete or incorrect. The run returns to waiting for human assistance with refreshed challenge context and a new contract version, preserving the task's execution lineage instead of immediately becoming terminally failed. Retries are bounded by the workflow or external verification service; the app never retries indefinitely, and an exhausted or locked verification becomes an explicit task failure.
_Avoid_: Restarting the whole workflow, treating an incorrect answer as an ordinary infrastructure failure

**Human assistance contract resolution failure**:
A state in which the current semantic target or verification context region cannot be resolved against the live browser session. Assist remains waiting with Resume disabled, does not fall back to unrestricted page interaction, and exits only after a contract update or an explicit force-quit.
_Avoid_: Nearest-element fallback, silent target substitution

**Human verification target accessibility**:
The keyboard and pointer operation paths a declared human verification target makes available. Type targets receive focus, click targets expose equivalent keyboard activation where possible, and pointer-only drag targets require an explicit workflow declaration and user guidance.
_Avoid_: Pointer-only by accident, keyboard bypass of target rules

**Human assistance contract freshness**:
The requirement that every human interaction carries the current task run's contract version. The automation server rejects operations from a stale stage after navigation, modal changes, or contract updates, and Assist must reload the current contract before presenting another actionable target.
_Avoid_: Stale-coordinate interaction, client-only stage tracking

**Human verification input privacy**:
The boundary that keeps raw text entered into human verification targets out of the human assistance contract, task logs, and analytics. CAPTCHA, OTP, password, and other authentication material is forwarded only to the live CDP session; persisted records retain target, operation, outcome, and timing metadata without reconstructing the input.
_Avoid_: Logged verification text, replayable input screenshot

**Human verification screenshot privacy**:
The rule that challenge screenshots and verification focus views exist only in the active Assist session's memory. They are cleared when Assist closes or the browser session ends, and are never persisted in task records, logs, analytics, or user-accessible exports.
_Avoid_: Diagnostic screenshot archive, persisted challenge image

**Legacy human assistance run**:
An existing task run waiting for human input without a persisted human assistance contract. Assist does not infer its interaction rules from historical logs or expose an unrestricted viewer; it presents recovery guidance and requires force-quit followed by a new workflow run that can publish a contract.
_Avoid_: Log-based compatibility mode, unrestricted legacy Assist

**Human assistance contract API**:
The shared host boundary through which a workflow creates or updates a human assistance contract. It owns persistence, task-run association, versioning, and fail-safe validation; provider workflows supply only their verification-specific targets, context regions, interaction modes, and completion rules.
_Avoid_: Raw pause log, provider-specific persistence, UI-owned contract state

**Provider verification adapter**:
A provider-owned resolver and completion adapter that identifies the live verification controls, frames, challenge regions, allowed interaction modes, and provider-specific completion signals for a human assistance contract. The generic viewer does not infer these details from arbitrary page inputs.
_Avoid_: Generic input scanner, nearest-control heuristic

**Onboarding human verification gate**:
The rule that onboarding progression is driven by the real automation task outcome, not by local Assist interaction state. Entered text or a completed UI interaction may make Resume available according to the contract, but onboarding remains in Assist until the workflow reports successful collection.
_Avoid_: UI-interaction onboarding advance, input-nonempty milestone
