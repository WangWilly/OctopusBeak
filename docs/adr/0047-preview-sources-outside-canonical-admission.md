# Preview sources collect outside canonical admission, behind an opt-in setting

Status: accepted

## Decision

Strict admission ([ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md), [ADR 0035](0035-source-contract-catalog-and-rule-admission.md)) needs live samples that the maintainer cannot obtain for Institutions they hold no account with. OctopusBeak is distributed to other people who do hold those accounts, so the App gains a second, explicitly lesser tier: Preview Sources.

A Preview Source is offered only while the person turns on Preview Features (「預覽測試功能」) in Settings; it is off by default. It writes Preview Financial Data to separate tables in the same PGlite database, never to canonical tables, Source Captures, or the source contract catalog. Preview data still refuses a missing currency and keeps source amounts as exact strings; it does not fill the defaults that strict admission forbids.

Preview balances count toward assets, liabilities, and net worth, and every total that includes them carries a visible preview marker. Preview transactions appear only in their own account view and never enter spending, classification, transfer pairing, or deduplication, because an unverified direction or identity would corrupt verified analysis. Turning Preview Features off hides the sources, stops their collection, and excludes their data everywhere, while keeping the data until the person deletes it explicitly.

While Preview Features are on, Preview Sources take part in Scheduled Collection ([ADR 0045](0045-scheduled-collection.md)) like any enabled source. Each Preview Source's sign-in settings state that it has not been verified against live data and that its data may be incomplete or wrong.

While a verified source covers the same Institution and product, its Preview Source is hidden and not collected. When a verified contract replaces it (Preview Source Promotion), its preview data is deleted and recollected through canonical admission; nothing is migrated.

A failing Preview Source can produce a Preview Structure Report, the sanitized shape-only format of the E.SUN deposit probe. The App shows it in full, copies it, and opens a prefilled GitHub issue; the person decides whether to send it. The App never transmits it.

The first Preview Sources are the deposit products the all-set-tw comparison rated closest to strict admission: NextBank, SKBank, Taishin, Rakuten, and Mega. SinoPac deposits are left out because a verified SinoPac source already covers them. They use the App-protocol policy of [ADR 0044](0044-app-protocol-sources-over-browser-transport.md).

## Considered options

- **Wait for live samples for every Institution.** Rejected. People who hold those accounts would get no coverage at all, and their structure reports are the way samples arrive.
- **Admit preview data into canonical tables with a low-trust flag.** Rejected. Every canonical query, identity rule, and relation would need to know about the flag, and one missed check would contaminate verified data.
- **Exclude preview balances from totals.** Rejected by the product owner in favour of counting them with a marker, so net worth reflects every account the person chose to connect.
- **Count preview transactions in spending.** Rejected. Direction and identity are the least reliable parts of an unverified source, and spending pairs and deduplicates across accounts.
- **Upload structure reports automatically.** Rejected. The App does not send financial-adjacent data anywhere without the person's action, and needs no server.

## Consequences

- Totals can include data whose completeness and direction no contract proved. The preview marker is the only signal, so it must appear on every affected total.
- Preview Sources ship without any maintainer live run. Their first real execution happens on a user's machine, and failures are expected until structure reports arrive.
- Each Preview Source needs a verified-coverage rule so it disappears once a verified source exists for the same Institution and product.
