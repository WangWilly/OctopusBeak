# The product handle decides what is a validation failure

Status: accepted

Narrows how a collector reports its stage under [ADR 0060](0060-product-collection-run-owns-every-verified-product-outcome.md), which names an untyped failure from the stage the collector reported. Keeps [ADR 0059](0059-run-event-outcome-and-signal.md): codes stay diagnostic.

Each collector decided on its own which failed stage to report before it threw. The decision drifted, and three cases changed the Failure code the person reads:

- **Waits reported as validation or decoding.** HNCB's statement download, Post's statement query and SinoPac's transaction query reported `validation` for any error from a block that included the browser or network wait. A timeout read as `source-validation-failed`, which tells the person OctopusBeak needs an update, instead of `source-collection-failed`. The shared current-balance read reported `decoding` for its read, so a timed-out balance page read as `source-integrity-failed`.
- **Failures never reported.** HNCB's and Post's admissions and SinoPac's account list threw without reporting a stage, so they read as collection failures, while SinoPac's equivalent admission read as a validation failure.
- **Malformed JSON split two ways.** E.SUN, CTBC and LINE Bank reported a reply that decoded but did not parse as `decoding`, so it read as `source-integrity-failed`. HNCB, Post and SinoPac reported it as `validation`.

The `SourceTextIntegrityError ? "decoding" : "validation"` choice the collectors wrote never mattered for the decoding side: the thrown type already names `source-integrity-failed` before any reported stage is read.

**`product.validate(check)` is the one place a collector reports validation.** The handle runs one check of what the source returned: a shape check, a parse or an admission, never a browser or network wait. An untyped error the check throws is reported as the product's validation failure, `source-validation-rejected`, and thrown on. A typed error, an absence or a cancellation is thrown on unreported, because it already names its outcome. A wait that fails outside the check stays a collection failure, and so does a refusal the provider states in its reply, such as LINE Bank's or CTBC's non-OK code, because the reply itself is well formed.

**Integrity means the bytes.** A reply whose text decodes but does not parse, or does not have the expected shape, is a validation failure. `source-integrity-failed` stays with `SourceTextIntegrityError`.

## Considered options

- **A bracket that owns each account's whole event stream.** Rejected. The started, completed and per-account events, the code spellings and `account-no-data` are diagnostics that ADR 0059 says no reader uses. Unifying them would rewrite every success-path golden without changing an outcome.
- **Typed validation errors instead of reported stages.** Rejected for now. A `SourceValidationError` classified by type would delete the reported stages that ADR 0060 introduced, but every collector's untyped errors would have to be found and typed first.

## Consequences

- A timeout during a source read fails as `source-collection-failed` in every collector and in the shared current-balance read, whose checks `validationReporter` lets a check outside a run drive too.
- E.SUN, CTBC and LINE Bank fail a reply that decodes but does not parse as `source-validation-failed` instead of `source-integrity-failed`; Yuanta trade fails it as `source-validation-failed` instead of `source-collection-failed`.
- Admission and shape checks that threw unreported, in HNCB, Post, SinoPac, CTBC, LINE Bank and Yuanta trade, now fail as `source-validation-failed`.
- Success-path run events and their commit goldens are unchanged. The two Post failure goldens gain the reported validation failure.
- A reported validation failure carries the one code `source-validation-rejected` and no counts, in place of each collector's own spelling.
- A new collector reports validation only through `validate`, and keeps its waits outside it.
