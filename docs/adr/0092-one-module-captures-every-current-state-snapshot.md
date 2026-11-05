# One module captures every Current-state provider snapshot

Status: accepted; amended by [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md), which moves the endpoint and header checks and observed time into the module, and by [ADR 0107](0107-the-snapshot-module-assembles-every-current-state-capture.md), which assembles every capture in the module

Builds on [ADR 0054](0054-domestic-deposit-admission.md), [ADR 0063](0063-product-collection-run-stages-every-item.md), [ADR 0065](0065-product-runners-read-the-source-before-they-stage.md), [ADR 0066](0066-source-site-owns-signed-in-navigation.md) and [ADR 0080](0080-one-exact-money-module.md).

Eight banks collect a Current-state provider snapshot of their deposit accounts: Cathay, CTBC, Fubon, HNCB, LINE Bank, Post, SinoPac and Yuanta. Each one wrote the whole path from the provider response to the staged item on its own. The copies drifted where the bugs live:

- **Strict decoding.** CTBC parsed its rows from a lenient UTF-8 decode and threw away the strict result it computed beside it. HNCB never checked its balance rows for replacement characters.
- **Item keys.** Cathay and LINE Bank keyed staged items by array index, the others by account, with three different formats.
- **Amount lexemes.** Seven private `parseExactDecimal` copies and Post's `parseExactInteger` disagreed on whitespace cleanup and input types.
- **Progress events.** Fubon, HNCB, Yuanta and Cathay reported no current-balance collection, decoding or validation events.

**The Current-state snapshot capture module (`src/workflows/current-state-snapshot-capture.ts`) owns the path from evidence to staged item.** A bank hands it raw evidence, either a response body or the text cells of a provider table. The module decodes the evidence strictly through the run's `SourceTextPort`, hands the decoded value to the bank's row parser, matches each row to an admitted financial capture, admits the bank-built capture, builds the balance command and its item key, and reports the standard current-balance events. It returns the stage requests with the matched and excluded rows. JSON evidence also hands the parser the strictly decoded text, so a bank whose amounts arrive as JSON numbers can keep their lexemes without decoding the bytes again.

**The module reads and stages in two halves.** `captureCurrentStateSnapshots` composes `readCurrentStateSnapshot` (decode and parse) with `stageCurrentStateSnapshot` (match, admit and key). Fubon calls the halves separately, because it reconciles its USD-coded accounts from every parsed row and admits them before any row is matched.

**A bank keeps only what genuinely differs.** That is how it reaches the evidence (clicks, navigation, frames, in-page requests, fallbacks, and their signal handling), its row parser with the endpoint and header checks, its matching policy for an unmatched row, its capture builder, and its product label. Admission stays per bank, as ADR 0054 decided.

**The module derives the item key from the capture's identity.** The key is `current-balance:<stream>:<source account key>`. A foreign-currency capture appends its currencies, because one account can report several. An item key is a staging and receipt label, not canonical identity, so the new keys change no stored data.

**Provider amount lexemes parse through `parseProviderDecimal` in the exact-money module**, completing ADR 0080 for the step before arithmetic.

## Considered options

- **Let the module also acquire the evidence.** Rejected. Acquisition is where the banks truly differ in control flow, and folding it in would widen the interface without removing a single bug. Racing every signed-in read against the run signal is a separate change that extends ADR 0066.
- **Unify admission behind the module.** Rejected by ADR 0054. Each bank's capture builder still produces its own admission input.
- **Fix the drifted copies one by one.** Rejected. The next bank would copy whichever version it found first.

## Consequences

- Every bank reports the same six current-balance events. Fubon, HNCB, Yuanta and Cathay report them for the first time. Post, SinoPac and Cathay lose their own failure and progress codes, such as `current-balance-rejected`, `current-balance-source-rejected` and Cathay's `domestic-current-balance-started`. Their deposit-commit goldens record the new events and item keys.
- A bank reads its snapshot only when the run admitted a financial capture. LINE Bank used to parse its balance contract on every account-list fetch, so a malformed balance field no longer fails a run that admitted no domestic capture.
- HNCB's detail-page fallback now runs when the overview page has no data rows, as its documentation already said. Before, the overview parser threw first.
- Cathay and LINE Bank have deposit-commit goldens for the first time.
- Statement-side amount parsers whose rules `parseProviderDecimal` cannot express keep their own code: commas accepted anywhere, signs or leading zeros rejected, or a reduced decimal string returned. Examples are `exactCathayAmount`, `exactLinebankAmount`, Yuanta's `normalizeExactDecimal` and Fubon's credit-card parsers.
- Each bank's legacy current-balance reader is gone. A bank that needs a new kind of evidence extends the module's evidence type instead of decoding on its own.
