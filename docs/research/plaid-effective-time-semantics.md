# Plaid reference semantics for missing or imprecise effective time

## Question

How does Plaid remain operational when a financial value lacks an exact effective timestamp, and which parts of that model are useful to OctopusBeak without treating Plaid as a planned integration?

## Official model findings

### Transactions require a domain date, not always an exact timestamp

Plaid Transactions requires `date`: for a pending transaction it means the date the transaction occurred, while for a posted transaction it means the posting date. The more precise `authorized_date`, `authorized_datetime`, and posted `datetime` are nullable; datetime fields are available only from select institutions and may contain default time values such as midnight. Plaid therefore preserves coarse date precision instead of requiring or inventing an exact timestamp.

Plaid also models pending and posted as distinct transaction occurrences linked when possible. Some institutions do not supply pending transactions, and a posted occurrence may lack `pending_transaction_id`; this missing relationship does not remove the required posted transaction date or status.

Sources:

- [Plaid Transactions API](https://plaid.com/docs/api/products/transactions/)
- [Plaid transaction states](https://plaid.com/docs/transactions/transactions-data/)

### Balance values often lack a value-specific update time

Plaid's account balances may be cached, while `/accounts/balance/get` obtains live values for supported cases. The balance-level `last_updated_datetime` is nullable and documented as available only for Capital One, so Plaid does not require every returned balance to carry a universal effective timestamp. Plaid separately exposes product-level `last_successful_update`, which records successful institution contact even when no data changed.

Where freshness is contractually required, Plaid uses a gate rather than fabricating a timestamp: `min_last_updated_datetime` can reject an unacceptable Capital One balance with `LAST_UPDATED_DATETIME_OUT_OF_RANGE`.

Sources:

- [Plaid Accounts API](https://plaid.com/docs/api/accounts/)
- [Plaid Items API](https://plaid.com/docs/api/items/)
- [Plaid Signal and Balance API](https://plaid.com/docs/api/products/signal/)

### Holdings retain values when price-time metadata is absent

Plaid returns holding quantity, institution value, and institution price, while `institution_price_as_of` and `institution_price_datetime` are nullable. The datetime comes from the institution, is available only for select institutions, and may contain a default time. Plaid Investments uses periodic or requested refreshes and update notifications to communicate snapshot freshness separately from an exact price effective time.

Sources:

- [Plaid Investments API](https://plaid.com/docs/api/products/investments/)
- [Plaid Investments overview](https://plaid.com/docs/investments/)

## Interpretation for OctopusBeak

The following separates an inference from Plaid's model from OctopusBeak's deliberately stricter project decision:

- Plaid demonstrates that missing exact effective time need not block a current or as-observed API view, but it does block or weaken financial-time uses such as an exact historical balance, historical position, valuation attribution, or cross-source ordering.
- OctopusBeak therefore chooses a stricter boundary for Balance and Holding Observations: their integration contract must establish `effective_at`, or the attempted Source Capture fails admission. This trades source coverage for reproducible historical valuation.
- A domain fact that requires time to be meaningful, such as an admitted transaction, should require the precision its integration contract promises (for example, a date without inventing a timestamp).
- Observation or successful-update time remains separate from financial effective time. It can establish freshness and knowledge history but must not be copied into `effective_at`.
- Canonical fact types still declare whether effective time is required or not applicable; a required time that cannot be established fails admission.
