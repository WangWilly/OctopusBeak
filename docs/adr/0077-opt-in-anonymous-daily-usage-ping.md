# Opt-in anonymous daily usage ping

Status: accepted

Amends the Local-only privacy positioning in [`PRODUCT.md`](../../PRODUCT.md).

We want to know two things: how many people download OctopusBeak, and how many keep using it. Downloads come from GitHub Release asset counts, which the `Download Stats` workflow snapshots daily without touching the app (see [Download statistics](../runbooks/download-stats.md)). Downloads say nothing about use: a download may never be installed, or be opened once and deleted. The app's requests today go only to financial institutions and exchange-rate sources on the person's behalf; none reaches us, so active use is invisible.

Any answer to "who keeps using it" needs the app to send something off the Mac, which the first Product Principle ("Your data never leaves the Mac") rules out as written. We keep the principle for everything the person puts into the app and allow one narrow, consented exception.

**When the person turns on usage statistics, the app sends one anonymous ping per Asia/Taipei calendar day. It is off by default.**

- **Consent.** Every install, new or upgraded, is asked once in a dialog whether to turn usage statistics on. Neither answer is preselected and focus starts on "No thanks"; only an explicit answer closes it. It waits until the First-run Welcome and any active Onboarding Progression are over, so it never interrupts them. An install that has opted in, or whose person has answered the dialog or changed the switch in Settings, is never asked again (`USAGE_STATISTICS_PROMPTED`). Settings holds the same switch at all times. If recording the answer fails, the dialog returns on the next launch.
- **The payload is fixed and carries no identifier.** Exactly these fields, every one of them an allow-listed value:

  | Field | Example | Purpose |
  | --- | --- | --- |
  | `schema` | `1` | Payload version |
  | `appVersion` | `0.9.5` | Version adoption |
  | `osVersion` | `15.4` | macOS major and minor only |
  | `arch` | `arm64` | Release target |
  | `locale` | `zh-TW` | `zh-TW` when the macOS language is Chinese, else `en`, as for notifications |
  | `cohortWeek` | `2026-W44` | ISO week of the app's first launch, for retention |
  | `firstThisWeek` | `true` | First ping of this ISO week |
  | `firstThisMonth` | `false` | First ping of this calendar month |

  No install ID, no account, source, institution, balance, run, failure, or count of anything in the ledger. The receiving date is the day.
- **One calendar.** The app and the receiver both cut days, ISO weeks, and months in Asia/Taipei (a fixed UTC+8). With UTC days, two local days of a Taiwan user could land in one UTC day and be counted twice.
- **Counting without an identifier.** Each install pings at most once a day, so pings per day approximate daily active users. Pings with `firstThisWeek` count weekly active users and pings with `firstThisMonth` count monthly active users. Grouping those by `cohortWeek` gives retention: of the installs first launched in week N, how many were active in a later week or month.
- **Local state.** `USAGE_STATISTICS_ENABLED`, `USAGE_STATISTICS_PROMPTED`, `USAGE_COHORT_WEEK`, and `USAGE_LAST_SENT_DAY` live in the app's `settings.json`, not in the ledger. The cohort week is fixed the first time a version with this decision starts, from the creation time of the app's data folder, whether or not statistics are on; it is clamped to the range the receiver accepts. These values never leave the Mac except as the fields above.
- **Only released builds ping.** The main process checks once an hour and when settings change; development builds (`app.isPackaged` false) and test fixtures never start the pinger.
- **Transport.** One HTTPS `POST` with a JSON body to the endpoint embedded at build time, no cookies, a 5-second timeout. A day counts as sent only after a 2xx response. `429`, `503`, and network failures are retried at the next hourly check on the same day and dropped at the end of it; any other 4xx is not retried that day; `410` stops pinging for good. Failures are silent to the person and are logged without the payload.
- **Endpoint at build time.** The release workflow passes the `OCTOPUSBEAK_USAGE_PING_URL` secret to the main-process build, which embeds it; the public source never names the endpoint, which narrows who learns where to aim forged pings without reading a built app. The address is still in every installed app, so this reduces exposure rather than hiding it, and the receiver's protections do not rely on it. The release fails without the secret; a build without it never asks or sends.
- **Receiver.** A Cloudflare Worker on `workers.dev`, kept in the private repository `WangWilly/OctopusBeak-Telemetry` and deployed by its GitHub Actions workflow after reviewer approval. Its README holds the ping contract. For each accepted ping it adds one to a D1 row keyed by the Taipei day and the payload values; no individual ping is stored, so the database holds only daily aggregates. Workers logs and observability are off. The connecting address is used only as the rate-limit key and is never stored. A nightly workflow in that repository renders the daily, weekly, and monthly counts and the cohort retention table to its `reports` branch, so the numbers stay private.
- **Protection.** A ping cannot be authenticated: the app is open source and any embedded key could be extracted. The receiver bounds what a forged ping can do instead:
  - Every field accepts only a short list of values. `appVersion` must be a published OctopusBeak release, read from the GitHub API and cached for 10 minutes; `cohortWeek` lies between the first release week and the current week. The aggregate table therefore cannot grow beyond a known size, and no free-form value is stored.
  - Only `POST` with `application/json`, a body of at most 1 KB, and no `Origin` header. The app sends from the Electron main process, which sets no `Origin`; a browser always does.
  - Two requests per 60 seconds per address, through the Workers Rate Limiting binding.
  - The Workers Free plan fails requests above its daily limit instead of billing them.
  - The report marks a day with more than three times the median of the 7 days before it as suspect, and such a day can be deleted.
  - A `PINGS_ACCEPTED` switch makes every ping get `410`, which retires collection without an app release.
