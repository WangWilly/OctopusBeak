# Verified sources may collect Attached Preview Products in their own sign-in

Status: accepted

## Decision

[ADR 0047](0047-preview-sources-outside-canonical-admission.md) kept Preview Sources apart from verified sources: each has its own Sign-in Details and its own run. That fails for an Institution whose deposits are verified but whose credit cards, time deposits, or foreign-currency accounts are not, such as Cathay, CTBC, HNCB, SinoPac, and E.SUN. A second sign-in to the same bank in the same Sync all can end the verified source's session, and the person would enter the same Sign-in Details twice.

So a verified source may collect an Attached Preview Product during its own sign-in while Preview Features are on. Its workflow then holds two ports: the canonical commit port for its verified products and a preview writer for the attached ones. Each product still writes to exactly one side. An attached product never produces a Source Capture, and a verified product never writes Preview Financial Data.

A product is attached only when its collection uses the same transport family as the verified workflow, judged against the all-set-tw reference implementation that the preview is built from. Website collection through page APIs and website collection through page elements are one family. A website workflow and a mobile App protocol ([ADR 0044](0044-app-protocol-sources-over-browser-transport.md)) are different families. A product from a different family becomes its own Preview Source with its own Sign-in Details. For example, CTBC credit cards use the App protocol while the verified CTBC deposits use the website, so they get a separate Preview Source.

An attached product appears in the verified source's Statement Selection ([ADR 0036](0036-explicit-statement-selection-and-product-results.md)) only while Preview Features are on, is unselected by default, and reports its own product result. Turning Preview Features off removes the choice and stops its collection, and keeps its data as ADR 0047 requires.

## Considered options

- **Separate Preview Sources for every unverified product.** Rejected. Two sign-ins to one bank per sync risk ending each other's session, and the person enters the same Sign-in Details twice.
- **Reuse the verified Sign-in Details in a separate preview run.** Rejected. It removes the duplicate entry but keeps the second sign-in.
- **Attach every unverified product regardless of transport.** Rejected. Grafting an App-protocol client onto a website workflow mixes two session models in one run, and a failure in either would hide the other.

## Consequences

- A verified workflow's code now spans verified and preview products. Review must check that each product writes to only one side.
- A failure in an attached product must not fail the verified products of the same run. ADR 0036's per-product results carry this. A recoverable attached-product failure makes the whole run partial when another product has durable receipts, while preserving each successful product result. The shared run summary includes verified and attached outcomes, including after interruption or cooperative cancellation; ADR 0036's fatal-failure and cancellation precedence remains unchanged.
- When an attached product is promoted to a verified contract, its preview data is deleted and recollected, as for any Preview Source.
