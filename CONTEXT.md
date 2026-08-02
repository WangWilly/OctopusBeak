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
