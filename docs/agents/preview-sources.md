# Building on Preview Sources

Status: Current

A Preview Source collects balances, transactions, card purchases, and statements for an Institution that no live-verified source contract covers. Its data goes to separate preview tables and never reaches canonical admission. See [ADR 0047](../adr/0047-preview-sources-outside-canonical-admission.md) for the decision, [ADR 0051](../adr/0051-attached-preview-products-on-verified-sources.md) for Attached Preview Products, [the product spec](../specs/preview-credit-cards-and-time-deposits.md) for credit cards and time deposits, and `CONTEXT.md` for the terms *Preview features*, *Preview source*, *Preview financial data*, *Attached preview product*, *Preview authorization pairing*, *Preview billing supersession*, and *Preview time deposit closure*.

This guide describes the seam that display, structure-report, and connector work builds on. Do not edit canonical admission, Source Capture, or source contract catalog code for preview work.

## Products

A preview product is `deposit`, `credit_card`, or `time_deposit` (`PreviewProduct` in `src/ledger/pglite/preview-core.ts`). A source declares the list it can collect; the person selects among them in Statement Selection; each selected product gets its own result. Each product has its own collection type and is written by its own call:

| Product | Collection | Rows written | Account id |
| --- | --- | --- | --- |
| `deposit` | `PreviewDepositCollection` (`accounts: PreviewAccount[]`) | `preview_accounts`, `preview_balance_observations`, `preview_transactions` | `previewAccountId(sourceId, sourceAccountKey)` |
| `time_deposit` | `PreviewTimeDepositCollection` (`completeness: "complete"`, `deposits: PreviewTimeDeposit[]`) | `preview_accounts` (with maturity, principal, rate, closed-at), `preview_balance_observations` | same formula, so a key that moves between `deposit` and `time_deposit` keeps its row |
| `credit_card` | `PreviewCreditCollection` (`accounts: PreviewCreditAccount[]`) | `preview_credit_accounts`, `preview_credit_cards`, `preview_credit_balance_observations`, `preview_credit_purchases`, `preview_credit_statements`, `preview_credit_relations` | `previewCreditAccountId(sourceId, sourceAccountKey)` |

## Invariants

- Preview data is written only to the tables in the Products table above. They live in the App's PGlite database and are created by the `preview-financial-data-v1` and `preview-financial-data-v2` operational migrations (`PREVIEW_FINANCIAL_DATA_TABLES`).
- A row without an ISO 4217 currency is refused. Amounts are exact decimal strings such as `"1234.50"`, never numbers. Both the port and the table `CHECK` constraints enforce this. A card purchase with a zero amount is refused.
- A direction is `inflow`, `outflow`, or `unknown`. Use `unknown` when the source does not say. Never infer a direction from the sign, except for a card purchase whose bank section states that assumption and whose collection holds both signs.
- A used-credit balance carries its basis (`PreviewCreditBasis`) with every operand the basis used. A missing operand fails the product; nothing defaults to zero. An account whose latest used credit is unknown shows as such and makes every total that would include it incomplete.
- A time-deposit collection is the complete list, declared by `completeness: "complete"`. A deposit absent from it is closed (`closed_at`); a closed deposit stays listed with its history and counts toward nothing. A source that cannot show the list complete fails the product and closes nothing. A deposit present again in a later complete list is open again, and the receipt's `closedAccounts` reports each closure.
- A credit write carries the complete current pending and unbilled purchase lists. Preview Authorization Pairing (`pending_to_posted`) and Preview Billing Supersession (`unbilled_to_billed`) run inside the write transaction, from the stored rows, and are never reassigned once written; the primary key and unique constraint on `preview_credit_relations` enforce that. Rows with an `unknown` direction or no card never pair.
- A preview workflow never receives `financialCommit`. Its context has a `preview` writer bound to its own source, and a verified workflow with Attached Preview Products receives `previewWrite` beside its canonical commit port and binds it through `collectAttachedPreviewProducts`.
- When the Preview features setting is off, preview sources are absent from sign-in settings, Sync all, Scheduled Collection, and direct runs, and attached products leave their verified source's Statement Selection. All preview data is excluded from every read and is retained.
- Visibility is per Institution and product. While an enabled verified source covers the same Institution and product, that product is hidden from Statement Selection, is not collected, and its data is not read; the source's other products are unaffected.
- A product failure stays with that product: earlier products' writes are kept and later products still run. A session loss (`sign-in-rejected`, `session-conflict`, a verification or device-registration failure, or a failing `assertSession`) ends the run with the remaining products `skipped` (`not_attempted`).

## The seam

| Need | Use | File |
| --- | --- | --- |
| Register a source | Add a `PreviewSource` with its `products` to `PRODUCTION_PREVIEW_SOURCES` | `src/lib/preview-sources/registry.ts` |
| Collect and write the selected products | `context.preview.collect({ deposit: async () => ..., credit_card: async () => ... })` inside `PreviewSource.run`; it returns the run's `PreviewRunOutput` | `src/lib/preview-sources/workflow.ts`, `src/lib/preview-sources/product-collection.ts` |
| Declare and collect attached products on a verified source | `ATTACHED_PREVIEW_PRODUCTS` and `collectAttachedPreviewProducts(...)` | `src/lib/preview-sources/attached-products.ts` |
| Data shapes | `PreviewDepositCollection`, `PreviewAccount`, `PreviewTimeDepositCollection`, `PreviewTimeDeposit`, `PreviewCreditCollection`, `PreviewCreditAccount`, `PreviewCard`, `PreviewCreditBalance`, `PreviewCreditBasis`, `PreviewPurchase`, `PreviewStatement` | `src/ledger/pglite/preview-financial-data.ts` (re-exports `preview-core.ts` and `preview-credit.ts`) |
| Decide what is visible | `currentPreviewVisibility()` in the main process, or the pure `previewVisibility(...)`; `visibleProducts(visibility, source)` for one source | `src/lib/automation/server/settings.ts`, `src/lib/preview-sources/visibility.ts` |
| Read preview data | `preview.accounts(visibility)`, `preview.transactions(visibility, id)`, `preview.creditAccounts(visibility)`, `preview.purchases(visibility, id)`, `preview.statements(visibility, id)` on the operational provider | `electron/pglite-operational-rpc.ts` |
| Compose preview rows into the overview | `previewAccountRow`, `previewCreditAccountRow`, `previewSummaryMarkers`, `withPreviewHistory` | `src/ledger/pglite/preview-overview.ts` |
| Verified coverage | `VERIFIED_SOURCE_COVERAGE`, keyed by verified credential group, listing Institution and product pairs | `src/lib/preview-sources/visibility.ts` |
| Delete all preview data | `settings.deletePreviewData()` in the renderer, `deleteAllPreviewData` in main | `src/lib/preview-sources/delete-preview-data.ts` |
| Record a response for a structure report | `context.preview.observe({ endpoint, status, body })` inside `PreviewSource.run` | `src/lib/preview-sources/workflow.ts` |
| Sanitize, bound, and share a report | `previewResponseShapes`, `previewStructureReports`, `previewStructureReportIssueUrl` | `src/lib/preview-sources/structure-report.ts` |

