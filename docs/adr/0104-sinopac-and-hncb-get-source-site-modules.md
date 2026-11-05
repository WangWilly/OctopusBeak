# SinoPac and HNCB get Source site modules; the other single-product banks do not

Status: accepted

Extends [ADR 0066](0066-source-site-owns-signed-in-navigation.md), which gave Yuanta and Fubon a Source site module and deferred HNCB "together with the other single-product banks". Keeps the read-then-build split of [ADR 0065](0065-product-runners-read-the-source-before-they-stage.md).

## Context

Every bank other than Yuanta and Fubon registers one verified product. Some also read a second page inside that run, the current deposit balances, or carry attached preview products. Whether a bank's signed-in knowledge is spread across files therefore depends on the bank, not on how many verified products it has.

- **SinoPac** read through four files: deposit statements, current deposit balances, the preview credit card and the preview loan. Each built its own frame scope. The card and the loan each carried a near-identical same-origin transport: the MMA origin, the origin guard, the XHR headers and an in-page `fetch`. Both returned `reply.text()`, a lossy browser decode that never reached the `SourceTextPort`. The statements page was opened by clicking a visible link when there was one and by `goto` otherwise.
- **HNCB** read through three files: deposit statements, current deposit balances and the preview credit card. Each knew the `main` frame and the TrxDispatcher path on its own, and each reached its page its own way: a frame `goto`, menu clicks with hand-written polling, or an injected form POST.
- **CTBC** and **Post** share only an endpoint path and a page URL between statements and balances.
- **LINE Bank** already reads through one `LineBankApiClient`.
- **E.SUN**'s credit card and preview deposit use different transports that share nothing.

## Decision

**SinoPac and HNCB each get a Source site module** on the frame-scope module, built once per run and shared by every read of that bank.

- `src/workflows/sinopac-mma-site.ts` owns the MMA origin and its guard, the deposit pages as routes, settling, and one `post` transport. `open(route)` arms the wait for the web-service response the page requests before it navigates, and returns that response's bytes. `post` fetches from inside the signed-in page, lets the caller refuse the reply by its URL, status and content type, and only then decodes its bytes through the run's `SourceTextPort` with `fatal: true`. The deposit transaction query, the card and the loan all post through it.
- `src/workflows/hncb-netbank-site.ts` owns the `main` frame, the TrxDispatcher servlet, the deposit pages as routes, and settling. `dispatch(trx, fields)` posts a transaction into the main frame; `submit(control)` posts the main frame's own form, as the statement query does. Both wait for the main frame's navigation through the run's signal and answer `null` when it loads no reply, so the product decides what that means, as before. The site reads no response bytes, so it takes no `SourceTextPort`.
- A route opens the same way from any signed-in page, as ADR 0066 decided. SinoPac's statements page is opened by `goto` only; the link click it tried first has been there since the workflow was added, with no recorded reason.
- HNCB's popup statement export stays in the statements module, its only reader.

**CTBC, Post, LINE Bank and E.SUN get no site module.** Each fails the deletion test: a module would move one product's code into another file without removing duplication. A bank that later reads a second product through the same signed-in pages is reconsidered then.

## Considered options

- **A site module for every bank, as ADR 0066 deferred.** Rejected for the four banks above.
- **Only a shared transport for SinoPac's card and loan.** Rejected. The deposit pages would still be opened in two files with two scopes.
- **Keep SinoPac's link click as the first try.** Rejected. It reuses whatever the page happens to show, which ADR 0066 removed for Yuanta and Fubon.

## Consequences

- SinoPac's preview credit card and loan fail as `source-integrity-failed` on invalid bytes instead of reading a lossy string.
- SinoPac's statements page costs one page load where a visible link used to be clicked.
- SinoPac's verified transaction query moves from an in-page `XMLHttpRequest` to the site's `fetch`, with the same headers, body and checks in the same order.
- Opening a route now settles the page, up to 10 seconds of tolerated `networkidle`, before its ready check. HNCB's statement query waits up to 60 seconds for the main frame's navigation instead of 60 seconds for the reply and 10 for the navigation.
- Checks drive both site modules in real Chromium against synthetic pages served by route interception. Source-text assertions the site modules now cover are deleted. The deposit commit goldens do not change.
- The repository has no captured SinoPac or HNCB pages, so the synthetic pages prove structure, not live timing or encoding. The next live collection of each bank closes that gap. It does not block the merge. The deposit goldens run on fake sources and do not reach these browser paths, so the synthetic-page checks of the deposit query, routes and `submit` are what guards the verified deposit until then.
- E.SUN's preview deposit portal still decodes with `response.text()` outside a frame scope; that is fixed separately.
