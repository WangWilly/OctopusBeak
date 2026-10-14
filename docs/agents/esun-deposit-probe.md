# Running the E.SUN deposit probe

The E.SUN deposit probe is a development-only command for Phase 0 of issue #219. It signs in to E.SUN online banking with the same login code as the credit-card workflow in `src/workflows/esun-credit-card-statements.ts`. It then calls E.SUN's deposit portal endpoints from inside the signed-in page and prints a sanitized structural report. Phase 1 uses the report to design the Source Contract for TWD and foreign-currency deposits. The probe never writes to the canonical store, writes no files, and the installer does not include it.

## Before you run it

1. Have your E.SUN user ID, user name, and password ready.
2. Close other E.SUN online banking sessions. E.SUN allows one session at a time. If E.SUN reports a duplicate sign-in, the probe confirms the new sign-in, which ends the other session.

## Run the probe

Put the credentials in the environment without typing them on the command line. In zsh:

```sh
read -rs "LIBRETTO_CLOUD_ESUN_USER_ID?E.SUN user ID: "; echo
read -rs "LIBRETTO_CLOUD_ESUN_ACCOUNT?E.SUN user name: "; echo
read -rs "LIBRETTO_CLOUD_ESUN_PASSWORD?E.SUN password: "; echo
export LIBRETTO_CLOUD_ESUN_USER_ID LIBRETTO_CLOUD_ESUN_ACCOUNT LIBRETTO_CLOUD_ESUN_PASSWORD
npm run probe:esun-deposit -- --allow-live-source
```

`--help` prints the usage and exits without network access. `--headless` hides the browser window. The probe opens the same visible, non-persistent development browser as `npm run workflow:dev`, with the `esun-login` browser profile. Stage events go to stderr. The report goes to stdout as JSON.

The probe does these steps in order:

1. It signs in at `https://ebank.esunbank.com.tw/index.jsp`. If E.SUN shows a CAPTCHA, OTP, device, or other unexpected page, the probe prints the same `esun-post-login-*` events as the credit-card workflow and stops before the report.
2. It waits for the portal session (`window.mibApiService.uuid`) on the signed-in page.
3. For TWD (`tw`) and then foreign currency (`fr`), it calls three `/esb/` endpoints with an in-page `fetch`:
   - `mib-ctw-portal/ctw01/ctw01002/home/init` resets the deposit task flow.
   - `.../home/preQueryTWTransactionDetail` or `.../home/preQueryFRTransactionDetail` with `{ account: null }` returns the default account, the account list, and balances.
   - `.../search/queryTWTransactionDetail` or `.../search/queryFRTransactionDetail` returns the default account's transactions for the last 31 days, first page of 100.

The account number passes from the pre-query to the search in memory only. If E.SUN answers `S001` with its "no TWD account" or "no foreign-currency account" notice, the step is `not-held` and the probe continues. Any other failure stops every later call.

The exit code is 0 when every step succeeded or was `not-held`, 1 when a step failed or sign-in failed, and 2 for a usage error or a missing environment variable.

## Output

The report has these top-level fields:

- `complete`: whether every step succeeded or was `not-held`.
- `steps`: one entry per endpoint call, with the step name, endpoint path, HTTP status, result code, outcome, and field inventory. A failed step names its reason: `http-status`, `non-json`, `network-error`, `portal-session-missing`, `envelope-invalid`, or `result-code`. A later step shows `skipped` with `earlier-step-failed`.
- `observedRequests`: up to 80 `METHOD path status` lines for the portal's own XHR and fetch calls during the run, without query strings or bodies. These show which other portal endpoints exist for later phases.

The field inventory lists every JSON path, with array items collapsed to `[]`. For each path, it records:

- `types`, `present`, and `of` (how many times the path appeared, out of how many parent objects).
- `forms`: fixed labels for the value's form, such as `digits`, `decimal-grouped`, `date-slash`, `masked`, `han-text`, `integer-negative`, or `code`. A label never contains the value's characters.
- `length`: the shortest and longest string length.
- `items`: the smallest and largest array length.
- `values`: distinct values, only for keys that name a code (such as `currency` or `accountType`) or contain no word for an identifier, name, amount, balance, date, token, or free text. Every value must be a short upper-case ASCII code without four consecutive digits, and a field lists at most 12. If one value fails, the field lists none.

A key that is not a plain identifier, or contains four consecutive digits, appears as `{key}`. A path segment with six consecutive digits, or only digits, appears as `{segment}`. The result code appears only when it is at most two letters followed by at most four digits, or at most four letters. Otherwise it shows `withheld`. The report never contains account numbers, names, aliases, amounts, balances, dates, remarks, or tokens.

## What to paste back

Before you paste, search the report for long digit runs:

```sh
npm run -s probe:esun-deposit -- --allow-live-source > esun-deposit-probe.json
grep -nE '[0-9]{4,}' esun-deposit-probe.json
```

The only matches should be `resultCode` lines such as `"0000"` and endpoint paths such as `ctw01002`. If anything else matches, do not paste the report. Report the matching path name instead. Otherwise, paste the whole JSON and the `event` lines from the terminal into issue #219, then delete the file.