`PreviewVisibility` is the single query-level predicate: `{ visible: { sourceId, product }[] }`. A read returns rows only for the listed pairs, and an empty list returns nothing. Attached products use the verified credential group's id as their `sourceId`. Always compute it with `currentPreviewVisibility()` at read time, then pass it to the read. Do not cache it across a settings change; the App marks data stale (`preview-data-changed`) when the toggle changes, a verified source's enabled flag changes the covered pairs, or preview data is deleted.

The main process reaches the port as `pgliteOperational.provider.preview`. A workflow child reaches the same port through the authenticated child RPC. The runtime injects it into definitions with `requiresPreviewWrite: true` (a Preview Source, which cannot run without it) and into definitions that declare `attachedPreviewProducts` (a verified workflow, which still runs its verified products when the port is absent and then reports its attached products `failed`).

### Statement Selection and product results

A Preview Source's credential group has `statementSelectionKey` `PREVIEW_<ID>_STATEMENT_TYPES` and one statement type per product. A source with one product is selected without setup, as a verified single-product group is; a source with several products needs an explicit choice, and nothing is selected for the person. `previewWorkflowInput` turns the stored selection into `input.products`: the selected products, minus any pair an enabled verified source covers, in the source's declared order. `context.preview.collect` runs exactly those products.

The run's output is a `PreviewRunOutput` (`status`, `accountCount`, `itemCount`, `committedCount`, `products`), and its `products` are `CollectionProductOutcome`s with `success`, `no_data`, `not_held`, `failed` (with an `errorCode`), or `skipped` (`not_selected` or `not_attempted`). A product counts as `success` when its write stored at least one account; a collection that stores none is `not_held`; a collector may also return `{ absent: "not_held" | "no_data" }` for a provider message instead of a collection. A run in which no attempted product produced data fails: with the sole product's own error when one product was attempted, so single-product sources and their checks behave as before, or with a `ProductCollectionInterruptedError` that carries every outcome. A session loss throws the same error with the remaining products `not_attempted`.

## Structure reports

When a preview run fails, the workflow worker takes the observed responses with `takePreviewObservations(error)` and turns them into shape-only inventories with the E.SUN deposit probe's sanitizer (`src/lib/preview-sources/response-shape.ts`). Raw bodies never leave the worker. The failed frame carries only the inventories, and the main process validates them again before it accepts them.

The main process keeps one report per preview task, in memory, for the latest run of that task. A new run of the task drops the previous report, and a restart drops all of them. Reports are not written to the database. The report holds at most 50 responses and at most 48,000 characters of inventories, so it fits in a GitHub issue body; older responses are dropped first and counted in `omittedResponses`.

The run details show 「分享結構報告」 for a failed preview run. The dialog shows the full report, copies it, and opens a prefilled issue in the system browser. The issue URL carries a fixed title and template only, never the report. The App never sends the report itself.

## Add a bank

1. Create `src/lib/preview-sources/<bank>-source.ts` and export a `PreviewSource`:
   - `id` is lowercase kebab-case, such as `nextbank-deposit`. The task and workflow id become `preview-<id>`, the enabled setting becomes `PREVIEW_<ID>_ENABLED`, and the Statement Selection setting becomes `PREVIEW_<ID>_STATEMENT_TYPES`.
   - `institution` is an `InstitutionKey` from `src/lib/institutions/institution-tables.generated.ts`, such as `bank-823`. `products` lists what the source can collect, in Statement Selection order, such as `["deposit", "credit_card"]`.
   - Every credential field key starts with `PREVIEW_<ID>_`, for example `PREVIEW_NEXTBANK_DEPOSIT_PASSWORD`.
   - `startUrl` uses `https:`.
   - `run(context, input)` signs in with `input.credentials[<key>]`, then returns `await context.preview.collect(collectors, { assertSession })`. `collectors` has one async function per declared product that collects, validates, and returns that product's collection (or `{ absent }`); `input.products` tells the run which products are selected, so a sign-in step a product needs can be skipped when it is not. Pass `assertSession` when the bank has a cheap session check; the runner calls it before each product and after a product failure. Read only the products in `input.products`.
   - A time-deposit collector returns the complete list or fails the product with `fail("incomplete-data", ...)`; it never returns a partial list. A credit collector builds a `PreviewCreditBalance` only when every operand of its basis was read, and sends the complete current pending and unbilled lists in every write.
