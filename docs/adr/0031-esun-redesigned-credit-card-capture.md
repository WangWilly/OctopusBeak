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
