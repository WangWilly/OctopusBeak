# Building on Preview Sources

Status: Current

A Preview Source collects balances and transactions for an Institution that no live-verified source contract covers. Its data goes to separate preview tables and never reaches canonical admission. See [ADR 0047](../adr/0047-preview-sources-outside-canonical-admission.md) for the decision and `CONTEXT.md` for the terms *Preview features*, *Preview source*, and *Preview financial data*.

This guide describes the seam that display, structure-report, and connector work builds on. Do not edit canonical admission, Source Capture, or source contract catalog code for preview work.

## Invariants

- Preview data is written only to `preview_accounts`, `preview_balance_observations`, and `preview_transactions`. These tables live in the App's PGlite database and are created by the `preview-financial-data-v1` operational migration.
- A row without an ISO 4217 currency is refused. Amounts are exact decimal strings such as `"1234.50"`, never numbers. Both the port and the table `CHECK` constraints enforce this.
- A transaction direction is `inflow`, `outflow`, or `unknown`. Use `unknown` when the source does not say. Never infer a direction from the sign.
- A preview workflow never receives `financialCommit`. Its context has a `preview` writer bound to its own source.
- When the Preview features setting is off, preview sources are absent from sign-in settings, Sync all, Scheduled Collection, and direct runs. Their data is excluded from every read and is retained.
- While an enabled verified source covers the same Institution and product, the preview source is hidden, is not collected, and its data is not read.

## The seam

| Need | Use | File |
| --- | --- | --- |
| Register a source | Add a `PreviewSource` to `PRODUCTION_PREVIEW_SOURCES` | `src/lib/preview-sources/registry.ts` |
| Write collected data | `context.preview.write(collection)` inside `PreviewSource.run` | `src/lib/preview-sources/workflow.ts` |
| Data shapes | `PreviewCollection`, `PreviewAccount`, `PreviewBalanceObservation`, `PreviewTransaction` | `src/ledger/pglite/preview-financial-data.ts` |
| Decide what is visible | `currentPreviewVisibility()` in the main process, or the pure `previewVisibility(...)` | `src/lib/automation/server/settings.ts`, `src/lib/preview-sources/visibility.ts` |
| Read preview data | `preview.accounts(visibility)` and `preview.transactions(visibility, previewAccountId)` on the operational provider | `electron/pglite-operational-rpc.ts` |
| Verified coverage | `VERIFIED_SOURCE_COVERAGE`, keyed by verified credential group | `src/lib/preview-sources/visibility.ts` |
| Delete all preview data | `settings.deletePreviewData()` in the renderer, `deleteAllPreviewData` in main | `src/lib/preview-sources/delete-preview-data.ts` |
| Record a response for a structure report | `context.preview.observe({ endpoint, status, body })` inside `PreviewSource.run` | `src/lib/preview-sources/workflow.ts` |
| Sanitize, bound, and share a report | `previewResponseShapes`, `previewStructureReports`, `previewStructureReportIssueUrl` | `src/lib/preview-sources/structure-report.ts` |

`PreviewVisibility` is the single query-level predicate: `{ sourceIds }`. A read returns rows only for the listed sources, and an empty list returns nothing. Always compute it with `currentPreviewVisibility()` at read time, then pass it to the read. Do not cache it across a settings change; the App marks data stale (`preview-data-changed`) when the toggle changes or preview data is deleted.

The main process reaches the port as `pgliteOperational.provider.preview`. A workflow child reaches the same port through the authenticated child RPC, and the runtime injects it only into definitions with `requiresPreviewWrite: true`.

## Structure reports

When a preview run fails, the workflow worker takes the observed responses with `takePreviewObservations(error)` and turns them into shape-only inventories with the E.SUN deposit probe's sanitizer (`src/lib/preview-sources/response-shape.ts`). Raw bodies never leave the worker. The failed frame carries only the inventories, and the main process validates them again before it accepts them.

The main process keeps one report per preview task, in memory, for the latest run of that task. A new run of the task drops the previous report, and a restart drops all of them. Reports are not written to the database. The report holds at most 50 responses and at most 48,000 characters of inventories, so it fits in a GitHub issue body; older responses are dropped first and counted in `omittedResponses`.

