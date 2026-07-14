# Task 4 Report: Verified Credit-Card Capture Workflows

Commit: `a52a9730d5f4f67674b94b412844ac41466b25da` (`feat: emit verified credit card captures`)

## Changes

- Esun uses its default one-year query only for a full capture. It requires the returned grid state to be page `1` with page size `2147483647`; date overrides and unproven grids emit `snapshotMode: "partial"` only.
- Fubon writes a full pair only after all six period tabs and the unbilled grid prove the same page/size state with no card filters. `網路繳款`, `行動銀行繳款`, and `前期應繳總額` are excluded before date-row parsing. Online banking payment metadata uses `paid_by_online_banking`.
- Yuanta traverses every exposed month plus unbilled when unscoped. Any pager in a returned response throws before sidecars are written.
- Full pairs share a UUID `captureId`, ISO `capturedAt`, `captureKinds: ["billed", "unbilled"]`, the same card-key set, and per-sidecar `cardRowCounts`. Partial sidecars omit those full-only fields.

## Tested selectors and capture evidence

- Esun reads `#fcm01004\\:gridList_0_DataGridBody`; the live result exposed `currentPage: "1"` and `currentPageSize: "2147483647"` through the statement form controls.
- Fubon reads the existing billed and unbilled detail tables; all six billed tabs and the unbilled grid exposed `currentPage: "1"` and `currentPageSize: "2147483647"`.
- Yuanta keeps the existing `form#mform [name="cdHistoryQuery"]` form-response flow. The live result exposed six month options and no pager response; the unbilled response also had no pager.

## Checks

### RED

```sh
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts \
  && node --no-warnings --experimental-strip-types src/workflows/fubon-credit-card-statements.check.ts \
  && node --no-warnings --experimental-strip-types src/workflows/yuanta-credit-card-statements.check.ts
```

Exit `1`: Esun did not yet export `isEsunCompleteGrid`.

### GREEN

```sh
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts \
  && node --no-warnings --experimental-strip-types src/workflows/fubon-credit-card-statements.check.ts \
  && node --no-warnings --experimental-strip-types src/workflows/yuanta-credit-card-statements.check.ts
npm run typecheck
git diff --check
git diff --cached --check
```

All exited `0`; typecheck reported `0 errors and 0 warnings`.

## Fresh live validation

```sh
npx libretto status
npx libretto run src/workflows/esun-credit-card-statements.ts --session esun-capture-validate --stay-open-on-success
npx libretto run src/workflows/fubon-credit-card-statements.ts --session fubon-capture-validate --stay-open-on-success
npx libretto resume --session fubon-capture-validate
npx libretto run src/workflows/yuanta-credit-card-statements.ts --session yuanta-capture-validate --stay-open-on-success
npx libretto resume --session yuanta-capture-validate
```

- Initial status: no sessions.
- Esun completed without a CAPTCHA pause and produced a full pair with matching ID/time/kinds/card keys.
- Fubon paused for the user CAPTCHA in `fubon-capture-validate`; one confirmed resume completed. Its full pair had matching ID/time/kinds/card keys, and the billed CSV contained none of the three summary/payment descriptions.
- Yuanta paused for the user CAPTCHA in `yuanta-capture-validate`; one confirmed resume completed. It found and traversed six months, collected unbilled data, and produced a matching full pair.
- Each disposable session was closed. Final status: no open sessions.

## Remaining live validation state

None. No pagination selector was invented: Esun and Fubon fail closed to partial evidence when their existing page-state controls cannot prove completeness; Yuanta rejects any response containing an untraversed pager.

## Follow-up reviewer fixes

Implementation commit: `0d1a639f8abce172c92ba1b51e5a38980988fabc` (`fix: harden credit card capture workflows`)

- Yuanta now submits every selected exposed month option, including index `0`, through one fail-closed pager guard; the initial response is used only to discover month options.
- ESun and Fubon grid-state readers iterate locators and use `getAttribute()` / `inputValue()` instead of DOM batch evaluation.
- Fubon’s check directly exercises summary/payment labels and verifies those rows are excluded by the transaction filter. Yuanta’s check uses no-pager and truncated-pager HTML fixtures and verifies every month, including index `0`, is submitted.

## Follow-up checks

### RED

The new Yuanta traversal check failed before implementation with `TypeError: submitCreditCardMonthOptions is not a function`.

### GREEN

```sh
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/fubon-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-credit-card-statements.check.ts
npm run typecheck
git diff --check
git diff --cached --check
```

All exited `0`; typecheck reported `0 errors and 0 warnings`.