- **Visibility.** Settings shows the exact JSON the next ping will send. One module, `src/lib/settings/usage-statistics.ts`, builds and sends the payload; its check fails if the payload has a field outside the allow-list, if any file under `src/` or `electron/` names the endpoint host, or if any other file reads its build constant.

## Considered options

- **Download counts only.** Rejected as the only measure. They cannot tell a one-time download from a person who uses the app every week.
- **Embedded API key, request signing, or Apple DeviceCheck.** Rejected. A key or signing secret in an open-source app can be extracted, so it only adds a false sense of authentication. DeviceCheck needs a native module and a device attestation through Apple, which is the identifier this decision avoids.
- **Daily-salted IP hashes for de-duplication**, as Plausible does. Deferred. It resists forged pings best, but keeps a value derived from the address for a day. Revisit with an amendment only if forged pings become a real problem; a proof-of-work on the ping is the other candidate.
- **Workers Analytics Engine with a daily rollup to D1.** Rejected. It stores every ping as a data point for three months and needs a SQL API token and a scheduled rollup; counting straight into D1 aggregates stores less and runs less.
- **A random install ID.** Rejected. It makes exact MAU and retention easy, but it is a persistent identifier tied to a person's financial app; the week and month flags answer the same questions with aggregates.
- **On by default with an opt-out.** Rejected. It contradicts the Local-only privacy positioning that sets the product apart, and the people who choose a local-only finance app are the ones most likely to object.
- **A third-party analytics or crash SDK** (PostHog, Sentry, Firebase). Rejected. Their payloads, breadcrumbs, and stack traces are hard to bound, and a stack trace from this app can carry financial data.
- **Endpoint written in the source.** Rejected. It is more transparent to people who read the code, but it hands every reader the address to aim forged pings at; embedding it at build time keeps it out of the repository.
- **Ask only in the First-run Welcome, never existing installs.** Rejected. Most people already using the app would never find the switch in Settings, and the counts would describe almost nobody. One dialog for every install, once, asks everyone the same question.
- **Count requests to an update feed.** Deferred. The app has no update check, and building one only to count users would hide the purpose of the request.

## Consequences

- The numbers count consenting installs only, and pings are unauthenticated. They are a lower bound and a trend, not the true user count; reports must say so.
- `PRODUCT.md` Principle 1 and the Local-only privacy commitment, and the privacy sections of `README.md` and `README.en.md`, must state the exception: financial data, credentials, and run results never leave the Mac; anonymous usage statistics are sent only when the person turns them on.
- An install that stays offline, or is opened on fewer days than it is used (the ping needs the app running), is undercounted. Two Macs of one person count as two installs.
- Adding a field is a new `schema` version and needs a new ADR or an amendment to this one. Product events such as source success rates are out of scope.
- The app gains its first request to a host we operate; the endpoint, the Cloudflare account, and the private telemetry repository become part of release operations. Cloudflare's edge sees the connecting address of every ping, as it does for any site it serves; the privacy text says so.
- The newest 100 releases are accepted. An app more than 100 releases old gets `503` and keeps retrying within each day until it updates.
