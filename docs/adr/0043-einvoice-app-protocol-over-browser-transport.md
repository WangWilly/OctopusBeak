# E-Invoice through its mobile App protocol over a browser transport

Status: accepted

## Decision

E-Invoice (財政部電子發票) moves from the website workflow to the mobile App's v2 HTTP protocol, the same protocol the TedLin1993/all-set-tw reference project (MIT, commit `a5c56e9`) implements in `apps/worker/src/sources/einvoice/v2-client.ts`. The client is reimplemented from the protocol, not ported. It replaces the website login and query; the two do not run side by side.

The App hosts sit behind Cloudflare bot protection that admits real browsers but rejects plain HTTP clients with a `403 Just a moment…` challenge. The transport is therefore a Playwright browser, not a bare HTTP client: login runs as an in-page `fetch` to `https://uia.einvoice.nat.gov.tw/mid/v1/login`, and invoice queries run as in-page `fetch` to `https://upi.einvoice.nat.gov.tw`. The query host rejects any request that carries an `Origin` header (`403 Invalid CORS request`); a native App sends none, so the workflow strips `Origin` and `Referer` at the CDP network layer (`Fetch.enable` + `Fetch.continueRequest`) before continuing each request. This reuses the browser's real TLS fingerprint, so no TLS spoofing, IP rotation, or Cloudflare Workers relay is involved.

The login envelope is an AES-GCM `ldata` payload with a SHA-256 seed derived from two random 16-character nonces. Invoice queries are HMAC-SHA-256 JWTs over a `comms` claim, signed with the session's `ssme` key. App version `6.800.2`, build `66`, `platform: android`, and a random Android-style device id generated per sign-in.

## Field coverage

A Phase 0 probe with the account owner's credentials returned `result: 0` and a full session. The header query returns every field the [canonical contract](../ledger/canonical/einvoice-contract.ts) requires:

- `sellerBan` (seller tax ID) and `sellerName`
- `invNum` (invoice number) and `invPeriod`
- `amount` (total) as a decimal string
- `invoiceTime` plus `invDate` (a full object with epoch-millisecond `time` and `timezoneOffset`)
- `invStatus` — observed value `開立已確認` for issued. The exact string for a voided invoice is not yet observed; the field is present and distinct, so voided will be recognised by a non-issued value once one is seen.
- The detail query (`/einvoice/carriers/query-invoices-details`) returns line items with `description`, `quantity`, `unitPrice`, and `amount`.
- Paging: the header query accepts `page` and returns rows until an empty page. The contract's `pages` array records each page's `rowCount` and marks the last page terminal. There is no server-supplied total count.

The login session also carries `need_change_pw` (observed `false`). The website's 資料設定 password-change redirect does not appear on this transport, so the App protocol sidesteps the website failure entirely.

## Device trust and session

Login is phone number plus password; there is no one-time code and no device registration, unlike TDCC ([ADR 0041](0041-tdcc-epassbook-app-protocol-source.md)), so a fresh random device id per sign-in is sufficient. A sign-in from this App signs the phone App out, which was accepted as a cost. The stored `einvoice_phone_number` and `einvoice_password` credentials are reused unchanged.

## Rollout

Phase 0 (the field probe) is complete and recorded in `docs/research/2026-10-10-einvoice-app-protocol-probe.md`. Phase 1 replaces the website login, query, and mapping inside `src/workflows/einvoice-personal-invoices.ts` with the App protocol, keeping the existing source connection, Financial Account, and canonical admission. `mapCanonicalEInvoiceRecord` gains a mapping from the App status vocabulary (`開立已確認`, and the void string once observed) to `issued` / `revoked`.

## Considered options

- **Keep the website workflow.** Rejected. It fails with `source-collection-failed` / `authentication-timeout` after the login redirects to the 資料設定 password-change page, and its field coverage is weaker than the App protocol.
- **Call the App protocol directly over HTTP, as all-set-tw does.** Rejected. `uia` and `upi` both answer a non-browser client with a Cloudflare managed challenge.
- **Use the older App protocol at `invoiceapp.nat.gov.tw/UIAPAPP/api/`.** Rejected. The endpoint is reachable but returns `6603` (`目前系統繁忙，請稍後再試。`), which the all-set-tw client already classifies as protocol rejection rather than a credential error.
- **Spoof TLS fingerprints, rotate IPs, or relay through Cloudflare Workers.** Rejected. The browser transport is sufficient and stays within the existing Playwright runtime.
- **Run both the website and the App protocol.** Rejected. Only the App protocol runs.

## Consequences

- The phone App and this App cannot stay signed in at once; the UI must say so, as it does for TDCC.
- A future App update can break sync until a release ships. The failure is a specific outcome. The `provider-protocol-outdated` explanation in `src/lib/automation/workflow-failures.ts` currently names only TDCC and must be generalised to cover E-Invoice.
- Cloudflare could later extend its challenge to the browser transport. This is a known residual risk, not a current failure.
- The App protocol must still be matched to the contract's revocation path once a voided invoice is observed; until then the void status string is documented as unverified rather than guessed.
