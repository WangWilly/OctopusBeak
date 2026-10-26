# The Product collection run commits each product and decides source-only

Status: accepted

Extends [ADR 0060](0060-product-collection-run-owns-every-verified-product-outcome.md) and [ADR 0063](0063-product-collection-run-stages-every-item.md). Leaves sign-in with the Source sign-in step of [ADR 0061](0061-source-sign-in-step-owns-every-browser-sign-in.md).

## Context

After ADR 0063 the run staged every item, but each workflow still wrote the rest of its run by hand:

- A `commit` closure that called `financialCommit.execute` with a second copy of the provider and one of four product labels: the product type id, `financial`, `credit-card` or `investment`. Only a label that names a product type gives commit events a `statementType`, so the commit stage of seven sources showed no product.
- Five ways to decide whether a completed run was `source-only`. Fubon, Yuanta, CTBC and SinoPac meant "every committed item was a source assertion". HNCB and LINE Bank meant "no financial records", so a run that admitted zero-record deposit captures and current balances read as `source-only`. Cathay, Post, E.SUN and Yuanta Trade did not decide it, which was correct only because they never stage a source assertion.
- Three closing events (`source-validation-completed`, `statement-collection-completed`, `all-source-admission-completed`) or none. Post, HNCB, E.SUN and Yuanta Trade also never reported `preparation completed`, so their preparation stage never completed on the dashboard.

## Decision

**The run calls the commit.** A workflow passes its `financialCommit` port to `collectSelectedProducts`, and the run commits each fully staged product with the provider it already holds and the product type id as the product label. The `commit` closure is deleted.

**The run decides source-only.** A completed run is `source-only` when every item it committed is a source assertion command. The run remembers what it staged, because receipts do not carry the command kind. The summary carries the answer, and `productRunResult` no longer takes it as an option.

**The run reports the end of verified collection.** When it returns a summary, the run reports `validation completed source-validation-completed` with the run's Source Capture count. Each workflow reports `preparation completed input-validated` once its input is valid.

**Sign-in stays with the workflow.** `withPage`, the Source sign-in step and sign-out keep their per-source differences: Cathay's session token, LINE Bank's post-sign-in page, Fubon's keep-alive, and E.SUN's and Cathay's own sign-in failures. TDCC keeps its session flow and summary and moves to the run's commit like every other caller.

## Considered options

- **Let the run also own the browser page, sign-in and sign-out.** Rejected. Six sign-in variants would each need a hook, and ADR 0061 already gives sign-in one owner.
- **Decide source-only from committed financial records.** Rejected. The run cannot see a capture's records, so every collector would have to label each item, and a run that admitted current balances is not a source-only run.
- **Keep each workflow's product label.** Rejected. It keeps a second label per workflow and leaves seven commit stages without a product.

## Consequences

- An HNCB or LINE Bank run that admits only zero-record deposit captures and current balances is now `financial-admitted`, not `source-only`.
- Commit attempts of CTBC, Post, HNCB, SinoPac and LINE Bank record `deposit`, E.SUN records `credit_card`, and Yuanta Trade records `securities`. No outcome decision reads that label.
- Cathay's closing events are replaced by the run's single closing event. The dashboard shows event codes as diagnostic text only.
