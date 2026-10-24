# The Product collection run owns every verified product outcome

Status: accepted

Revisits one rejected option of [ADR 0056](0056-commit-attempt-is-the-authority-for-commit-outcome.md) and applies [ADR 0058](0058-refused-commit-attempts-and-one-run-outcome-decision.md) to every verified workflow.

## Context

Only Cathay, Fubon and Yuanta ran their products through `collectSelectedProducts`. SinoPac, HNCB and E.SUN each wrote their single verified product's outcome by hand and passed it to `finishAttachedProductRun`. CTBC, LINE Bank, Post and Yuanta trade wrote no product outcome at all. The hand-written paths disagreed:

- A recoverable verified failure stopped SinoPac and HNCB before their Attached Preview Products ran. E.SUN caught the same failure and carried on.
- All seven turned a returned commit result that was not `completed` into a plain thrown error. A refused write never became `collection-scope-changed`, and a returned cancellation never became `cancelled`. ADR 0058's rule that a refusal stops every later product held only inside `collectSelectedProducts`, so E.SUN still ran its attached products after a refusal.
- E.SUN classified its own failure by buffering run events and calling the host's failure classifier from inside the workflow.

Each sweep across the run conventions (Commit attempts, run event outcomes) edited the same seven workflows by hand.

ADR 0056 rejected moving every workflow onto selected-product collection, because the seam it fixed was commit outcome and the move was far larger than that seam. The Commit attempt now owns commit outcome. The seam here is the product outcome and when a run stops, which is what the Product collection run already owns.

## Decision

**Every verified workflow runs its products through the Product collection run.** A workflow supplies only how to collect and stage each product and how to commit it, returning the commit result unchanged. The run decides each product's outcome, names its failure, stops on a refusal, cancellation, commit outcome unknown or session loss, and ends the run. E-invoice, TDCC's session flow, MaiCoin and exchange-rate sync are not product collections and stay outside.

**The run collects Attached Preview Products.** A workflow passes its attached collection as the run's `attached` option, built only when the person selected an attached product. The run collects them after every verified product, unless a stop already ended the run, and merges both into one summary. A recoverable verified failure still runs the attached products. A verified selection may be empty when an attached product is selected.

**A run in which nothing produced durable data throws.** It throws the summary with the first failed verified product's code, so the host records that code instead of guessing from events. An attached product that was the only one attempted keeps its original error. Fubon, Yuanta and TDCC still report such a run as a failed status in their output, declared by `failedRunInSummary`, until their outputs are revisited.

**The run names an untyped failure from the stage it reported.** Each collector reports its own run events through a product-scoped reporter. When it reports a decoding or validation failure and then throws an untyped error, the run names the product `source-integrity-failed` or `source-validation-failed`, as the host did from run events. A typed error and a workflow's `classifyFailure` still win.

**A run's capability ports are typed from its definition.** `defineWorkflow` and `verifiedWorkflow` give a run a context whose required ports are present, so a run that reads a port its flags do not require fails to compile. The executor's check before every run stays the only runtime guard.

**Statement Selection ids name their product type.** SinoPac and LINE Bank select `deposit`, and Yuanta trade selects `securities`. A migration rewrites the persisted selections when settings are read.

## Considered options

- **Move only the three workflows with attached products.** Rejected. CTBC, LINE Bank, Post and Yuanta trade carry the same refusal defect, and the next sweep would still edit them by hand.
- **Leave attached collection to each workflow, as Cathay did.** Rejected. Every workflow would keep its own copy of the verified-then-attached order and the stopping rules ADR 0051 and ADR 0058 require.
- **Stop the attached products after any verified failure.** Rejected. A single-product run would then stop where a multi-product run continues.
- **Read the old Statement Selection ids as aliases.** Rejected. It moves the hand-kept mapping from the workflow to the parser.

## Consequences

- ADR 0056's rejected option "Move every workflow onto selected-product collection" is superseded by this decision.
- Event codes of the moved workflows follow the run's `<product>-collection-started` pattern. Readers use the outcome and signal ([ADR 0059](0059-run-event-outcome-and-signal.md)), so only the diagnostic text changes. Commit items are unchanged, and the deposit commit goldens pin them.
- The four single-product sources now show product results on their task row.
- A single-product commit that lands some receipts and fails others is now a `partial` run with a `canonical-commit-failed` product, as it already was for a multi-product run.
- The attached merge that `finishAttachedProductRun` held is internal to `src/lib/automation/product-collection.ts`, and `src/lib/automation/product-collection.check.ts` covers the attached policy.
