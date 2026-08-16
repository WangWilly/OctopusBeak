# Transaction posting semantics across Plaid, UK Open Banking, and Taiwan banks

## Question

What durable semantic boundary can OctopusBeak use for `pending` and `posted` without treating Plaid as a planned provider or confusing Taiwan credit-card billing stages with account-ledger booking?

## Findings

### Plaid and UK Open Banking

Plaid Core Exchange accepts `PENDING` and `POSTED`, treating `AUTHORIZATION` and `MEMO` as pending. It expects pending and posted versions to have separate transaction IDs, permits a reference ID to relate them, and requires `postedTimestamp` for posted records while omitting it for pending records. These are useful model semantics, but the IDs and linkage are Plaid provider capabilities rather than guarantees OctopusBeak may assume for Taiwan sources.

UK Open Banking defines `Booked` as a transfer of money completed between the account servicer and account owner, while warning that booked does not necessarily mean end-to-end payment finality. `Pending` means booking in the account servicer's ledger has not completed and covers expected items or items awaiting conditions before booking.

Sources:

- [Plaid Core Exchange API reference](https://plaid.com/core-exchange/docs/reference/4.6/)
- [UK Open Banking Account and Transaction API specification](https://openbankinguk.github.io/read-write-api-site2/standards/v3.1.3/resources-and-data-models/aisp/images/Account%20and%20Transaction%20API%20Specification/)
- [UK Open Banking Transactions resource](https://openbankinguk.github.io/read-write-api-site2/standards/v3.1.3/resources-and-data-models/aisp/Transactions/)

### Taiwan card and deposit-account language

Taiwan banks expose the same lifecycle through different user-facing terms:

- Cathay United Bank calls an authorized card purchase whose merchant has not submitted presentment an "immediate transaction"; its "unbilled amount" is a merchant-presented amount that will enter the next statement.
- E.SUN likewise separates immediate authorization records from "unposted statement details": the latter have already been presented by the merchant but have not reached the statement cut-off date.
- CTBC and Taishin explain debit-card authorization as a hold that reduces available balance without reducing account balance; merchant presentment later releases the hold and debits account balance.

Sources:

- [Cathay United Bank credit-card transaction guide](https://www.cathaybk.com.tw/cathaybk/personal/campaigns/ebanking/card-management-guide/?eventname=cmg_spending_ap_faq)
- [E.SUN Wallet credit-card FAQ](https://www.esunbank.com/zh-tw/about/faq/faqlist?tag=esunwallet-credit-card-services)
- [CTBC account and available balance FAQ](https://service.ctbcbank.com/FAQ/Page01?KM=&kmid=4688)
- [Taishin account and available balance FAQ](https://www.taishinbank.com.tw/TSB/customer-service-center/qa/index.html?nav1=type03&page=3)

## Interpretation guardrails

- The portable boundary is account-ledger booking: pending is authorized, expected, or reserved but not booked; posted is recorded in the Institution's account ledger.
- Payment-network settlement is a separate lifecycle and must not define account-transaction posting status.
- Taiwan `unbilled` and `billed` describe statement-cycle membership. A merchant-presented transaction may be posted while still unbilled.
- Each Supported Source Integration must verify and version the semantics of the page, endpoint, or report it collects. A filename, successful download, posting-date-shaped column, or appearance in a list is not sufficient by itself.
- The current Taiwan-source inventory usually lacks row-level status. `unknown` therefore remains a valid exceptional fail-safe, while a verified Integration contract may map a whole Source Record kind deterministically.
