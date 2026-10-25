# E.SUN redesigned credit-card capture

Status: accepted

E.SUN's 2026-09-22 banking redesign removed the legacy iframe and combined
maximum-size grid. The new card transaction view opens through the signed-in
home page and returns a paginated past-year timeline. A complete default
capture requires thirteen consecutive month buckets, from the current month
through the same month one year earlier, with every loaded page included and
the captured row count matching the admitted rows. Transaction status comes
from the source's explicit `已入帳` or `未入帳` field. The bill view supplies
issuer close date, due date, total, and minimum for settled cycles.

The integration introduces `esun/credit-card/human-attested-v3` and keeps the
v1 and v2 routes for historical captures. v3 permits the earlier complete
combined-grid proof and the redesigned bounded timeline proof. A new identity
epoch prevents records derived under different completeness evidence from
silently sharing source identity. The workflow observes the site's own POST
responses while using its UI for navigation and pagination. It does not
create extra banking requests. The signed-in dashboard's
`/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary` response carries
`usedCreditLimit` and `resultTime` together. A separate current-used-credit v2
route treats `resultTime` as Asia/Taipei provider query time and requires the
same response's HTTP Date to agree within five seconds. The old v1 route
remains scoped to the legacy grid. The v2 amount remains an issuer-reported
credit-used estimate, including unbilled purchases, rather than a posted
statement balance. A missing field, failed result code, invalid time, or
unexpected endpoint prevents this balance snapshot from admission.
No database migration is required; existing local data may be deleted and
rebuilt under v3.

The live review on 2026-09-24 observed one fresh run with 13 consecutive month
buckets, 3 response pages, 94 billed rows, 10 unbilled rows, and 12 available
bill periods. The user approved v3 admission from this evidence on the same
date. This confirms the implemented path for that run; any future
response with a gap, unsupported status, or incomplete date coverage fails
closed before canonical admission.

A second signed-in dashboard observation on 2026-09-24 found `resultCode=0000`,
`hasCreditCard=true`, both credit limit fields, `resultTime` at local 15:21:22,
and HTTP Date at 07:21:22 GMT in the same response. The user identified the
response timestamp as candidate query-time evidence; this route records both
timestamps and validates their agreement on every capture.

The 2026-09-24 desktop run completed through the App-owned PGlite worker.
The liability view showed 104 card transactions and one issuer-aggregate
used-credit estimate; the overview no longer listed E.SUN as an uncollected
source. During verification, a UTF-8 character split between socket chunks
corrupted one source string in transit. The child RPC now decodes UTF-8
incrementally in both directions, with a split-character regression check.

## 2026-09-30 coverage revision

The App's September 30 run authenticated but could not collect the thirteenth
month. Live inspection of three bank responses found twelve consecutive month
buckets, 2026/09 through 2025/10, including empty months. Their cursors were
1, 2, and 4. The bank's September 16 page bundle stops requesting another
page when its next cursor exceeds 4 and the loaded records have been consumed.
The workflow had scrolled to the bottom, so its wait for another response was
an incorrect assumption about the number of months. The September 24 live
review had thirteen buckets. The exact provider cutoff rule is not exposed;
date-dependent source coverage is plausible, but not asserted as a guarantee.

The user approved `esun/credit-card/human-attested-v4` on September 30. It
requires the current month first, either twelve or thirteen consecutive
months, all rows from every response, and the bank page's terminal cursor 4.
The capture records every month and the actual oldest month. Fewer months,
a gap, a reordered cursor, or a missing terminal cursor fails before Canonical
Financial Commit. Issuer settled-cycle summaries continue to be validated
independently. The v3 route remains historical; the primary-cardholder
portfolio identity epoch remains stable because this revision changes source
coverage evidence rather than account identity. No database migration is
required.

The first v4 App run passed source validation but its transaction and statement
commit conflicted with an existing v3 statement revision. The old statement
revision key covered stable transaction occurrence keys only; the same member
occurrences acquired new financial revision IDs under the v4 semantic contract.
The statement revision key now includes the capture contract version, issuer
summary values, and member evidence. A changed financial revision can therefore
create a new immutable statement revision while preserving the prior revision.

## 2026-10-25 oldest-month bucket revision

From 2026-10-24 every E.SUN credit-card commit was rejected with
`occurrence-conflict`, so each run ended partial. The admitted 2026-10-23
capture held 142 rows and 13 month buckets, 2026/10 through 2025/10. The
only 2025/10 row was a purchase dated 2025-10-24. From 2026-10-24 the
timeline returned 141 rows. The bank returns the month one year before the
query month only from about the query date's anniversary, so that purchase
left the timeline on its anniversary while the 2025/10 bucket was still
listed. Under [ADR 0040](./0040-per-bucket-occurrence-continuity-and-unbilled-to-billed-supersession.md)
a member of a queried bucket that is absent is a loss, so the capture was
rejected.

That month is only partly queried, and its coverage changes every day. Its
bucket key now names the query date: `partial-month:<YYYY/MM>:queried-on:<YYYY-MM-DD>`.
A later day's capture has not queried that bucket again, so a purchase that
aged out is not expected; it stays admitted and is not withdrawn. A capture
on the same query date must still contain every member. Every other month
keeps its `month:<YYYY/MM>` key, so a loss there still rejects the capture.
A twelve-month timeline starts at the month after the anniversary month and
has no partial bucket. Bucket keys are not part of occurrence identity, so
existing transactions keep their identity and the v4 route and manifest are
unchanged.

For the same reason, an issuer statement cycle that starts on or before the
query date's anniversary has members the timeline may no longer return. The
capture builds no statement for such a cycle, so a cycle aging out keeps its
last revision instead of gaining a smaller one each day.

The trade-off: after the first day, the anniversary month is no longer
checked for losses. A purchase there that vanishes for another reason is
admitted rather than rejected. The bank's exact cutoff is not exposed, so a
tighter, per-day expectation would rest on a guess.

## Source-contract catalog decision

The historical route-retention statements above describe the E.SUN integration
when those decisions were made. Under [ADR 0035](./0035-source-contract-catalog-and-rule-admission.md),
an E.SUN contract version remains installed only while a current collection
workflow uses it; historical captures alone do not require retaining an old
reader. Unused versions and their unused rule implementations are removed from
the codebase and clean baseline. This cleanup does not change the evidence,
completeness, or fingerprint semantics of a version still used by a current
workflow, and it adds no migration or compatibility reader for old databases.
