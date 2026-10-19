# CTBC App transport probe: plain Node HTTP is accepted before sign-in

Status: Evidence, 2026-10-18. Supports the transport choice of the CTBC credit-card preview source (`ctbc-credit-card`) under [ADR 0044](../adr/0044-app-protocol-sources-over-browser-transport.md).

## Question

ADR 0044 sends App protocols through the App-owned browser by default, and allows a plain Node HTTP client only after a probe shows that the source's hosts accept a non-browser client. Does the MobileFirst server of CTBC's mobile banking App at `https://eb.ctbcbank.com/IMP` answer a plain Node client? And how does it answer an App version it no longer accepts?

## Method

`scripts/ctbc-app-transport-probe.ts` sends the pre-login sequence that the TedLin1993/all-set-tw CTBC connector (MIT, commit `f05dd30`, `apps/worker/src/sources/ctbc/mobile-api.ts`) sends, through Node's built-in `fetch` with a small cookie jar:

1. `POST oauth/token` with the App's public client credentials (`EBMW_Adapter`, scope `PUBLIC`).
2. `POST main/init` with a random device code and the Pixel 8 device description.
3. `POST api/adapters/EBMW_Adapter/resource/ebmwResource` with `X-Request-Type: handshakewb`, an empty `rqData` envelope, and the SHA-256 `checksum` header.

It sends no credentials. It prints each status, a challenge-page marker, a few non-secret markers (result codes, `appVersionValidate`, whether a token or seed came back), and the top-level field names from `inventoryFields`. `--fields` prints the full inventories.

Run it with:

```sh
node --no-warnings --experimental-strip-types scripts/ctbc-app-transport-probe.ts
CTBC_PROBE_APP_VERSION=5.2.0 node --no-warnings --experimental-strip-types scripts/ctbc-app-transport-probe.ts
```

The probe ran on 2026-10-18 between 10:50 and 10:58 UTC, from Node 25.9.0 on the developer's macOS machine: twice with the pinned App version `5.2.26`, and once each with `appVer` `5.2.27`, `9.9.9`, `5.2.25`, `5.2.0`, `5.1.0`, `5.0.0`, `4.0.0`, and `1.0.0`.

## Result

| Step | Request | Status | Shape match |
| --- | --- | --- | --- |
| 1 | `POST oauth/token` | 200 JSON | `access_token`, `expires_in`, `scope` `PUBLIC`, `token_type` `Bearer` |
| 2 | `POST main/init` | 200 JSON | `statusCode` `0000`, `clientParameter`, `specialParameter`, `role`, `fixNumberS` |
| 3 | `POST ebmwResource` (`handshakewb`) | 200 JSON | `success` `true`, `appVersionValidate`, `serverTime`, `rsData` (App configuration, `seed` empty) |

No response was a WAF challenge or an HTML page, and no request was redirected. The handshake returned no `token` and an empty `rsData.seed`, as all-set-tw's notes record for an unbound client.

`appVersionValidate` depends only on the envelope's `appVer`:

| `appVer` | `appVersionValidate` |
| --- | --- |
| `5.2.26` (pinned), `5.2.25`, `5.2.27`, `9.9.9` | `0` |
| `5.2.0`, `5.1.0`, `5.0.0`, `4.0.0`, `1.0.0` | `2` |

Every handshake still answered HTTP 200 with `success` `true`. The server does not refuse an outdated App at the transport layer; it reports it in `appVersionValidate`.

## Decision

- The CTBC credit-card preview source uses the plain Node HTTP transport (`nodeHttp` in `src/lib/preview-sources/node-http.ts`). It sends no `Origin` or `Referer`, as the native App sends neither.
- The source pins `appVer` `5.2.26` and `webVer` `(0812)`. A handshake whose `appVersionValidate` is not `0` ends the run as `provider-protocol-outdated` before sign-in. The value `1` was never observed; it is treated as outdated too, because only `0` is known to mean accepted.

## Limits

- The probe covers pre-login requests only. Whether CTBC treats a non-browser client differently after sign-in is unverified. If it does, the source fails with a typed outcome and a structure report, and the fix is to pass `browserHttp` instead of `nodeHttp`.
- One machine and one day were probed.
