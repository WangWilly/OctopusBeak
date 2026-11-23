# The workflow socket serves only workflow operations and refuses unowned commits

Status: accepted (2026-11-23)

Amends the commit admission of [ADR 0058](0058-refused-commit-attempts-and-one-run-outcome-decision.md), which [ADR 0067](0067-workflow-execution-owns-per-execution-state.md) moved onto the Workflow execution. Narrows the PGlite child RPC of [ADR 0115](0115-a-crashed-pglite-worker-restarts-on-the-same-database.md) and [ADR 0134](0134-the-worker-core-takes-capability-ports-never-a-pglite-descriptor.md). Applies the contract marks of [ADR 0098](0098-a-financial-contract-declares-its-renderer-bridge.md) to workflows.

## Context

Workflow worker threads reach the ledger through the authenticated child socket. Before a canonical write, the socket asks whether the run's Collection scope version is still current. That check failed open in three ways:

- **An unknown run was admitted.** `collectionScopeAdmitsCommit` returned true when no active run had the request's `taskRunId`. This covers a cancelled, force-terminated, or finished run.
- **A run with no current execution was admitted.** It also returned true when the run had no current Workflow execution, or when the execution had no launched scope.
- **A request with no run identity was not checked.** The server ran the check only when the request carried a `diagnosticContext`. The only production caller always sends one, but the gate depended on an optional diagnostics field.

A thread that outlived its run could therefore still commit. Its commits could land under a source or account the person had changed since. The gate exists to prevent exactly that.

The socket also served the whole financial and operational registries. A workflow could call `financial.canonical.reset`, `financial.manualAssets.apply`, `financial.pageAction`, and any `automation.*` or `preview.*` method, including the run-lifecycle writes the host owns. The renderer already had an allowlist, `RENDERER_FINANCIAL_OPERATIONS`. Workflows had none.

## Decision

**Write admission denies by default.** The check now returns one of three answers: `admitted`, `scope-changed`, or `run-not-current`. A gated write through the child socket is refused, before it reaches the store, unless the answer is `admitted`. The answer is `run-not-current` when:

- the request names no run,
- no active run has its `taskRunId`,
- the run has no current Workflow execution, or
- the current execution was launched without a Collection scope version.

Otherwise the execution's launched scope decides, as ADR 0058 says.

Every canonical write is gated, including relation resolution. `financial.loanRelations.resolve` and `financial.investmentRelations.resolve` write a `canonical_commits` row and relation, event and settlement-group rows, so they are commits too. A workflow run resolves relations after an item commits, and treats a failure there as a warning on the committed item. A refused resolution therefore leaves the item committed with a relation warning, and the run's next commit is refused and stops the run. A canonical refusal keeps the `refused` category.

Run-scoped operational writes are gated the same way. They are `preview.write`, `maicoin.startRun`, `maicoin.appendSnapshots` and `maicoin.appendStatementRows`. Exchange rates are global, not one source's data, but `exchangeRates.upsertExchangeRates` is gated too. The exchange-rate task has no credential group, so its scope never changes and the gate only stops a run that is no longer current. The next scheduled run writes the same rates again. A refused operational write fails with a new `refused` operational code.

Two operational calls stay ungated. `maicoin.finishRun` closes the sync-run row the workflow opened. Leaving it ungated lets a refused MaiCoin run still mark that row as failed instead of leaving it open. Reads, such as `exchangeRates.readExchangeRates`, write nothing.

**A refusal records its cause.** The financial and operational RPC servers record a refusal's diagnostic as `collection-scope-changed` only when the scope changed. Every other refusal is recorded as `run-not-current`. A run-not-current refusal never reaches a person-facing outcome. Nothing reaches the run's owner for an unknown run or a request without identity. For a run with no current execution, the worker's supervisor has already settled and drops the worker's host calls, so the run does not record the refused Commit attempt. An operation the socket does not serve records `operation-not-allowed` with the operation's name.

