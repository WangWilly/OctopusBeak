# Exchange-rate sync is a capability workflow

Status: accepted; supersedes the exchange-rate parts of [ADR 0072](0072-host-calls-go-through-one-contract-table.md)

The exchange-rate sync is a short nonbrowser workflow: it reads which currencies the current history needs, then fetches and stores their rates. It still had paths of its own in five generic modules:

- **The worker built its service by workflow ID.** `app-workflow-worker-runtime.ts` compared `workflowId === "exchange-rates"`, built the sync service from the child RPC, and passed it to the registry. The registry's `definitionForDependencies` existed only for this workflow, and a placeholder service stood in when it was absent.
- **Its progress had a second channel.** The service reported `load-request`, `sync` and `complete` through the `exchangeRateProgress` host call. `reportsExchangeRateProgress` let task-run execution pass a handler, and `appendExchangeRateProgress` wrote the percent. The workflow also sent a run event for each report, so two writers updated the same progress, and the larger percent won. The UI shows only `workflow-*` phase codes, so the exchange-rate phase codes were never displayed.

ADR 0072 rejected making exchange-rate progress a capability, because the service was a dependency the registry had to inject before the definition existed. That premise held only while the service was built outside the executor.

**What the sync reads and writes is the `exchangeRates` capability port.** `WORKFLOW_CAPABILITIES` declares it beside `financialCommit` and `tdcc`, with the flag `requiresExchangeRates`, and `childRpcCapabilityPorts` (now `childRpcCapabilities`, [ADR 0134](0134-the-worker-core-takes-capability-ports-never-a-pglite-descriptor.md)) serves it as the rate persistence plus `overviewCurrent()`. The workflow is declared with `defineWorkflow`, so only a definition that requires the port can use it, and the executor refuses to start a run that lacks it. The definition no longer depends on anything outside the port, so the registry holds one fixed definition and the worker resolves it like any other.

**Progress is the run's own events.** The workflow sends one `collection` `progress-update` event per step, with `completed` of 0, 1 and 3 and `total` 3, and `projectWorkflowRunProgress` turns them into progress like any other workflow's. The `exchangeRateProgress` host call and its contract are gone.

## Considered options

- **Keep the service, and only route its progress through run events.** Rejected. It would leave the workflow-ID check and the registry seam, which exist only to build the service.
- **Keep a progress callback on the service.** Rejected. The service had one caller. With its three steps inside the workflow, the workflow sends the events directly.

## Consequences

- During a sync the progress reads 23, 31 and then 47 percent, and 100 when the run completes, instead of 0, 33 and 99. The phase code is `workflow-collection` throughout. The sync usually finishes in under a second.
- `HOST_CALL_CONTRACTS` declares five calls instead of six.
- `appWorkflowRegistration` and the worker's `resolveDefinition` test seam take only a workflow ID.
