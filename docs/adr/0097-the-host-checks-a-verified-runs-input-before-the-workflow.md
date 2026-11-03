# The host checks a verified run's input before the workflow

Status: accepted

Builds on [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md) and [ADR 0071](0071-product-collection-run-bound-to-its-verified-source.md), and completes the input parsing that 0071 deferred.

ADR 0071 bound each product-collecting workflow to its Verified source's products, but left every workflow to parse its own input and report `input-validated`. Each of the eleven product-collecting workflows (ten banks and TDCC) therefore restated facts the source definition already held, and the copies drifted:

- **Credential keys written twice.** The registry builds each credential input from the definition's `credentialFields`, yet every bank declared the same keys again in a zod schema, an all-optional `*Credentials` type, and a `requireCredential` helper that re-checked what the schema had checked. ADR 0057 had named exactly this duplication.
- **One Statement Selection rule, five spellings.** "At least one verified product or one attached product" was a hand check in SinoPac, a `.refine` in HNCB, Cathay and Fubon, `.min(1)` in Post, CTBC and LINE Bank, and `FailureCodeError("collection-scope-changed")` in E.SUN. A run with nothing selected failed as `collection-scope-changed` for E.SUN and as an unexplained `workflow-failed` everywhere else.
- **Messages that named nothing.** A missing sign-in detail failed with "input or sign-in details are missing or invalid", which does not say which field to fill.

**The host checks the shared input before the workflow sees it.** A product-collecting Verified source's workflow loads a Verified workflow entry: its own `parseInput` and its `run`. The host checks each credential against the definition's fields, checks the attached preview product ids and the Statement Selection rule, checks that every selected product and attached preview product is one the source offers, calls `parseInput`, checks for cancellation, reports `input-validated`, and only then calls `run` with the parsed input.

- **Credentials are typed from the definition.** Each source declares its credential fields and products as `as const` lists beside its definition, and the workflow types its verified input from those lists. The keys are written once. The lists live beside the definition rather than being read from the definition's own type, because the workflow already imports the definition and the definition lazily imports the workflow, so deriving from the definition's type would be circular.
- **Trimming is a field fact.** Every credential is trimmed unless its field declares `trim: false`. Only Fubon's password keeps its whitespace, as before; Yuanta's schema did not trim its password, but its sign-in helper did before filling the form, so it stays trimmed.
- **An empty selection is a scope change.** The settings page cannot start a run with nothing selected, so a run that finds an empty selection had it cleared after it was queued, which is what `collection-scope-changed` tells the person.
- **A missing credential names its field**, by its label and never its value.
- **`parseInput` keeps what is genuinely per source**: filters, dates, nested product inputs, the managed identity secret, and checks that must precede `input-validated`, such as Fubon's login scope and connection key or E.SUN's refusal of a custom date range.

## Considered options

- **Let the host also open the page, sign in, and bind the session check.** Rejected. Five sources wrap sign-in with steps before or after it, or a custom session check, so the entry would need hooks around sign-in and the complexity would move into the hooks rather than leave.
- **Offer a shared parsing helper that each workflow calls.** Rejected. A workflow could still skip it or call it out of order, which is how the selection rule drifted.
- **Validate in the main process before the run starts.** Rejected. The failure would happen outside the run, with no run event to record it.
- **Trim every credential, or never trim secrets.** Rejected. Either changes the value some sources send today, which cannot be checked against each provider.
- **Unify the run counts.** Still deferred. Only the collectors know them, and no reader uses a source-specific count by name; they are only displayed.

## Consequences

- Workflows no longer report `input-validated`; a workflow that did would report it twice.
- Post, CTBC, LINE Bank, E.SUN and Yuanta Trade still have no session check. Adding one needs a page probe checked against each live site.
- A source without credential input, such as TDCC, gets an empty credential record and only the selection checks.
