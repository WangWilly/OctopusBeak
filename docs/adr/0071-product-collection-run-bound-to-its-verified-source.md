# The Product collection run is bound to its Verified source

Status: accepted

Completes [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md). Applies [ADR 0063](0063-product-collection-run-stages-every-item.md) and [ADR 0064](0064-product-collection-run-commits-and-decides-source-only.md).

ADR 0057 put every per-source fact on the Verified Source definition, but each of the ten product-collecting workflows still restated three of them when it called `collectSelectedProducts`: the provider (the definition's `integrationNamespace`), the product ids (its `statementSelection.products`) and the selection. Each also copied `signal`, `event`, `productFailure` and `financialCommit` from its context field by field. The copies had drifted: HNCB spread `productFailure` conditionally while Post passed it through, and Post, CTBC, LINE Bank and Yuanta-trade ignored the Statement Selection that the settings page showed and saved. Thirty commits in six weeks swept four or more of these workflows at once.

**The executor hands the workflow a bound run.** A verified workflow declares `requiresProductCollection: true`. The registry then puts the source's provider and Statement Selection products on its `WorkflowDefinition`, and the executor builds `context.products` from them, the run input, and the context's own ports. The workflow calls `context.products.collect({ deposit: … }, { assertSession, attached })` and supplies only one collector per product, its session check, and its attached preview collectors.

- **The selection comes from the run input.** The run selects the input's `statementTypes` among the source's products, and its `attachedPreviewProducts` among the source's attached products. Every product-collecting source reads its Statement Selection; an empty verified selection is allowed only when attached products are selected.
- **The collectors must match the source's products.** A missing or extra collector, or a selected id the source does not offer, fails the run with `workflow-failed` before any product runs.
- **The staged provider is the source's `integrationNamespace`.** A product-level `integrationNamespace`, such as Yuanta's `yuanta-fund`, keeps naming only the canonical reset scope.
- **The workflow keeps its page, sign-in, input parsing and run result.** It still parses its own input, reports `input-validated`, and calls `productRunResult` with the counts only it knows.
- **The context member is a capability.** `context.products` is typed present only for a definition that requires it, as `financialCommit` is, and the executor fails closed when the definition lacks its source facts.

## Considered options

- **One callback per run, `collect((typeId, product) => …)`.** Rejected. Each multi-product workflow then branches on `typeId` itself, and a missing branch is not caught before the run starts.
- **Infer the product ids' type from the definition through `verifiedWorkflow` and `WorkflowContext` generics.** Rejected. It types every context by its source for a check the run already makes before any product runs, and that a registry invariant check pins.
- **Migrate two or three workflows first and the rest later.** Rejected. Both call shapes would live on `main`, and the next sweep would have to handle both.
- **Stamp a product-level `integrationNamespace` as that product's provider.** Rejected. It changes the identity of items already admitted under the source's provider, which is a data migration, not a deepening.
- **Move input parsing and `productRunResult` into the executor as well.** Deferred. Input schemas differ in refinements, and run counts are often known only after a collector runs.

## Consequences

- `collectSelectedProducts` stays as the bound run's internal seam, tested directly by `product-collection.check.ts`. TDCC's workflow is the one exception that still calls it: it sizes its TDCC run summary from the selection before any product runs, so binding it would derive the selection twice. A registry check pins TDCC as the only source with a Statement Selection outside the bound run.
- Post, CTBC, LINE Bank and Yuanta-trade now read their Statement Selection. A person who clears the only product is asked to finish setup instead of having it collected anyway. Their run input now carries `statementTypes`, so run progress is projected per product for them as it already was for the other sources.
- The `statementTypes` defaults in the SinoPac, HNCB and E.SUN input schemas are gone; the registry always supplies the selection, and a default would disagree with the run. Cathay's legacy `foreign` alias is gone for the same reason: the run reads the raw input, so a schema transform would disagree with it.
- Checks that matched `financialCommit: context.financialCommit` in workflow source text are deleted; `workflow-executor.check.ts` checks the binding through `context.products`.