The run details show 「分享結構報告」 for a failed preview run. The dialog shows the full report, copies it, and opens a prefilled issue in the system browser. The issue URL carries a fixed title and template only, never the report. The App never sends the report itself.

## Add a bank

1. Create `src/lib/preview-sources/<bank>-source.ts` and export a `PreviewSource`:
   - `id` is lowercase kebab-case, such as `nextbank-deposit`. The task and workflow id become `preview-<id>`, and the enabled setting becomes `PREVIEW_<ID>_ENABLED`.
   - `institution` is an `InstitutionKey` from `src/lib/institutions/institution-tables.generated.ts`, such as `bank-823`. `product` is `deposit`.
   - Every credential field key starts with `PREVIEW_<ID>_`, for example `PREVIEW_NEXTBANK_DEPOSIT_PASSWORD`.
   - `startUrl` uses `https:`.
   - `run(context, input)` signs in with `input.credentials[<key>]`, collects, validates, and returns `await context.preview.write(collection)`.
2. Add the source to `PRODUCTION_PREVIEW_SOURCES` in `registry.ts`. The App derives the sign-in group, the task, the workflow registration, and the Sync all and Scheduled Collection membership from this entry.
3. If a verified source for the same Institution and product exists, confirm that `VERIFIED_SOURCE_COVERAGE` lists it. Otherwise the preview source stays visible beside it.
4. Add a `<bank>-source.check.ts` that runs the source through `runPreviewSource` from `preview-source-harness.ts`, with `fakeHttpOpener` routes built from the bank's documented response shapes. Assert the written collection, that `observe()` saw each response, and that a missing currency, a malformed amount, or an incomplete page fails before `write`.
5. Give the setup guide at least one official link, and add a section for the bank under [Sources](#sources).

### Building blocks

| Need | Use | File |
| --- | --- | --- |
| Send requests through the App-owned browser (ADR 0044) | `browserHttp`, or a fake `PreviewHttpOpener` in checks | `src/lib/preview-sources/browser-http.ts` |
| Parse JSON without losing number lexemes | `parseSourceJson` returns every JSON number as its source text | `src/lib/preview-sources/source-kit.ts` |
| Exact amounts, ISO currency, local dates, as-of time | `exactDecimal`, `currencyCode`, `localDate`, `observedAt` | `src/lib/preview-sources/source-kit.ts` |
| Typed failures | `fail(reason, detail)`, `refuseUnsupportedVerification`, `requireDeviceRegistration` | `src/lib/preview-sources/source-kit.ts` |
| Solve a CAPTCHA with a calibrated family | `calibratedCaptchaSolver(family)` and `solveChallengeRound` | `src/lib/preview-sources/preview-captcha.ts`, `src/lib/preview-sources/source-kit.ts` |

`fail` throws a `PreviewSourceFailure` whose reason maps to one typed outcome:

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
- Fail the run when a paging or truncation flag says data is incomplete. Never write a partial page set.
- Report a balance as of a source timestamp or the HTTP `Date` header when one is readable, else mark it `collection-time`.
- A CAPTCHA needs a calibrated on-device solver (ADR 0039). Until one exists for the bank, the source calls `refuseUnsupportedVerification` before sending any request. To measure a family for a bank, see [How to calibrate a preview source CAPTCHA](captcha-calibration.md).
- A calibrated family lives in `preview-captcha.ts`, with its geometry, answer length, charset, strategies, policy, and threshold. `calibratedCaptchaSolver` refuses a capture outside the family with `verification-configuration-failed` and returns `null` when no candidate is accepted. The challenge image must be PNG. Decode another format with the page's decoder, as calibration did.
- Get the answer through `solveChallengeRound`. It submits nothing itself, and it fails with `verification-exhausted` and the `verification-solver-exhausted` event when no challenge is accepted. Pass more than one challenge only when the bank can serve a fresh challenge without a sign-in (ADR 0046), and never more than `MAX_CHALLENGES_PER_ROUND`. Preview sources solve inside the run, so the host's CAPTCHA Retry Campaign does not start another round: each run is one round and submits at most one answer.

`assertPreviewRegistry` runs when `tasks.ts` loads. It rejects a duplicate id, a credential key outside the source's prefix, and a non-https start URL.

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
