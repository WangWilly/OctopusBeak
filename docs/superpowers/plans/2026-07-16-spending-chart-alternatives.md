# Spending Chart Alternatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one standalone HTML comparison page containing three interactive Spending chart alternatives without the 6/12/24-month control.

**Architecture:** Keep the prototype isolated from production code in one dependency-free HTML file. Use inline SVG for representative charts, native scrolling for the timeline, pointer events for drag interactions, and one Playwright smoke check for the user-visible behaviors.

**Tech Stack:** HTML, CSS, browser JavaScript, inline SVG, Playwright.

## Global Constraints

- Do not modify production Spending components or ledger data.
- Create exactly three concepts: overview and drilldown, horizontal timeline, and focus plus context.
- Do not render a 6/12/24-month segmented control in any concept.
- The HTML must open directly without a server or build step.
- Preserve keyboard focus, descriptive labels, responsive layout, and reduced-motion support.

---

### Task 1: Interactive comparison page

**Files:**
- Create: `docs/prototypes/spending-chart-alternatives.html`
- Create: `scripts/spending-chart-alternatives.check.mjs`

**Interfaces:**
- Produces: `[data-concept="overview"]`, `[data-concept="timeline"]`, and `[data-concept="focus-context"]` prototype panels.
- Produces: `data-selected-month`, `data-scroll-index`, and `data-window-start` state attributes for smoke verification.

- [x] **Step 1: Write the failing smoke check**

Create a Playwright check that opens the HTML file and asserts all three concept panels exist, the forbidden `6 months`, `12 months`, and `24 months` labels do not exist, selecting an overview month changes `data-selected-month`, timeline navigation changes `data-scroll-index`, and moving the focus window changes `data-window-start`.

```js
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(pathToFileURL(new URL("../docs/prototypes/spending-chart-alternatives.html", import.meta.url).pathname).href);
assert.equal(await page.locator("[data-concept]").count(), 3);
assert.doesNotMatch(await page.locator("body").innerText(), /(?:6|12|24) months/i);
const overview = page.locator('[data-concept="overview"]');
const beforeMonth = await overview.getAttribute("data-selected-month");
await overview.locator("[data-month]").nth(2).click();
assert.notEqual(await overview.getAttribute("data-selected-month"), beforeMonth);
const timeline = page.locator('[data-concept="timeline"]');
const beforeScroll = await timeline.getAttribute("data-scroll-index");
await timeline.locator('[data-action="next"]').click();
assert.notEqual(await timeline.getAttribute("data-scroll-index"), beforeScroll);
const focus = page.locator('[data-concept="focus-context"]');
const beforeWindow = await focus.getAttribute("data-window-start");
await focus.locator('[data-action="window-next"]').click();
assert.notEqual(await focus.getAttribute("data-window-start"), beforeWindow);
await browser.close();
```

- [x] **Step 2: Run the smoke check and verify RED**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: FAIL because `docs/prototypes/spending-chart-alternatives.html` does not exist.

- [x] **Step 3: Build the minimal standalone HTML**

Create one document with:

```html
<nav aria-label="Design concepts">Overview + drilldown · Horizontal timeline · Focus + context</nav>
<section data-concept="overview" data-selected-month="2026-07"></section>
<section data-concept="timeline" data-scroll-index="18"></section>
<section data-concept="focus-context" data-window-start="18"></section>
```

Fill the panels from one shared monthly dataset. Concept A updates its category detail on month selection. Concept B uses an overflow container plus previous/next controls and pointer drag. Concept C uses a full-history overview with an adjustable focus window and a detailed chart derived from that window. Keep all CSS and JavaScript inline.

- [x] **Step 4: Run the smoke check and verify GREEN**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: exit 0.

- [x] **Step 5: Verify repository health**

Run:

```bash
npm run typecheck
git diff --check
```

Expected: both exit 0.

- [x] **Step 6: Commit the prototype**

```bash
git add docs/prototypes/spending-chart-alternatives.html scripts/spending-chart-alternatives.check.mjs docs/superpowers/plans/2026-07-16-spending-chart-alternatives.md
git commit -m "docs: prototype spending chart alternatives"
```
