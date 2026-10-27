# One Source site module owns each bank's signed-in navigation

Status: accepted

Follows [ADR 0065](0065-product-runners-read-the-source-before-they-stage.md), which left the read half of each product runner untested and named a Yuanta eBank page module as the fix. Applies to signed-in pages the cancellation rule that [ADR 0061](0061-source-sign-in-step-owns-every-browser-sign-in.md) applied to sign-in. Keeps `withPage`, sign-in, sign-out and Fubon's keep-alive with each workflow, as [ADR 0064](0064-product-collection-run-commits-and-decides-source-only.md) decided.

## Context

Yuanta Bank and Fubon are signed-in pages built from frames. Yuanta has `fmenu` and `fmain`; Fubon has `frame1` and `txnFrame`. Each product runner reached its page and found its elements by hand, and the copies had drifted:

- `findScopeWithSelector` and `findScopeWithLocator` were copied into 8 files, `settleAfterNavigation` into 7 and `firstVisibleLocator` into 5.
  - Yuanta credit card searched `[...frames, page]` and polled every 250 ms. The other Yuanta products searched `[page, ...frames]` and polled every 500 ms.
  - Settling waited for `networkidle` and then slept for a fixed 250 ms in credit card and 750 ms elsewhere.
- Each product opened its page through its own fallback chain: it reused a form already on the page, then tried a direct `goto`, then clicked a menu. The order and the timeouts differed between products. Yuanta also passed the Product Collection Run a `prepare` hook that reset `fmain` before three of its five products.
- No Yuanta or Fubon product runner used `withAbort`. Cancellation was checked only between accounts and pages, so a cancelled run could keep waiting for up to 120 seconds inside one `waitForSelector` or `waitForResponse`.
- Response bodies were read with Playwright's `response.text()` or an in-page `fetch().text()`. Both decode UTF-8 without failing on bad bytes. The integrity check was an optional `sourceText?.assertIntact`, and Yuanta credit card turned a failed read into an empty string.

Two navigation styles sit on one frame structure. Yuanta opens server-rendered routes with the session's `cid` or calls the page's `menuaction()`. Fubon clicks menus in `frame1` and follows JSF postbacks, where a direct `goto` loses the provider's 302 hand-off.

## Decision

**A shared frame-scope module finds elements and waits.** `src/workflows/frame-scope.ts` is built from the page and the run's signal. It owns:

- finding an element across the page and its frames, in one search order;
- finding the first visible match;
- waiting for a named frame;
- settling after navigation.

Every wait races the run's signal and rejects with `signal.reason`, so the Product Collection Run records a cancelled product as `cancelled`. A fixed sleep becomes a wait for an element or response wherever the page offers one. Each call keeps its current timeout, and the module default is 60 seconds. A timeout keeps today's failure classification, and its message names the frame, selector or response it waited for.

**One Source site module per bank owns navigation after sign-in.** `src/workflows/yuanta-ebank-site.ts` and `src/workflows/fubon-ebank-site.ts` build on the frame-scope module.

- Each product declares its route as data: a `cid` route and a fallback menu for Yuanta, or a menu id and task class for Fubon. A Fubon route whose link the bank must redirect itself, such as the loan task, declares `clickInPlace`, so the site clicks it instead of following its href.
- The site module opens that route the same way from any signed-in page. It no longer reuses a form that happens to be on the page.
- Yuanta's `prepare` hook is deleted.
- Site behavior stays in its module: Yuanta's `menuaction()` and date-range picker, and Fubon's menus, bank mask and postbacks.

**The site module decodes response bytes strictly.** It reads raw bytes and decodes them through the run's `SourceTextPort` with `fatal: true`: UTF-8 for HTML and Big5 for Yuanta's CSV exports. Invalid bytes fail the product as `source-integrity-failed`. The source text port becomes required for these products. HTML read from the DOM is left as it is, because the browser has already decoded it.

**Product runners keep what they read and in what order.** Each Yuanta and Fubon product runner reads through its site module and keeps the read-then-build split of ADR 0065. Two reads compose the frame scope directly instead of calling `open`, because their evidence is the response to one specific click: Yuanta's current used credit summary, whose POST reply proves the balance, and Fubon's current deposit balances, which need a real pointer click paired with the balance response.

## Considered options

- **Two site modules, each with its own frame finding.** Rejected. The frame-search loop is the same on both banks, so one shared module has two real callers.
- **One shared frame-scope module, with navigation left in each product.** Rejected. The per-product fallback chains held most of the drift.
- **Navigation verbs only, with each product composing its own fallback.** Rejected for the same reason.
- **Keep each product's poll interval and settle delay as parameters.** Rejected. It would move the drift into the interface.
- **Take the charset from the response header or a `<meta>` tag, as Yuanta Trade does.** Rejected. Neither bank declares a page charset in anything the repository has captured. `assertIntact` already passes on live bodies, so strict UTF-8 decoding keeps every read that works today.
- **Move HNCB's copies onto the frame-scope module in the same change.** Deferred. HNCB is a single-product bank, and its runner will be reshaped together with the other single-product banks. HNCB's statement pages and sign-in probe later moved onto the frame-scope module together with that read-then-build split. HNCB's current-balance module still polls on its own.
- **Add a typed timeout outcome.** Rejected for now. It would need another sweep across the host and the dashboard.

## Consequences

- A cancelled Yuanta or Fubon run stops inside its current wait instead of at the next account or page boundary. A product cancelled mid-wait stages nothing further.
- Yuanta credit card's unreadable response becomes a `source-integrity-failed` product instead of an empty body.
- Every product starts from a page the site module navigated to, at the cost of one extra page load where a form used to be reused.
- Checks drive the frame-scope and site modules in real Chromium against synthetic framesets served by route interception, as the sign-in checks do. Source-text assertions that the new interfaces can reach are deleted. The deposit commit goldens must not change.
- The repository has no captured Yuanta or Fubon pages, so the synthetic framesets prove structure, not live timing or encoding. A live Yuanta and Fubon collection, cancelled once mid-wait, closes that gap before merge.
- The Yuanta credit-card summary parser and its unused telemetry move in a separate change.
