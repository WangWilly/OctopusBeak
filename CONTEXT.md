# Octopus Beak

This context covers guided first-run setup and the financial automation needed to collect, import, and review a user's data.

## Language

**Onboarding progression**:
The guided sequence that helps a new user configure a credential source, collect statements, import them, and confirm the resulting overview. It may pause for human assistance and resume later.

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
A post-MVP trust boundary for a separately installed local model daemon whose version, logs, updates, and model sources are not controlled by the product. The first release does not connect to external loopback providers; externally obtained artifacts run only through the App-owned embedded helper.
_Avoid_: Built-in provider trust, local-equals-trusted

**App-owned model helper**:
The signed embedded process that loads App-managed GGUF artifacts with no Authentication secrets, tool authority, or renderer-visible endpoint, and may retain one Warm local model. Its crash makes the current run terminal and clears warm state; it is recreated only when the person starts a new run.
_Avoid_: External local provider, autonomous agent process, background respawn

**Active local generation model**:
The single local model currently allowed to generate responses for the application. Switching may release the previous model and its cache from memory, but does not remove its installed artifact from storage.
_Avoid_: Installed model, downloaded model

**Warm local model**:
The one model runtime that may remain loaded while the application is open after its run authority and all conversation, checkpoint, and tool context have been cleared. It has no idle timeout and unloads only for application quit, memory pressure, revocation, helper failure, or an explicit model change.
_Avoid_: Active run, retained conversation, background agent

**Installed model artifact**:
A model file retained under an exact immutable identity until the person explicitly removes it. New revisions install side by side; runtime memory release, provider failure, catalog retirement, application restart, model switching, and suspended-run resumption neither replace nor delete the bound artifact.
_Avoid_: Loaded model, active model

**Model artifact staging**:
The Application Support intake and temporary storage for a download or user-placed import that has not passed artifact identity, compatibility, device-fit, and isolated-load gates. Staged files are not App-managed Installed model artifacts; only an atomic promotion after validation transfers management to the App.
_Avoid_: Installed model, partial installation

**Model artifact removal**:
The person's explicit deletion of an App-managed Installed model artifact after any Warm local model is unloaded and no active run uses it. Removing an artifact bound to a suspended run requires confirmation and makes that run terminal; failed removal leaves the artifact installed.
_Avoid_: Automatic cleanup, catalog retirement, runtime unload

**User-imported model artifact**:
An externally obtained GGUF file loaded only through the App-owned embedded helper after its hash identity, bundled-runtime compatibility, device fit, isolated load, and user attestation of local-use rights are recorded. Any quantization the bundled helper can trial-load may use the full host-gated assistant capabilities after disclosure, but its provenance remains unverified, it never becomes a catalog candidate, verified artifact, or recommendation, and no attestation can bypass a failed activation or revocation gate.
_Avoid_: External provider model, catalog candidate, trusted local model

**System-provided model**:
An OS-managed generation model with availability and provider identity but no App-owned artifact to download, hash, install, update, or remove. A measured OS build may carry verified provider evidence; another available build remains usable only with an unverified-build warning and never becomes a Verified model artifact.
_Avoid_: Installed model artifact, Apple model file, verified system artifact

**Model catalog**:
The product-curated index of candidate, verified, deprecated, revoked, and system-provided models, including their provenance, integrity, licensing, device-fit, and lifecycle records. In the first release its authority is the catalog bundled with the signed application release, so catalog changes and emergency revocations require another application release; membership alone does not claim verified behavioral quality.
_Avoid_: Verified model catalog, open model registry

**Catalog model artifact**:
An exact immutable artifact identity listed by the bundled Model catalog with its revision, byte size, hash, licensing/provenance record, and optional pinned upstream locator. Bytes obtained through any channel are the same catalog artifact only when that exact identity matches; a different hash is a User-imported model artifact.
_Avoid_: Catalog download, model family, similar quantization

**Verified model artifact**:
An exact, immutable model artifact that has passed every first-release conversation, financial explanation, tool use, evidence synthesis, risk reasoning, context, safety, licensing, integrity, and runtime-compatibility gate. Verification promises complete first-release capability and belongs only to that artifact and evaluation version, not to its model family, provider, another quantization, or an externally managed copy.
_Avoid_: Verified model family, approved brand

**Supported system model**:
An operating-system-managed model that has passed the first-release behavioral, tool, cancellation, recovery, and fallback gates through its public provider API even though the product cannot pin or inspect its underlying artifact. Its support identity is the OS build, provider API, availability gate, device tier, and benchmark version; unavailable performance or memory counters are recorded as provider limitations rather than invented artifact evidence.
_Avoid_: Verified model artifact, built-in model file, unversioned system AI

**Catalog recommendation**:
A contextual label applied to an activatable catalog model for a particular device and user preference. It may seed the person's first selection but never changes an existing selection, downloads or loads a model, or substitutes for an unavailable model; it is not a permanent rank or verification claim.
_Avoid_: Best model, universal default

**Catalog candidate**:
An exact model artifact that has passed the activation safety floor but not the complete first-release capability evaluation. It may use every first-release assistant capability after a one-time disclosure; the status limits the product's quality claim, not the model's functional access.
_Avoid_: Verified model, unsupported model