2. Add the source to `PRODUCTION_PREVIEW_SOURCES` in `registry.ts`. The App derives the sign-in group, the Statement Selection, the task, the workflow registration, and the Sync all and Scheduled Collection membership from this entry.
3. If a verified source for the same Institution and product exists, confirm that `VERIFIED_SOURCE_COVERAGE` lists that pair. Otherwise the preview product stays visible beside it.
4. Add a `<bank>-source.check.ts` that runs the source through `runPreviewSource` from `preview-source-harness.ts`, with `fakeHttpOpener` routes built from the bank's documented response shapes. The harness takes the selected products as its fourth argument (default: every declared product) and returns `writes` (every `PreviewWrite`), `deposits` (the deposit collections), `output` (the `PreviewRunOutput`), and `receipt` (the summed receipts). Assert the written collections, the per-product outcomes, that `observe()` saw each response, and that a missing currency, a malformed amount, a zero card amount, a missing basis operand, or an incomplete page fails that product before its write and leaves the other products' writes in place.
5. Give the setup guide at least one official link, and add a section for the bank under [Sources](#sources). State there any direction-from-sign assumption a card product makes.

## Add a product to a verified source

An Attached Preview Product (ADR 0051) is collected by a verified workflow during its own sign-in. The foundation declares the four sources in `ATTACHED_PREVIEW_PRODUCTS` (`src/lib/preview-sources/attached-products.ts`): Cathay `credit_card` and `time_deposit`, HNCB `credit_card`, SinoPac `credit_card`, E.SUN `deposit`. For each, the registry in `app-workflow-registry.ts` already sets `attachedPreviewProducts` on the workflow definition and passes `input.attachedPreviewProducts` (the selected, uncovered attached products, empty while Preview features are off). The Statement Selection shows the attached products with `preview: true` while Preview features are on, unselected by default. What is left to a bank worker is collection:

1. In the verified workflow, after sign-in and after its verified products, call

   ```ts
   const attached = await collectAttachedPreviewProducts({
     context,
     source: ATTACHED_PREVIEW_PRODUCTS.cathay,
     selected: input.attachedPreviewProducts,
     collectors: { credit_card: async () => ..., time_deposit: async () => ... },
     assertSession,
   });
   ```

   It writes each product through a writer bound to the verified source (`sourceId` is the credential group id, so rows read back as that source), never through the canonical commit, and it never throws. Append `attached.products` to the run's `products`, and treat `attached.interrupted` (a session loss during an attached product) like a session loss in a verified product. An attached product never builds a Source Capture, and a verified product never calls the preview writer; review checks both.
2. Parse `input.attachedPreviewProducts` in the workflow's input schema as an optional list of `PreviewProduct` ids, default empty, and collect nothing for it when it is empty. The verified `statementTypes` input never contains an attached id; `statementTypeIdsFromEnvironment` strips them.
3. A person may select only attached products. Decide how the workflow signs in with an empty verified selection (Cathay's input schema requires at least one verified type today) and document it in the workflow's section.
4. Keep the `VERIFIED_SOURCE_COVERAGE` entry for the verified products only. When the attached product is promoted, remove it from `ATTACHED_PREVIEW_PRODUCTS`, add it to the coverage, and let the person delete and recollect (ADR 0047).
5. Check the workflow with `collectAttachedPreviewProducts` against a recording `previewWrite` port, as `product-collection.check.ts` does: the attached product writes only `PreviewWrite`s with the group's `sourceId`, a failing attached product leaves the verified products' outcomes intact, and `attachedPreviewProducts: []` collects nothing.

A product that cannot share the verified sign-in (CTBC credit cards use the App protocol) is its own Preview Source with its own `products`; follow [Add a bank](#add-a-bank).

### Building blocks

| Need | Use | File |
| --- | --- | --- |
| Send requests through the App-owned browser (ADR 0044) | `browserHttp`, or a fake `PreviewHttpOpener` in checks | `src/lib/preview-sources/browser-http.ts` |
| Send requests from Node, after a probe shows the hosts accept it (ADR 0044) | `nodeHttp` | `src/lib/preview-sources/node-http.ts` |
| Parse JSON without losing number lexemes | `parseSourceJson` returns every JSON number as its source text | `src/lib/preview-sources/source-kit.ts` |
| Exact amounts, ISO currency, local dates, as-of time | `exactDecimal`, `currencyCode`, `localDate`, `observedAt` | `src/lib/preview-sources/source-kit.ts` |
| Typed failures | `fail(reason, detail)`, `refuseUnsupportedVerification`, `requireDeviceRegistration` | `src/lib/preview-sources/source-kit.ts` |
| Run the selected products with per-product outcomes | `collectPreviewProducts`, `previewRunOutput`; `context.preview.collect` wraps them for a Preview Source | `src/lib/preview-sources/product-collection.ts` |
| Bind a writer to one source | `boundPreviewWriter(port, { sourceId, institution })` | `src/lib/preview-sources/product-collection.ts` |
| Normalize an amount for comparison | `amountKey("100.00") === amountKey("100")` | `src/ledger/pglite/preview-core.ts` |
| Solve a CAPTCHA with a calibrated family | `calibratedCaptchaSolver(family)` and `solveChallengeRound` | `src/lib/preview-sources/preview-captcha.ts`, `src/lib/preview-sources/source-kit.ts` |

`fail` throws a `PreviewSourceFailure` whose reason maps to one typed outcome. Inside a product collector, `sign-in-rejected`, `session-conflict`, the verification reasons, and `device-registration-required` end the run; the other reasons fail only that product:

| Reason | Outcome |
| --- | --- |
| `sign-in-rejected`, `session-conflict` | `authentication-failed` |
| `verification-unsupported` | `verification-configuration-failed` |
| `verification-rejected`, `verification-exhausted` | `verification-failed` |
| `device-registration-required` | `device-registration-required` |
| `unexpected-response`, `missing-currency`, `malformed-amount` | `source-validation-failed` |
| `incomplete-data` | `source-collection-failed` |

Rules every source follows:

- Read the currency from the source. Fix it per endpoint only when the source's product cannot hold another currency, say why in the bank's section, and let a currency the source does send win.
- Take the direction from a source field, such as separate in and out columns or a debit/credit code. Otherwise use `unknown`. Do not infer it from keywords, balance differences, or the sign.
- Fail the product when a paging or truncation flag says data is incomplete. Never write a partial page set, and never return a partial time-deposit list.
- Report `not_held` only with explicit evidence: a provider message, or a complete empty list. A timeout, an unknown shape, or a missing list fails the product.
- Report a balance as of a source timestamp or the HTTP `Date` header when one is readable, else mark it `collection-time`.
- A CAPTCHA needs a calibrated on-device solver (ADR 0039). Until one exists for the bank, the source calls `refuseUnsupportedVerification` before sending any request. To measure a family for a bank, see [How to calibrate a preview source CAPTCHA](captcha-calibration.md).
- A calibrated family lives in `preview-captcha.ts`, with its geometry, answer length, charset, strategies, policy, and threshold. `calibratedCaptchaSolver` refuses a capture outside the family with `verification-configuration-failed` and returns `null` when no candidate is accepted. The challenge image must be PNG. Decode another format with the page's decoder, as calibration did.
- Get the answer through `solveChallengeRound`. It submits nothing itself, and it fails with `verification-exhausted` and the `verification-solver-exhausted` event when no challenge is accepted. Pass more than one challenge only when the bank can serve a fresh challenge without a sign-in (ADR 0046), and never more than `MAX_CHALLENGES_PER_ROUND`. Preview sources solve inside the run, so the host's CAPTCHA Retry Campaign does not start another round: each run is one round and submits at most one answer.

`assertPreviewRegistry` runs when `tasks.ts` loads. It rejects a duplicate id, an empty or repeated `products` list, a credential key outside the source's prefix, and a non-https start URL.

## Test fixture

Set `OCTOPUSBEAK_PREVIEW_SOURCE_FIXTURE=1` to register the synthetic source in `src/lib/preview-sources/fixture-source.ts`. Its id is `synthetic`. It writes one fixed account without using the page. Its start URL does not resolve, so use it in checks and CDP screenshots, not for an App run. It never ships enabled.

## Promotion

When a verified contract replaces a preview source, delete that source's preview data and recollect through canonical admission. Do not migrate preview rows into canonical tables.

## Sources

Every source below has never run against a live account. Each was built from the response shapes that the TedLin1993/all-set-tw reference (MIT, commit `d217135`) documents, and was checked only against synthetic fixtures. Expect failures until structure reports arrive.

### NextBank (將來銀行), `nextbank-deposit`

- Transport: NextBank's web API at `https://api.nextbank.com.tw`, sent as in-page `fetch` from `https://www.nextbank.com.tw/` with the web channel headers. The web origin is kept, because the web login sends it.
- Sign-in: national ID, user code (base64), and the password encrypted with NextBank's RSA public key (PKCS#1 v1.5), plus an image CAPTCHA. Calibration in October 2026 found no OCR configuration safe enough for that CAPTCHA (best single strategy 10 of 60, see [the calibration record](../research/2026-10-15-preview-captcha-calibration.md)), so every production run ends with `verification-configuration-failed` before any request.
- Collected: the main account (current and available balance, three months of `CurrentDepositDetail`), each demand pocket (balance and every `GetPocketTxDetail` page), and each term-deposit pocket (balance only).
- Fail-closed: pocket paging fails when `pageInfo.hasNext` is not a boolean, when more pages follow an empty page, when a cursor repeats, or after 1000 pages. A `CurrentDepositDetail` response that carries `pageInfo.hasNext` other than `false` fails. A `tradeID` that repeats on the same date with different content fails.
- Assumptions:
  - Currency is fixed to TWD for `AllInOne` and `PocketInfo`, because NextBank offers NT-dollar deposits only and those endpoints carry no currency field. A `currency` field, if present, is used instead.
  - `tradeAmount` is kept as a signed lexeme. The direction is always `unknown`, because no direction field is documented.
  - Rows with `tradeChannel` `UNBILLED` are treated as pending and skipped.
  - The row key is the Taipei date of `txnDateTime` plus `tradeID`, because all-set-tw observed `tradeID` repeating across months.
  - The session-takeover notice is a precaution. The `OTHER_DEVICE_LOGIN` error code suggests one session at a time, which is unconfirmed.


### SKBank (新光銀行), `skbank-deposit`

- Transport: SKBank's mobile banking App API at `https://mbanking.skbank.com.tw`, sent as in-page `fetch` from a page opened on that same origin, with the App's `App-Version`, `Device-Info`, and `Device-Id` headers. Origin and Referer are stripped, because the native App sends neither. The responses are plain JSON envelopes (`ReturnCode`, `ReturnMessage`, `Data`); no response encryption is documented.
- Sign-in: national ID, user ID, and online banking password. `GetAppConfig` returns the RSA public key (`PublicKey.Module`, `PublicKey.Exponent`). The user ID and password are each encrypted with it (PKCS#1 v1.5, hex), and the `{"Payload":...}` text is signed with HMAC-SHA256 keyed by the hex SHA-256 of the national ID. The national ID itself is sent in the payload, as the App does. No CAPTCHA and no OTP are documented. `ReturnCode` `MB433` (App version rejected) fails as `source-validation-failed`, every other non-`0000` login code as `authentication-failed`, and HTTP 401 or 403 as `session-conflict`.
- Device: the preview context has no persistence port, so the `Device-Id` is a UUID-shaped SHA-256 of a fixed salt, the national ID, and the user ID. Every run presents the same device without stored state.
- Collected: `GetAccountSummary` (TWD details) and `GetForeignCurrencyAccountSummary` (non-TWD details), one account per account number and currency, with the current balance (`AccountBalance`, or `TimeDepositBalance` for a time deposit) and `AvailableBalance` when present. Transactions for every non-time-deposit account come from `FetchTransactionDetails` or `FetchForeignCurrencyTransactionDetails` over three Taipei calendar months, 100 rows per page. The balance as-of time is the HTTP `Date` header of the summary response.
- Fail-closed: a summary detail without an ISO `CurrencyCode` fails `missing-currency`. Transaction paging fails `incomplete-data` when `Paging.TotalCount` or `Paging.Page` is not an integer, when the server answers another page than requested, when `TotalCount` changes between pages, when collected rows exceed `TotalCount`, when an empty page or a `查無資料` answer arrives before `TotalCount` is reached, or after 100 pages. An account number and currency that repeat across the summaries fail.
- Assumptions:
  - Transaction currency is the account detail's `CurrencyCode`, the same value sent as the request's `CurrencyCode` for a foreign account. Rows carry no currency field. No currency is defaulted.
  - `Amount` is kept as its source lexeme, possibly signed. The direction is always `unknown`, because all-set-tw documents no per-row direction field; `Summary.Deposit` and `Summary.Withdrawal` are page totals only.
  - `TransactionDate` may use the ROC year (`115/10/03`) and unpadded parts, and is read as Taipei local time.
  - Rows have no transaction id. The row key is the date, a hash of date, amount, balance, `Memo`, `Remark`, and `Summary`, and an occurrence counter for identical rows in one account.
  - A time deposit is a detail with `DisplayGroup` `TimeDeposit` or product code `F500001`. Its transactions are not queried.
  - A foreign summary without `AccountList` means no foreign accounts, as all-set-tw treats it. A first-page `查無資料` answer means no transactions.
  - No OTP device binding is documented: all-set-tw signs in from a freshly generated device id. If SKBank requires one, the run currently fails as `authentication-failed`; detecting that code and calling `requireDeviceRegistration` is a follow-up once a structure report shows it.
  - `GetUserInformation` and `GetMegaMenuStatus` are called before the summaries because the App flow calls them. Their content is not used.
  - The session-takeover notice is a precaution. Whether a sign-in ends the phone App session is unconfirmed.
### Rakuten (樂天國際銀行), `rakuten-deposit`

- Transport: Rakuten's web banking page at `https://www.rakuten-bank.com.tw/ebank/`, driven in the App-owned Playwright page. Rakuten encrypts every API response with a session key and decrypts it in the page, so an init script wraps `JSON.parse` and keeps the plaintext `{ statusCode, rsData }` text with the XHR path, status, and `Date` header. The source reads that text through the `RakutenPage` port (`playwrightRakutenPage`), and checks use a fake port. The live page code is unverified.
- Sign-in: national ID, user code, and password typed into the login form, plus a 4-character image CAPTCHA. Calibration in October 2026 found no OCR configuration safe enough for that CAPTCHA (best single strategy 18 of 60, see [the calibration record](../research/2026-10-15-preview-captcha-calibration.md)), so every production run ends with `verification-configuration-failed` before the page opens. A login message about SMS, OTP, or device binding fails with `device-registration-required`; OTP and device registration are a follow-up. Native confirm dialogs, such as signing out another device, are always dismissed.
- Collected: the NT-dollar demand deposit account that the 臺幣存款 page queries (`queryAccountNo`), its current balance from `CTWQU0001` `accounts`, and three months of `txDetails`: the current month from `CTWQU0001/010` and two earlier months chosen in the page's month dropdown (`CTWQU0001/011`). Other NT-dollar accounts, foreign-currency accounts, and loans are not collected.
- Fail-closed: a month with `display.dataLimit` `true` fails, and a month with rows whose `display.dataEnd` is not `true` fails. A `statusCode` other than `0000`, a month that queries a different account, or a `pk` that repeats with different content fails. There is no paging, so no cursor applies.
- Assumptions:
  - Currency is fixed to TWD for `CTWQU0001`, because it is the 臺幣存款 page's query and carries no currency field. A `currency`, `cur`, `curr`, or `ccy` field on the account or the row, if present, is used instead.
  - `amt` is unsigned. The direction is always `unknown`, because all-set-tw could not confirm what `amtSign` means.
  - The row key is the 17-digit `pk`, inside the account.
  - A month without rows may report `dataEnd` `false`, as all-set-tw observed, so it does not count as truncated.
  - The session-takeover notice is a precaution. all-set-tw saw a "signed in on another device" refusal, which suggests one session at a time; this is unconfirmed.
### Mega (兆豐銀行), `mega-deposit`

- Transport: the MobileFirst API of Mega's Android App 2.5.19 at `https://mobile.megabank.com.tw/ixtein`, sent as in-page `fetch` from `https://mobile.megabank.com.tw/`. Origin and Referer are stripped, because the native App sends neither. The browser keeps the session cookies; the source sends the OAuth bearer token, the `x-auth-token` header, the MD5 `checksum` header, and the App's public client settings. Request and response bodies are plain JSON.
- Sign-in: OAuth client credentials, `/main/init`, App initialize, a 5-digit numeric image CAPTCHA, then the E2EE login. The login encrypts the space-padded password with 3DES-CBC (zero IV) under the per-login `SessionKey`, prefixes `ID|USERCODE/`, and wraps the result with the RSA key from the `e2ee` response (PKCS#1 v1.5).
- CAPTCHA: the *Mega Bank login CAPTCHA* family (`MEGA_CAPTCHA_FAMILY`). The `/fco/fco00001/captcha` JPEG is decoded to PNG in the page. It accepts about 28% of challenges, so an unaccepted challenge is replaced by another `/fco/fco00001/captcha` call, which is a pre-login request, up to five challenges. After five unaccepted challenges the run ends with `verification-failed` and no login is sent. The `e2ee` call comes after the accepted challenge, so the `cipherToken` is always fetched after the last captcha. That Mega checks the latest captcha after a refresh is inferred, not observed. Measured evidence is in [the calibration record](../research/2026-10-15-preview-captcha-calibration.md).
- Virtual device: `deviceCode`, `deviceUKey`, and `seed` are UUID-shaped SHA-256 digests of a fixed salt and the upper-cased ID number and user code. The preview context has no persistence port, so the device is derived instead of stored. It is a device identity only, not an App device binding: the login always sends `isDeviceBinded: false`.
- Second factor: a login with `secondFactorFlag` `Y`, or a query that returns `SYS014` after a login flagged `isHighIpFar`, ends with `device-registration-required` after logout. The source does not request or accept an SMS code. Supporting Mega's SMS verification is follow-up work.
- Collected: every row of the deposit overview (`/fco/fco10001/home`) as one account per account number and currency, with its `AVLBA` as the available balance. NT-dollar accounts also get three months of history from `/fao/fao01001/query`.
- Fail-closed: history paging fails when `tsqName` repeats, is not text, or after 20 pages. A `DRCR` other than `D` or `C`, a signed amount, or two overview rows with the same account and currency but different content fail.
- Assumptions:
  - Currency comes from each overview row's `DRCUR` and is never defaulted. History rows use their account's currency, which the query also sends; a row `currency` field, if present, is used instead.
  - `D` is an outflow and `C` an inflow. Amounts are kept as unsigned source lexemes.
  - Foreign-currency accounts are balance-only, because all-set-tw queries history for NT-dollar accounts only.
  - all-set-tw sums repeated account and currency rows and treats a repeated `tsqName` as the last page. Both meanings are unconfirmed, so this source fails instead.
  - The row key is the date, `DRCR`, amount, and `paymentItem` plus an occurrence count, because all-set-tw observed `serialNo` and `seq` renumbering within a day.
  - The balance is as of the HTTP `Date` header when the same-origin page can read it, else the collection time.
  - The session-takeover notice is a precaution. The login's `resultType` `1` (duplicate login) suggests one session at a time, which is unconfirmed.
### Taishin (台新銀行), `taishin-deposit`

- Transport: the online-banking JSON endpoints under `https://my.taishinbank.com.tw/TIBNetBank/svc/`, sent as same-origin in-page `fetch` from the RWD page `https://my.taishinbank.com.tw/TIBNetBank/svc/rwd/index.html`. The web origin is kept. A call without parameters sends an empty form body, as the official axios helper does.
- Sign-in: national ID, user code, and password, plus an image CAPTCHA. The page script builds the login request, so sign-in works only by driving the login form. That step is the `TaishinLoginForm` seam: it reads the CAPTCHA and submits the form, then the source classifies the page dialog and confirms the session with `web/common/sessioncheck`. No device OTP step is documented for the website login.
- Login form: `taishinBrowserSession` in `taishin-login-form.ts` opens the RWD page and gives the source one page for both the form and the API calls. It records the `NonSessionShuffle` response that `img._field_item__verify-code` loaded and hands its bytes to the solver, as calibration did. It fills the ID, user code, password, and CAPTCHA inputs, clicks 「登入網銀」 once, and returns the text of the page's message popup or native dialog. With no message, it closes the post-login password reminder (`#popupLoginChangePwd`) when one appears. The selectors follow all-set-tw and a local fixture page. They have not been checked against the live login form.
- CAPTCHA: the *Taishin Bank login CAPTCHA* family (`TAISHIN_CAPTCHA_FAMILY`). It accepts about 97% of challenges. The source has no refresh evidence, so it solves one challenge per run: an unaccepted challenge ends the run with `verification-failed` before the form is filled. Measured evidence is in [the calibration record](../research/2026-10-15-preview-captcha-calibration.md).
- Collected: each NT-dollar demand account from `web1/rb0100/query` (current and available balance from `web1/rb0101/query`, three months of `web1/rb0102/query`), and each foreign-currency sub-account from `web2/rb0800/getRB08000100Data` (balance from `getRB08000100QueryRealtimeBalance`, three months of `web2/rb0802/getRB08020100ForeignTranDetail`). Time deposits, loans, and investments are not collected.
- Fail-closed: an RB0102 list shorter than `inNo + outNo` is split into smaller date ranges and requeried, and fails when a single day is still short. A row whose in and out columns are both set or both empty fails. A foreign-currency row, real-time balance, or non-empty overview balance without a recognizable currency fails. A `procSeq` that repeats on the same date with different content fails. An account missing from the transaction-query account list fails.
- Assumptions:
  - Currency is fixed to TWD for the `web1` (RB01xx) endpoints, because they are the NT-dollar account pages and carry no currency field. A `currency` field, if present, is used instead. Foreign-currency rows take `CCY_CODE`, and a code or Chinese name such as `美元` maps to its ISO code.
  - The direction comes from `txnamtIn`/`txnamtOut` and `DEPAMT`/`DRWAMT`. A side counts as empty when it is `-`, blank, or zero. The amount is the lexeme of the set side.
  - The NT-dollar row key is the Taipei date of `sysdate` plus `procSeq` padded to seven digits. A row without `procSeq` fails. Foreign-currency rows carry no sequence number, so their key is the transaction time, direction, amount, and `ACCT_BAL`.
  - RB0802 shows no server paging or count, so its `TRANS_DETAILS` is taken as complete, and an empty object means no transactions.
  - `RESULT` `EBF0015` on `web1/rb0101/query` marks an account online banking cannot query. Its `rb0100` balance is kept and its transactions are skipped.
  - No logout endpoint is documented, so the session is left to expire.
  - The session-takeover notice is a precaution. The login dialog `USER 正在線上，無法登入` suggests one web session at a time. The effect on the phone App is unconfirmed.
### O-Bank (王道銀行), `obank-deposit`

Built from all-set-tw commit `f05dd30` and O-Bank's public web banking page code.

- Transport: the MobileFirst adapters of O-Bank's web banking under `https://www.o-bank.com/ebank/ixtein`, sent from Node with the plain HTTP transport (`nodeHttp`), which keeps a cookie jar per run. [The transport probe](../research/2026-10-18-obank-transport-probe.md) found every pre-login endpoint answering a Node client with HTTP 200 and no WAF challenge, so the browser is not used. Requests carry the web page's `Origin` and `Referer`, the OAuth bearer token, the MD5 `checksum` header, and `x-transaction-id`. Request and response bodies are plain JSON.
- Sign-in: OAuth client credentials (`browser`), `common/CMN01003/010` for the RSA public key (`rsData.params.e2e`, PKCS#1 PEM), `emptyLogin`, the login page calls, a CAPTCHA, then `submitCredentials` with the national ID, the user code, and the password. The user code and the password are each encrypted with the public key (PKCS#1 v1.5, base64) after the server time factor from a fresh `common/EndToEnd/020` call is appended. `resultType` `2` or `10`, `1`, or `lockDownFlag` `Y` fails as `authentication-failed`. `resultType` `3` (another session) fails as `session-conflict`; the source always sends `force` `0` and never retries with `1`, which would end the other session.
- CAPTCHA: a 4-character alphanumeric JPEG from `common/CMN01001/010`. No calibrated family exists, so every production run ends with `verification-configuration-failed` before any request. Checks inject `solveCaptcha` to exercise the full flow.
- Collected: every item of `fao/FAO01012/010` `rsData.userAccounts[].accountItems[]`, NT-dollar and foreign-currency, as one account per `accountItemNo` and `curr`. The current balance is `displayWorkBalNoCurr` (帳上餘額) and the available balance is `displayActBalNoCurr` (可用餘額), as of the list response's HTTP `Date` header. Each item gets one `customDisplay` history query from the first day of the month two months back through today (Taipei), read from `despositTxnDetails`.
- Fail-closed: an item without an ISO `curr` fails `missing-currency`. A history response whose echoed `startDate` or `endDate` differs from the requested range fails `incomplete-data`. A history response without a `despositTxnDetails` list, with a `curry` other than the queried currency, an account list without items, or an item and currency that repeat fail `source-validation-failed`. There is no paging, so no cursor applies.
- Assumptions:
  - Currency comes from each account item's `curr` and is never defaulted. Rows carry no currency field, so a row takes its item's currency, which the query also sends as `curry`.
  - `displayTxnAmount` is kept as its source lexeme, possibly signed. The direction is always `unknown`, because neither all-set-tw nor the public page shows a direction field.
  - The balance names follow the labels of the public web page (`FAO01012.js`), not all-set-tw, which reads `actBal` first as the balance. The raw `actBal` and `workBal` fields are unconfirmed and unused.
  - `queryType` `customDisplay` follows all-set-tw. The public page's own custom-range button may send another value; this is unverified.
  - A history answer is taken as complete, because neither source shows paging or a row count. The page allows ranges up to two years, so a three-month query is inside its limit.
  - `txnDate` may use the ROC year and unpadded parts, and is read as a Taipei calendar date.
  - Rows have no transaction id. The row key is the date, a hash of date, amount, `displayClsBal`, `txnDesc`, `displayMemo`, and `diplayAcct`, and an occurrence counter for identical rows in one account.
  - Time deposits are not collected. They come from a separate endpoint (`fao/FAO01022/020`), which the source does not call, and do not appear in `userAccounts`. Family accounts (`fmlyChild`) are not queried.
  - The Node transport is verified only before sign-in. If O-Bank rejects it after sign-in, switch the source to `browserHttp`.
  - The session-takeover notice is a precaution. The `resultType` `3` refusal and all-set-tw's optional forced login suggest one session at a time; this is unconfirmed.

### First Bank (第一銀行), `firstbank-deposit`

- Transport: First Bank's iBank web pages at `https://ibank.firstbank.com.tw/NetBank/`, driven in the App-owned Playwright page. The pages are server-rendered HTML inside a frameset, so the source sends no requests itself. Playwright response listeners keep the HTML of the bank's own `ajax/acntReview1.html` (deposit overview) and `2/010103.html` (transaction history) responses with their path, status, and `Date` header. The source reads them through the `FirstbankPage` port (`playwrightFirstbankPage` in `firstbank-page.ts`), and checks use a fake port. `firstbank-page.check.ts` drives the port against a local fixture site. The selectors and flow follow all-set-tw (commit `f05dd30`) and the public login page. The live page code is unverified.
- Sign-in: national ID, user code, and password typed into `#loginCustIdFake`, `#usrIdInput`, and `#pwd`, plus a 4-character image CAPTCHA (`#vrfyCode`, image `/NetBank/code_verify1.jpg`). The login button is an image map (`#captchaLoginArea`), clicked once at the centre of its area. The port clicks the bank's 仍要登入 (maintenance window), 我是本人 (public IP), and 下次再說 (update reminder) notices, none of which signs out another session. A `MULTI_SESSION_LOGIN` page or any other-session message ends the run with `session-conflict`. Native confirm dialogs are always dismissed and alerts accepted, so a takeover is never confirmed.
- CAPTCHA: no calibrated family exists, so every production run ends with `verification-configuration-failed` (`firstbank-image-captcha`) before the page opens. The source takes an injectable solver so checks can run the full flow. The challenge is the `code_verify1.jpg` response, decoded to PNG in the page.
- Collected: every deposit row of the account overview (`acntReview1.html`) as one account per account number and currency, with its 帳面餘額 as the current balance and its 可用餘額, when set, as the available balance. Each account in the transaction query's `select[name="acnt"]` gets three Taipei calendar months of `010103.html` history, one query per account. Time deposits are balance-only. Credit cards, VISA debit cards, and loans are not collected.
- Fail-closed: a next-page link or row-limit notice on either page fails `incomplete-data`, as does a query list with more than ten accounts or a demand account that is missing from the query list. A deposit row without an ISO currency fails `missing-currency`, and a transaction row without a currency fails when its account number holds several currencies. A history page that names another account than the one queried, a query account missing from the overview, a row whose debit and credit columns are both set or both empty, and an account number and currency that repeat with different content fail.
- Assumptions:
  - Currency comes from the overview's 幣別 cell, and a Chinese name such as 新臺幣 or 美金 maps to its ISO code. A history row takes its own 幣別 cell when present, else its account's currency.
  - The direction comes from the 支出 (outflow) and 存入 (inflow) columns. A side counts as empty when it is blank, a dash, or zero. A history without those columns but with a 交易金額 column keeps that lexeme with direction `unknown`.
  - Columns are found by header text, as all-set-tw parses the `ResultHeader` and `ResultContent` rows. Dates may use the ROC year (`115/10/03`) and are read as Taipei local time.
  - Rows have no transaction id. The row key is the date, a hash of date, direction, amount, currency, balance, and description cells, and an occurrence counter for identical rows in one query.
  - all-set-tw queries 31 days. This source asks for three months by setting `txnStart` and `txnEnd`. Whether the site accepts that range is unconfirmed; a refusal shows no history response and fails the run.
  - A demand account is any overview row whose 帳戶類別 does not name a time deposit, so a foreign-currency demand account is expected in the query list. This is unconfirmed.
  - all-set-tw's ten-account cap and the CAPTCHA's digit charset are kept as all-set-tw documents them. The page is not switched to Chinese first; the header patterns also accept all-set-tw's English labels.
  - The run always calls the frameset's own `logout()` at the end, because all-set-tw observed the single-login lock outlasting a session by about ten minutes. A logout failure does not change the result.
  - The session-takeover notice follows all-set-tw, which documents one active iBank sign-in per user.

### KGI Bank (凱基銀行), `kgibank-deposit`

- Transport: the online-banking page `https://ib.kgibank.com.tw/ibank/`, driven in the App-owned Playwright page. After sign-in the source sends same-origin in-page `fetch` to the API gateway under `https://ib.kgibank.com.tw/gateway/`, replaying the `authorization`, `ocp-apim-subscription-key`, `api-version`, and `x-c-*` headers that the page's own gateway requests carried, plus `x-c-localtime`.
- Sign-in: national ID, user code, and password, plus a 6-digit image CAPTCHA, entered in the Ionic login form. That step is the `KgibankLoginForm` seam in `kgibank-login-form.ts`. It reads the CAPTCHA data URL from `ion-img.recaptcha-image` (its `src` property or its shadow `<img>`) or a plain `img[src^="data:image"]`, and decodes it to PNG in the page. It sets each masked input (`#loginInputIdNo`, `#loginInputUserNo`, `#loginInputPassword`, `verifyCode`) as one whole value with one `input` and one `change` event, and clicks `button.btn.btn-primary.w-100` (or `button[type="submit"]`) once. A missing or disabled button fails before anything is sent. The seam returns the first `connect/token` response or recognized page message. The selectors follow all-set-tw and have not been checked against the live page.
- CAPTCHA: no calibrated family exists, so every production run ends with `verification-configuration-failed` before the page opens. Checks inject a solver to run the full flow. A CAPTCHA message counts as `verification-rejected` only when the page shows it before `connect/token` was requested.
- Account lock: three wrong passwords lock a KGI account. A 4xx `connect/token` response, or a page message about a wrong password, user code, ID, or a locked or suspended account, ends the run as `sign-in-rejected`. Nothing is resubmitted in the run: each run reads one CAPTCHA and submits the form once. A 5xx token response, an unrecognized message, or no outcome within 25 seconds fails as `unexpected-response`.
- Session takeover: KGI allows one sign-in per ID. When `connect/token` reports `isSSOExsit` `true`, the source clicks 「繼續登入」 once, as the person would, on manual and scheduled runs. This signs the person out of the KGI App and any other KGI session; the user approved this for KGI only. A second `isSSOExsit` after the confirmation fails as `session-conflict`, and a missing 「繼續登入」 button fails as `unexpected-response`. Once the form was submitted, the run always posts `Account/AccountLogout/Logout` at the end, on success or failure. A failed logout never changes the run's outcome.
- Collected: every NT-dollar demand account that `Deposit/TwdDemandDepositDetail/AcctQuery` lists, with `acctBal` as the current balance and `availBal` as the available balance, and `TxnQuery` for each account over three Taipei calendar months (`startDate` `T00:00:00.000+08:00` through `endDate` `T23:59:59.999+08:00`, `refresh=true`). The balance as-of time is the HTTP `Date` header of `AcctQuery`. Foreign-currency accounts, time deposits, and loans are not collected.
- Fail-closed: a list whose `hasMore`, `hasNext`, `hasNextPage`, `isMore`, or `moreData` is true, whose `totalCount`, `totalRecords`, or `total` differs from the items returned, or that carries a `nextKey`, `nextPageKey`, or `continuationToken` fails as `incomplete-data`. An `AcctQuery` without items, an account number that repeats, a row whose `acctNo` differs from the queried account, or a `txnDateTime` without seconds fails.
- Assumptions:
  - Currency is fixed to TWD for `TwdDemandDepositDetail`, because it is the NT-dollar demand deposit service and carries no currency field. A `currency`, `curCode`, `currCode`, or `ccy` field on the account or the row, if present, is used instead.
  - `txnAmt` is kept as its source lexeme, possibly signed. The direction is always `unknown`, because all-set-tw documents no direction field.
  - The row key is the account number, the Taipei time of `txnDateTime` to the second (fractions dropped), `txnAmt`, the row's `acctBal`, and an occurrence count, as all-set-tw keys rows. `recNo` is never used.
  - `postedAt` is the date of `effectDateTime`, else the `txnDateTime` second.
  - The response shapes (`items`, `acctNo`, `acctBal`, `availBal`, `txnDateTime`, `effectDateTime`, `txnAmt`, `desc`, `txnTypeName`) come from all-set-tw's parser. No paging fields are documented; the flags above are guesses that fail closed.
