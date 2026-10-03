# Explicit Statement Selection and product results

Status: accepted

An enabled multi-product source collects only its person's persisted Statement Selection; every run attempts the complete current selection, and newly supported products or provider-reported absence never change that selection. Each product reports success, no data, not held, failure, or skipped with a reason. Independent complete commit items retain the existing commit semantics, including evidence that must be admitted together; a recoverable product failure can coexist with other results, while session loss, cancellation, global workflow invariants, and uncertain commits stop further collection. Failed or cancelled runs invalidate financial data when earlier products have durable commit receipts; existing completed and partial invalidation rules remain unchanged. This change adds no database migration or automatic data reset, and development data may be rebuilt manually.
