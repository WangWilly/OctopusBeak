# Any source may use its mobile App protocol, sent over a browser transport by default

Status: accepted

## Decision

Any supported source may collect through its reverse-engineered mobile App protocol instead of its website, not only E-Invoice ([ADR 0043](0043-einvoice-app-protocol-over-browser-transport.md)) and TDCC ([ADR 0041](0041-tdcc-epassbook-app-protocol-source.md)). This generalizes those two decisions into a standing policy: choosing the App protocol for a source no longer needs its own justification ADR, only its probe record under `docs/research/`.

The default transport is the one ADR 0043 established: request signing, encryption, and envelope construction run in Node, and the request leaves through an in-page `fetch` in the App-owned Playwright browser, so it carries a real browser's TLS fingerprint. A source moves to a plain Node HTTP client only after a probe shows its hosts accept a non-browser client. App versions, device identities, public keys, and signing constants are pinned per source, and a protocol the server no longer accepts fails with the typed `provider-protocol-outdated` outcome rather than a guessed retry.

## Considered options

- **Browser workflows only.** Rejected. Several Taiwan banks expose card bills, realtime data, or time deposits more completely through their App API than through their website, and the TedLin1993/all-set-tw reference shows the App protocols of CTBC, SKBank, Mega, and O-Bank are implementable.
- **App protocol case by case, one ADR per source.** Rejected as redundant once ADRs 0041 and 0043 established the pattern.
- **Plain Node HTTP by default.** Rejected. E-Invoice's hosts answer non-browser clients with a Cloudflare challenge, and the browser transport already exists in the runtime.

## Consequences

- An App update can break a source until a release ships with new pinned constants. Each App-protocol source must surface that as `provider-protocol-outdated`.
- Impersonating an App client carries more terms-of-service exposure than driving the website. This was accepted.
- When an App protocol signs the phone App out or registers a device, the sign-in settings must say so, as they do for TDCC and E-Invoice.
