# Cathay domestic history uses provider APIs directly

Status: accepted

Applies [ADR 0032](0032-app-owned-workflow-runtime.md) and the [App-owned workflow runtime contract](../specs/app-owned-workflow-runtime.md).

The Cathay domestic transaction query page previously acted as a gate before collection: the workflow navigated to `B0103_TxnDtlInq`, opened its React Select controls, compared the displayed accounts with the account-list API, selected each account and period, and submitted the form. Live verification during PR review on 2026-10-29 established that this gate does not supply independent source evidence:

- `G_CUST_Q_TransAccountList` is the sole source for the query page's account selector, and the page applies no additional account filtering.
- `B_ACCT_Q_TransferDetail` succeeds in the authenticated Cathay session without first visiting or submitting `B0103_TxnDtlInq`.

Comparing the API account roster with a UI projection of that same roster therefore cannot prove additional completeness. The navigation and form interactions only introduce another failure surface.

**Domestic transaction history is collected from the authenticated provider APIs without a query-page gate.** The workflow treats the domestic accounts returned by `G_CUST_Q_TransAccountList` as the authoritative collection roster and calls `B_ACCT_Q_TransferDetail` once for every returned account. It does not navigate to `B0103_TxnDtlInq`, operate its controls, or compare its account options with the API roster.

The API requests still execute in the authenticated Cathay page's same-origin context and retain the existing endpoint, transport, source-text, response-account, requested-date-range, row-count, and canonical-admission validation. Request and admission dates come from the product's Collection period ([ADR 0077](0077-a-verified-product-declares-its-collection-period.md)). A failure or cancellation before all returned accounts are staged rejects the domestic collection; no partial domestic request set is committed. The current-balance collector remains separate and may continue to read the provider's domestic overview page.

## Considered options

- **Keep the query page as a prerequisite but stop comparing accounts.** Rejected. Live verification shows that the transfer-detail API does not require the page to be visited or submitted.
- **Compare the API roster with the query selector.** Rejected. The selector is an unfiltered projection of the same account-list response, so the comparison is not independent evidence and adds React Select and page-copy fragility.
- **Use the query page's table instead of the transfer-detail API.** Rejected. It adds pagination and rendering dependencies while discarding the structured response validation already required by canonical admission.

## Consequences

- Changes to the obsolete query form do not block domestic transaction collection.
- Completeness of the account roster depends on the documented provider contract of `G_CUST_Q_TransAccountList`; there is intentionally no UI account cross-check.
- If Cathay later filters the selector independently or requires page priming, that is a provider-contract change requiring new live evidence and a replacement decision, not a silent fallback.
- Tests distinguish injected-client isolation from the production API client's behavior and cover direct endpoint construction, per-account failure, and cancellation.
