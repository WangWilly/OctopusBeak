# Opt-in anonymous daily usage ping

Status: accepted

Amends the Local-only privacy positioning in [`PRODUCT.md`](../../PRODUCT.md).

We want to know two things: how many people download OctopusBeak, and how many keep using it. Downloads come from GitHub Release asset counts, which the `Download Stats` workflow snapshots daily without touching the app (see [Download statistics](../runbooks/download-stats.md)). Downloads say nothing about use: a download may never be installed, or be opened once and deleted. The app's requests today go only to financial institutions and exchange-rate sources on the person's behalf; none reaches us, so active use is invisible.

Any answer to "who keeps using it" needs the app to send something off the Mac, which the first Product Principle ("Your data never leaves the Mac") rules out as written. We keep the principle for everything the person puts into the app and allow one narrow, consented exception.

**When the person turns on usage statistics, the app sends one anonymous ping per local calendar day. It is off by default.**

- **Consent.** First-run Welcome offers the choice, unselected, next to the bank-automation choice. Settings holds the same switch for everyone, including people who installed before this decision. Existing installs are never switched on and are not prompted again.
- **The payload is fixed and carries no identifier.** Exactly these fields, every one of them an allow-listed value:

  | Field | Example | Purpose |
  | --- | --- | --- |
  | `schema` | `1` | Payload version |
  | `appVersion` | `0.9.5` | Version adoption |
  | `osVersion` | `15.4` | macOS major and minor only |
  | `arch` | `arm64` | Release target |
  | `locale` | `zh-TW` | `zh-TW` or `en` |
  | `cohortWeek` | `2026-W44` | ISO week of the app's first launch, for retention |
  | `firstThisWeek` | `true` | First ping of this ISO week |
  | `firstThisMonth` | `false` | First ping of this calendar month |

  No install ID, no account, source, institution, balance, run, failure, or count of anything in the ledger. The receiving date is the day.
- **Counting without an identifier.** Each install pings at most once a local day, so pings per day approximate daily active users. Pings with `firstThisWeek` count weekly active users and pings with `firstThisMonth` count monthly active users. Grouping those by `cohortWeek` gives retention: of the installs first launched in week N, how many were active in a later week or month.
- **Local state.** The first-launch week and the last ping date are stored in the app's own settings, not in the ledger. They never leave the Mac except as the fields above.
- **Transport.** One HTTPS `POST` with a JSON body to a fixed endpoint built into the app, no cookies, a 5-second timeout. A day counts as sent only after a 2xx response; a failure is retried at the next hourly check on the same day and dropped at the end of it. Failures are silent to the person and are logged without the payload.
- **Receiver.** A Cloudflare Worker validates the body against the same allow-list, rejects anything else, and writes one Workers Analytics Engine data point per accepted ping. It does not read or store the client IP address or any request header beyond the body. A daily scheduled rollup copies the per-day aggregates to D1, because Analytics Engine keeps raw points for only three months.
- **Visibility.** Settings shows the exact JSON the next ping will send. One module builds the payload, and a check fails if it produces a field outside the allow-list or if any other renderer or main-process code makes a network request to the usage endpoint.

## Considered options

- **Download counts only.** Rejected as the only measure. They cannot tell a one-time download from a person who uses the app every week.
- **A random install ID.** Rejected. It makes exact MAU and retention easy, but it is a persistent identifier tied to a person's financial app; the week and month flags answer the same questions with aggregates.
- **On by default with an opt-out.** Rejected. It contradicts the Local-only privacy positioning that sets the product apart, and the people who choose a local-only finance app are the ones most likely to object.
- **A third-party analytics or crash SDK** (PostHog, Sentry, Firebase). Rejected. Their payloads, breadcrumbs, and stack traces are hard to bound, and a stack trace from this app can carry financial data.
- **Count requests to an update feed.** Deferred. The app has no update check, and building one only to count users would hide the purpose of the request.

## Consequences

- The numbers count consenting installs only. They are a lower bound and a trend, not the true user count; reports must say so.
- `PRODUCT.md` Principle 1 and the Local-only privacy commitment, and the privacy sections of `README.md` and `README.en.md`, must state the exception: financial data, credentials, and run results never leave the Mac; anonymous usage statistics are sent only when the person turns them on.
- An install that stays offline, or is opened on fewer days than it is used (the ping needs the app running), is undercounted. Two Macs of one person count as two installs.
- Adding a field is a new `schema` version and needs a new ADR or an amendment to this one. Product events such as source success rates are out of scope.
- The app gains its first request to a host we operate; the endpoint and the Cloudflare account become part of release operations.
