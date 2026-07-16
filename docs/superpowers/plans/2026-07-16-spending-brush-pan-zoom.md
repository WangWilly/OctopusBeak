# Spending Brush–Pan–Zoom Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-alternative HTML with one progressive-detail brush, pan, and zoom Spending chart prototype.

**Architecture:** Keep one integer-indexed visible domain over the complete monthly dataset. Render one total bar per visible month when more than 10 months are visible, then switch to paired source/category stacks at 10 or fewer months; pointer and toolbar interactions all call the same constrained `setDomain(start, end)` function.

**Tech Stack:** Standalone HTML, CSS, browser JavaScript, Playwright.

## Global Constraints

- Modify only the standalone prototype, its smoke check, and this plan.
- Do not modify production Spending components or ledger data.
- Use a complete-history overview initially and render detailed paired source/category bars only for 10 or fewer visible months.
- Constrain zoom to 1–6× and pan to the real dataset bounds.
- Keep native keyboard-accessible controls, reduced-motion support, and an accessible visible-data summary.
- Do not add dependencies or a 6/12/24-month control.

---

### Task 1: Progressive Brush–Pan–Zoom prototype

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs`
- Modify: `docs/prototypes/spending-chart-alternatives.html`

**Interfaces:**
- Produces: `[data-prototype="brush-pan-zoom"]` with `data-domain-start`, `data-domain-end`, and `data-mode` state.
- Produces: controls with `data-action="zoom-in"`, `zoom-out`, `pan-left`, `pan-right`, and `reset`.
- Produces: `[data-plot]` as the brush, pan, wheel, and double-click interaction surface.

- [x] **Step 1: Replace the smoke check with the new failing behavior**

The check must open the existing HTML and assert:

```js
const prototype = page.locator('[data-prototype="brush-pan-zoom"]');
assert.equal(await prototype.count(), 1);
assert.equal(await prototype.getAttribute("data-mode"), "overview");
assert.equal(await prototype.getAttribute("data-domain-start"), "0");
assert.equal(await prototype.getAttribute("data-domain-end"), "29");

const plot = prototype.locator("[data-plot]");
const box = await plot.boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.5);
await page.mouse.up();
assert.equal(await prototype.getAttribute("data-mode"), "detail");

const brushedStart = await prototype.getAttribute("data-domain-start");
await prototype.locator('[data-action="pan-left"]').click();
assert.notEqual(await prototype.getAttribute("data-domain-start"), brushedStart);
await prototype.locator('[data-action="reset"]').click();
assert.equal(await prototype.getAttribute("data-domain-start"), "0");
assert.equal(await prototype.getAttribute("data-domain-end"), "29");
assert.doesNotMatch(await page.locator("body").innerText(), /(?:6|12|24) months/i);
```

- [x] **Step 2: Run the check and verify RED**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: FAIL because the old comparison page has no `[data-prototype="brush-pan-zoom"]`.

- [x] **Step 3: Replace the HTML with one focused prototype**

Use a single root and one shared domain state:

```html
<section
  data-prototype="brush-pan-zoom"
  data-domain-start="0"
  data-domain-end="29"
  data-mode="overview"
>
  <div data-plot aria-label="Interactive monthly spending chart"></div>
  <button data-action="zoom-in">Zoom in</button>
  <button data-action="zoom-out">Zoom out</button>
  <button data-action="pan-left">Pan left</button>
  <button data-action="pan-right">Pan right</button>
  <button data-action="reset">Reset</button>
</section>
```

Implement these shared state operations:

```js
const detailThreshold = 10;
const maxScale = 6;

function setDomain(start, end) {
  const width = Math.max(Math.ceil(months.length / maxScale), Math.min(months.length, end - start + 1));
  const safeStart = Math.max(0, Math.min(months.length - width, Math.round(start)));
  domainStart = safeStart;
  domainEnd = safeStart + width - 1;
  render();
}

function reset() {
  setDomain(0, months.length - 1);
}
```

`render()` updates state attributes, range/status copy, buttons, month labels, hidden visible-data summaries, and either overview total bars or paired invoice/account category stacks. Brush pointer-up converts pixel bounds into month indexes and calls `setDomain`. At a zoomed domain, ordinary drag pans; Shift-drag creates a replacement brush. Command/Ctrl-wheel and double-click zoom around the pointer. Horizontal wheel movement and pan buttons call the constrained pan operation.

- [x] **Step 4: Run the focused check and verify GREEN**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: exit 0.

- [x] **Step 5: Visually verify desktop and compact layouts**

Render the local file at 1440×1000 and 390×844. Confirm the toolbar wraps without overlap, the brush overlay stays inside the plot, total bars switch to paired category stacks after brushing, tooltips remain inside the card, and Reset returns the full-history overview.

- [x] **Step 6: Verify repository health**

Run:

```bash
npm run typecheck
npm test
git diff --check
```

Expected: typecheck reports 0 errors and warnings, all tests pass, and diff check exits 0.

- [x] **Step 7: Commit the redesigned prototype**

```bash
git add docs/prototypes/spending-chart-alternatives.html scripts/spending-chart-alternatives.check.mjs docs/superpowers/plans/2026-07-16-spending-brush-pan-zoom.md
git commit -m "docs: prototype spending brush pan zoom"
```
