# The Product collection run sums each collector's counts

Status: accepted

Extends [ADR 0071](0071-product-collection-run-bound-to-its-verified-source.md): the run, not the workflow, owns how a Product collection run's counts are formed.

## Context

A collector returned a fixed `ProductCollectionSummary` (`sourceCaptureCount`, `rowCount` and two flags). Any other count a workflow wanted to report left the collector through a closure (`let deposit = null; … deposit = collected`) and was read back after the run, often by position (`summary.products[0]`, `const [verified, ...attached] = summary.products`). Each of 13 workflows then passed ad-hoc `counts` to `productRunResult`, and the copies drifted:

- **`accountCount` had three meanings.** SinoPac reported the deposit's accounts, or the Attached Preview Products' accounts when the deposit did not succeed. HNCB reported both added together. A Preview Source reported its `committedCount`.
- **Failed products.** CTBC and Post set their counts when the collector returned, so a product whose commit failed still reported them. E.SUN, HNCB and SinoPac counted only a successful product.
- **Duplicates.** CTBC's and Cathay's `count` repeated `sourceCaptureCount`. LINE Bank's `statementRowCount` and `financialItemCount` repeated `rowCount` and `itemCount`. E.SUN's `count` repeated `rowCount`, and its `canonicalCaptureCount` repeated `sourceCaptureCount`. Fubon and Yuanta reported `skippedProductCount`, which the product outcomes already show.

## Decision

**A collector returns its own counts in `ProductCollectionSummary.counts`, and the run sums them by name over the products that succeeded.**

- `counts` holds provider counts only. A collector that reports one of the run's own counts (`sourceCaptureCount`, `rowCount`, `itemCount`, `committedCount`) or an unsafe value fails the run as `workflow-failed`.
- Only a product whose outcome is `success` contributes. A failed product's data was not kept, so its counts are not reported either.
- `accountCount` means the accounts this run brought back, across every product. Each successful Attached Preview Product adds its `itemCount`, because a preview commit item is one account. A Preview Source run reports `accountCount` the same way.
- `ProductCollectionRunSummary.counts` carries the sums, including on an interrupted run's summary. `productRunResult` takes no `counts`. It reports the run's own counts, the summed counts, and the TDCC exclusion counts aggregated from the products' collection evidence.
- The duplicates are removed: `count`, `canonicalCaptureCount` (E.SUN), `statementRowCount`, `financialItemCount` and `skippedProductCount` are no longer reported by any Product collection run. Workflows that are not Product collection runs (Binance, MaiCoin, e-Invoice) keep their counts.

## Considered options

- **SinoPac's rule**, the deposit's accounts with the attached accounts as a fallback. Rejected: one field then counts verified accounts on one run and preview accounts on the next.
- **Verified accounts only.** Rejected: a run that collected only Attached Preview Products would report no accounts.
- **Let the run derive `skippedProductCount` for every source.** Rejected: the product results table already lists each skipped product.

## Consequences

- Run details show `accountCount` as the sum across products. SinoPac reports more accounts when its deposit succeeds alongside attached products. CTBC and Post no longer report counts for a product whose commit failed.
- Commit goldens that record a run result change only by losing removed counts: the Fubon and Yuanta deposit and credit-card goldens lose `skippedProductCount`, and the E.SUN credit-card goldens lose `count` and `canonicalCaptureCount`.
- A TDCC run in which no product recorded collection evidence no longer reports its exclusion counts as zeros; it omits them.
- A collector's extra counts travel with its summary, so no workflow keeps a closure or reads a product by position to report them.