**Model activation safety floor**:
The deterministic provenance status, full cold-load integrity check, format/runtime compatibility, host-authority, credential-boundary, and device-preflight checks required before a model artifact may be activated. It verifies App-controlled boundaries rather than model intentions and makes no claim about the model's behavioral safety or financial-assistant quality.
_Avoid_: Full model verification, quality benchmark

**Model activation disclosure**:
The person's one-time acknowledgement of the exact identity and limited assurance of a catalog candidate, User-imported model artifact, or System-provided model on an unmeasured OS build. Its persistent status badge remains visible, and the acknowledgement expires when the artifact hash, helper version, OS build, or disclosure version changes; revocation and failed safety gates are never overridable.
_Avoid_: Risk-warning bypass, verification consent, repeated modal

**Model verification record**:
A product-published record that binds an artifact hash and evaluation version to the results of the fixed complete-capability process. The first-release app consumes and presents signed records; it does not reproduce the full evaluation or grant verification from user-device results.
_Avoid_: Device benchmark result, community rating

**Model compatibility record**:
A local activation result bound to an exact artifact hash, embedded-helper runtime version, and device class. It is invalidated by helper or device change and may be recreated lazily, but it never grants catalog verification or permits removal of the artifact after a failed recheck.
_Avoid_: Model verification record, permanent compatibility

**Catalog retirement**:
The catalog transition that stops recommending a deprecated model artifact while leaving it activatable, or permanently prohibits an exact revoked hash—including a matching user import—because integrity, security, or licensing requires it. A locally observed revocation survives application downgrade and invalidates suspended-run resumption, but never deletes the installed artifact; storage removal remains the person's decision.
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

**Agent support diagnostics**:
A user-controlled local projection of agent lifecycle metadata for developer troubleshooting, including provider/model identity, transition reason, checkpoint validity, and Authorized tool execution outcomes. It stays outside the main assistant view, is never uploaded without explicit export, can be deleted by the person, and fails export when its allowlist/redaction gate cannot exclude Authentication secrets, raw financial data, complete conversations, and executable authority.
_Avoid_: Main-screen debug panel, provider telemetry, raw agent log

**Transparent model fallback**:
A post-MVP, pre-authorized switch away from the person's selected primary model only when it is unavailable, unfit for the requested capability, or prohibited by a safety gate. The first release never substitutes a model within the same run: primary-model failure is terminal, and choosing another model starts a new run without transferring the failed run's checkpoint or conversation context.
_Avoid_: Automatic model substitution, invisible routing

**Agent run suspension**:
A non-terminal interruption of an agent run that may resume only from a valid safe checkpoint. User pause, orderly application shutdown, and recoverable memory pressure may suspend a run; memory pressure unloads the Active local generation model without deleting its Installed model artifact and never reloads it in the background.
_Avoid_: Cancellation, terminal stop

**Agent run resumption**:
The person's explicit continuation of a suspended agent run from its Agent safe checkpoint using the same provider, exact model artifact, disclosure/policy versions, and authorized data classes. Application restart may restore the option to resume but never loads the model or continues generation automatically; any authorization-boundary change makes the old run terminal and requires consent in a new run.
_Avoid_: Automatic startup recovery, retry, fallback

**Agent run cancellation**:
A terminal end of an agent run explicitly cancelled by the person: generation and new tool dispatch stop immediately, while an already-dispatched tool gets bounded time to record a durable outcome solely for lineage and diagnostics. A cancelled run never consumes that result or resumes; a later attempt is a new run with its own lineage.
_Avoid_: Pause, resumable cancellation

**Agent safe checkpoint**:
A versioned, integrity-validated, Authentication-secret-free snapshot created only while no Authorized tool request is in flight. It contains host-owned canonical conversation state, immutable financial/tool-result references, durable tool outcomes, and run lineage/version identity—but no provider runtime memory, execution authority, or partial generation—and is the sole state from which the same run may resume.
_Avoid_: Conversation backup, raw provider state, best-effort recovery state

**Agent run retry**:
A new agent run started after a terminal run, optionally with a different selected model. It has new lineage and does not inherit the terminal run's checkpoint or conversation context.
_Avoid_: Resume, fallback, terminal-run revival

**Agent run terminal failure**:
The unrecoverable end of an agent run caused by helper crash, provider unavailability, model unfitness or prohibition, invalid checkpoint, or an unexpected Authorized tool execution outcome that is unknown outside explicit cancellation settlement. A terminally failed run never resumes; a later attempt is an Agent run retry.
_Avoid_: Recoverable failure, automatic helper restart, failed-run resume

**Authorized tool request**:
A model-proposed request that the host validates against an allowlist, schema, permissions, sensitivity rules, and resource limits before any tool runs. Models and provider adapters hold no direct ledger, filesystem, network, shell, or application authority; rejected requests remain visible in local analysis lineage.
_Avoid_: Model-executed tool, provider permission

**Authorized tool execution outcome**:
The host-owned durable status of an Authorized tool request: not dispatched, completed with a persisted validated result, or outcome unknown after dispatch without durable completion. Recovery may revalidate a request not yet dispatched or replay a completed result, but an unknown outcome makes the agent run terminal and is never guessed or automatically repeated.
_Avoid_: Provider tool state, assumed tool success, blind retry

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
