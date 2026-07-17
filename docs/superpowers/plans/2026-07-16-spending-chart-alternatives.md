# Spending Chart Alternatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brush/pan/zoom prototype with one standalone HTML page containing three interactive alternatives to the 6/12/24-month control.

**Architecture:** Keep the prototype isolated from production Spending code. One dependency-free HTML file owns the shared mock data, styles, markup, and interactions; one Playwright smoke check verifies all three concepts and their primary actions.

**Tech Stack:** Native HTML, CSS, JavaScript, existing Playwright dependency.

## Global Constraints

- Modify only the standalone prototype and its smoke check.
- Do not use LayerChart brush-band, transform pan/zoom, or a 6/12/24-month segmented control.
- Preserve the current desktop app's neutral visual language and spending-category colors.
- Support keyboard focus, descriptive labels, reduced motion, and responsive layouts.
- Do not change production Spending components or ledger data.

---

### Task 1: Restore the three-concept comparison prototype

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs`
- Modify: `docs/prototypes/spending-chart-alternatives.html`

**Interfaces:**
- Consumes: no production interface; representative monthly data is local to the HTML file.
- Produces: `[data-concept="overview"]`, `[data-concept="timeline"]`, and `[data-concept="focus-context"]` with observable state attributes used by the smoke check.

- [ ] **Step 1: Replace the smoke check with assertions for the approved concepts**

```js
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
```

- [ ] **Step 2: Run the smoke check and verify the current one-concept prototype fails**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: FAIL because the current page contains one `[data-prototype="brush-pan-zoom"]` and no `[data-concept]` elements.

- [ ] **Step 3: Replace the prototype with the approved comparison implementation**

Use the already-reviewed implementation from repository commit `e393e74c` as the exact baseline for `docs/prototypes/spending-chart-alternatives.html`. It contains:

```html
<section class="concept" id="overview">
  <div class="app-frame" data-concept="overview" data-selected-month="2026-07">…</div>
</section>
<section class="concept" id="timeline">
  <div class="app-frame" data-concept="timeline" data-scroll-index="18">…</div>
</section>
<section class="concept" id="focus-context">
  <div class="app-frame" data-concept="focus-context" data-window-start="18">…</div>
</section>
```

The same file supplies local mock months, reusable category metadata, native click/keyboard controls, horizontal drag/scroll behavior, the focus range input, responsive CSS, focus-visible styles, and reduced-motion handling. Do not add dependencies or extract abstractions.

- [ ] **Step 4: Run the focused smoke check**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: exits `0` with no output.

- [ ] **Step 5: Run project validation**

Run: `npm run typecheck`

Expected: exits `0` with no Svelte or TypeScript errors.

- [ ] **Step 6: Review the diff without committing unrelated user changes**

Run: `git diff --check -- docs/prototypes/spending-chart-alternatives.html scripts/spending-chart-alternatives.check.mjs`

Expected: exits `0` with no whitespace errors.