**A commit cannot be latest-wins.** The gate runs inside the scheduled task, which a coalesced latest-wins read never runs. The contract flags' type therefore allows `workflow: "commit"` only on the interactive and background lanes.

No live run legitimately commits without a current execution:

- `createTaskRunExecution` begins the execution, with its launched scope, before the worker starts. It ends the execution in a `finally` block after `executeSupervisedAppWorkflow` returns.
- The supervisor returns only after the worker has exited or `terminate()` has settled.
- Between CAPTCHA rounds no worker runs, and each round begins its own execution.
- Startup and shutdown recovery (`finalizeOrphanedRuns`) only reads stored Commit attempts. It never commits.
- The host's own financial calls go to the worker client directly, not through the child socket.

So the change has no exception for recovery.

**A contract declares whether a workflow may call it.** A financial contract's `workflow` flag is `"call"` or `"commit"`. `"commit"` replaces `canonicalCommit: true` and also subjects the operation to write admission. An operational contract's flag is `"call"` or `"write"`, and `"write"` is gated the same way. `WORKFLOW_FINANCIAL_OPERATIONS` and `WORKFLOW_OPERATIONAL_OPERATIONS` are derived from the marks, as `RENDERER_FINANCIAL_OPERATIONS` is. The child socket builds its two servers with these sets. It refuses every other operation with a new `not-allowed` code, before the operation reaches the worker. The worker's own servers and the renderer keep the whole registry.

The workflow operations are the ones `childRpcCapabilities` and the PGlite workflow client call:

- Financial calls: `financial.overview.current`, `financial.source.admit`, `financial.tdccFundAccounts.list`, `financial.accountIdentity.continuity`.
- Financial commits: `financial.source.commit`, `financial.deposit.commit`, `financial.balance.capture`, `financial.einvoice.commit`, `financial.creditCard.commit`, `financial.creditCard.balance`, `financial.loan.commit`, `financial.investment.commit`, `financial.loanRelations.resolve`, `financial.investmentRelations.resolve`.
- Operational calls: `exchangeRates.readExchangeRates`, `maicoin.finishRun`.
- Operational writes: `exchangeRates.upsertExchangeRates`, `maicoin.startRun`, `maicoin.appendSnapshots`, `maicoin.appendStatementRows`, `preview.write`.

## Considered options

- **Keep admitting a run with no current execution, for recovery.** Rejected. Recovery does not commit, and a worker never runs outside an execution.
- **A second, hand-kept list of workflow operations in `pglite-child-rpc.ts`.** Rejected. It would drift from the contracts. A mark on the contract keeps the decision where the operation is defined, as ADR 0098 does for the renderer.
- **Refuse a disallowed operation as `invalid-request`.** Rejected. A malformed request and a request this connection never serves are different faults, and the second is a security boundary a reader should be able to find.
- **Make `isCommitAdmissible` required on the child server.** Not done. Production always passes it from `pglite-runtime.ts`. Checks and the demo seed script build ungated servers on purpose.

## Consequences

- A workflow thread whose run ended, or was superseded, cannot write canonical data, relations, preview data, MaiCoin rows or exchange rates, even if it still holds the socket. It can still mark its own MaiCoin sync-run row as finished.
- `financial.source.admit` stays ungated. It validates evidence and writes nothing canonical.
- A refused preview or MaiCoin write fails its product or run as an ordinary operational failure. It is not reported as `collection-scope-changed`, because only the canonical commit path carries a refusal to the run's outcome.
- The connection is not bound to one execution. The gate relies on the supervisor ending an execution's worker before the next execution of the same run begins. Binding the execution id to the connection is left as a follow-up.
- A new workflow operation must be marked on its contract, or the child socket refuses it. A check asserts the exact workflow surface and that every PGlite workflow command is on it.
- A workflow can no longer reset the ledger, apply a Manual asset command or a page action, read the renderer's pages, delete preview data, or write run lifecycle rows.
