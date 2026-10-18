# O-Bank transport probe: plain Node HTTP is accepted before sign-in

Status: Evidence, 2026-10-18. Supports the transport choice of the O-Bank preview source (`obank-deposit`) under [ADR 0044](../adr/0044-app-protocol-sources-over-browser-transport.md).

## Question

ADR 0044 sends App and web protocols through the App-owned browser by default, and allows a plain Node HTTP client only after a probe shows that the source's hosts accept a non-browser client. Does O-Bank's online banking API at `https://www.o-bank.com/ebank/ixtein` answer a plain Node client?

## Method

`scripts/obank-transport-probe.ts` sends the pre-login sequence that the TedLin1993/all-set-tw O-Bank connector (MIT, commit `f05dd30`, `apps/worker/src/sources/obank/mobile-api.ts`) sends, through Node's built-in `fetch` with a small cookie jar. It sends no credentials and no CAPTCHA answer. It prints each status, a challenge-page marker, a few non-secret markers (result codes, the CAPTCHA media type, the time-factor digit pattern, the public-key PEM header), and a shape-only field inventory from `inventoryFields`.

Run it with:

```sh
node --no-warnings --experimental-strip-types scripts/obank-transport-probe.ts
```

The probe ran three times on 2026-10-18 between 08:29 and 08:30 UTC, from Node 25.9.0 on the developer's macOS machine. All three runs gave the same result.

## Result

| Step | Request | Status | Shape match |
| --- | --- | --- | --- |
| 1 | `GET v2/adapters/ebank/ChannelAdapter/getChannel` | 200 JSON | `channel` (empty string) |
| 2 | `POST oauth/token` (client credentials, `browser`/`PUBLIC`) | 200 JSON | `access_token`, `expires_in`, `scope` `PUBLIC`, `token_type` |
| 3 | `AuthenticationAdapter/sendAndReceiveNoSec` `common/CMN01003/010` | 200 JSON | `statusCode` `0000`, `rsData.params.e2e` is a `-----BEGIN RSA PUBLIC KEY-----` PEM |
| 4 | `AuthenticationAdapter/emptyLogin` | 200 JSON | `authStatus` `required` |
| 5 | `sendAndReceiveNoSec` `fco/FCO02001/012` | 200 JSON | `statusCode` `0000` |
| 6 | `sendAndReceiveNoSec` `common/CMN01004/010` | 200 JSON | `statusCode` `0000` |
| 7 | `sendAndReceiveNoSec` `common/CMN01001/010` (CAPTCHA) | 200 JSON | `statusCode` `0000`, `rsData.img` is a `data:image/jpeg;base64,` URL |
| 8 | `sendAndReceiveNoSec` `common/EndToEnd/020` (time factor) | 200 JSON | `statusCode` `0000`, `rsData.timeFactor` has the form `9999-99-99 99:99:99` |

No response was a Cloudflare or other WAF challenge page, and no request was redirected. Every adapter envelope carried `isSuccessful`, `statusCode`, `statusDesc`, `token`, `validateError`, and `rsData`, as all-set-tw parses them.

The preview source then ran its own sign-in code through the new Node transport, with a CAPTCHA solver that declines every challenge and with no credentials. It reached the same seven responses, all HTTP 200, and stopped at the CAPTCHA image, because the Node transport does not decode JPEG (see below). No login was submitted.

## Decision

The O-Bank preview source uses the plain Node HTTP transport (`nodeHttp` in `src/lib/preview-sources/node-http.ts`), as all-set-tw does. Requests carry the web page's `Origin` and `Referer`, because the desktop web client sends them.

## Public page evidence

The web banking page's controller and template are public, and fix field names that all-set-tw only lists as candidates:

- `html/FAO/FAO01012.js` sends `fao/FAO01012/010` with `queryType`, `startDate`, `endDate`, `subAccountItemNo`, `curry`, and `initQuery` `N` for a history query. It reads `userAccounts[].accountItems[]` with `accountItemNo`, `curr`, `aliasName`, `displayActBalNoCurr` (shown as 可用餘額), and `displayWorkBalNoCurr` (shown as 帳上餘額). The date pickers allow a range back to `prevTwoYearDays`.
- `html/FAO/FAO01012_010.html` renders `despositTxnDetails[]` rows from `txnDate`, `txnDesc`, `diplayAcct`, `displayMemo`, `displayTxnAmount`, and `displayClsBal`, and binds `startDate` and `endDate` from the response. It shows no paging control and no row-count field.

Both were fetched from `https://www.o-bank.com/ebank/apps/services/www/ibmb/desktopbrowser/default/html/FAO/` on 2026-10-18 and read as text only.

## Limits

- The probe covers pre-login requests only. Whether O-Bank treats a non-browser client differently after sign-in is unverified. If it does, the source fails with a typed outcome and a structure report, and the fix is to pass `browserHttp` instead of `nodeHttp`.
- The CAPTCHA is a JPEG. `nodeHttp` passes PNG through and refuses other formats, so a future calibrated O-Bank CAPTCHA family needs a JPEG decoder in Node, or the browser transport for the decode.
- One machine and one day were probed.
