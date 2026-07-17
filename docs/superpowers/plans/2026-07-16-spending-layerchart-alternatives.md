# Spending LayerChart Alternatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one Svelte comparison page whose three monthly-spending charts use LayerChart's real brush, domain transform, and combined brush-to-zoom implementations.

**Architecture:** Add a small typed interaction-config helper, then make `SpendingBarChart` opt into that configuration while keeping its production default static. A dedicated prerendered study route supplies shared mock rows and renders three variants; the existing Playwright smoke-check filename is repurposed to start Vite and verify the live LayerChart DOM.

**Tech Stack:** Svelte 5, SvelteKit, `layerchart@^2.0.0`, native Node assertions, existing Playwright dependency.

## Global Constraints

- Use LayerChart's `brush`, `transform={{ mode: "domain", axis: "x" }}`, `bind:context`, and transform methods; do not simulate chart interaction.
- Keep the production Spending chart's default behavior unchanged.
- Reuse existing chart data mapping, colors, axes, tooltip, legend, accessibility summary, and month click behavior.
- Add no dependency and do not connect the study route to the ledger or desktop API.
- Keep the study URL out of production navigation.

---

### Task 1: Add typed LayerChart interaction modes

**Files:**
- Create: `src/lib/spending/components/spending-chart-interaction.ts`
- Create: `src/lib/spending/components/spending-chart-interaction.check.ts`
- Modify: `src/lib/spending/components/SpendingBarChart.svelte`

**Interfaces:**
- Consumes: LayerChart `BarChartProps` types and existing `SpendingBarChart` rows.
- Produces: `SpendingChartInteraction = "static" | "brush" | "pan-zoom" | "brush-pan-zoom"` and `spendingChartInteractionProps(mode)`.

- [ ] **Step 1: Write the failing interaction-config check**

```ts
import assert from "node:assert/strict";
import { spendingChartInteractionProps } from "./spending-chart-interaction.ts";

assert.deepEqual(spendingChartInteractionProps("static"), { brush: false, transform: undefined });
assert.deepEqual(spendingChartInteractionProps("brush"), {
  brush: { axis: "x", minExtent: { x: 2 }, zoomOnBrush: false },
  transform: undefined,
});
assert.deepEqual(spendingChartInteractionProps("pan-zoom"), {
  brush: false,
  transform: {
    mode: "domain",
    axis: "x",
    scrollMode: "scale",
    scrollActivationKey: "meta",
    scaleExtent: [1, 6],
  },
});
assert.deepEqual(spendingChartInteractionProps("brush-pan-zoom"), {
  brush: { axis: "x", minExtent: { x: 2 } },
  transform: {
    mode: "domain",
    axis: "x",
    scrollMode: "scale",
    scrollActivationKey: "meta",
    scaleExtent: [1, 6],
  },
});
```

- [ ] **Step 2: Run the check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-interaction.check.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `spending-chart-interaction.ts`.

- [ ] **Step 3: Implement the minimal typed configuration helper**

```ts
import type { BarChartProps } from "layerchart";

export type SpendingChartInteraction = "static" | "brush" | "pan-zoom" | "brush-pan-zoom";
type InteractionProps = Pick<BarChartProps<unknown>, "brush" | "transform">;

const transform: NonNullable<InteractionProps["transform"]> = {
  mode: "domain",
  axis: "x",
  scrollMode: "scale",
  scrollActivationKey: "meta",
  scaleExtent: [1, 6],
};

export function spendingChartInteractionProps(mode: SpendingChartInteraction): InteractionProps {
  if (mode === "brush") {
    return { brush: { axis: "x", minExtent: { x: 2 }, zoomOnBrush: false }, transform: undefined };
  }
  if (mode === "pan-zoom") return { brush: false, transform };
  if (mode === "brush-pan-zoom") {
    return { brush: { axis: "x", minExtent: { x: 2 } }, transform };
  }
  return { brush: false, transform: undefined };
}
```

- [ ] **Step 4: Run the check and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-interaction.check.ts`

Expected: exits `0` with no output.

- [ ] **Step 5: Wire the helper into `SpendingBarChart`**

Add the imports, prop, context binding, transform state, and native controls:

```svelte
<script lang="ts">
  import { BarChart, Text, Tooltip, type BarChartProps, type TextProps } from "layerchart";
  import {
    spendingChartInteractionProps,
    type SpendingChartInteraction,
  } from "./spending-chart-interaction.ts";

  export let interaction: SpendingChartInteraction = "static";
  let chartContext: BarChartProps<SourceBucket>["context"];
  let transformScale = 1;

  $: interactionProps = spendingChartInteractionProps(interaction);
  $: hasTransform = interactionProps.transform !== undefined;

  function updateTransform(detail: { scale: number }) {
    transformScale = detail.scale;
  }
</script>
```

Change the existing chart root to include the two data attributes, then insert the controls immediately after the hidden summary list:

```svelte
<div
  class="spending-bar-chart"
  data-interaction={interaction}
  data-transform-scale={transformScale}
>
  {#if hasTransform}
    <div class="spending-transform-controls" aria-label="Chart transform controls">
      <button type="button" data-action="zoom-in" onclick={() => chartContext?.transform.zoomIn()}>+</button>
      <button type="button" data-action="zoom-out" onclick={() => chartContext?.transform.zoomOut()}>−</button>
      <button type="button" data-action="reset" disabled={transformScale <= 1} onclick={() => chartContext?.transform.reset()}>Reset</button>
    </div>
  {/if}
```

Add these three attributes to the existing `<BarChart>` opening tag; keep every other existing chart prop and snippet unchanged:

```svelte
bind:context={chartContext}
brush={interactionProps.brush}
transform={interactionProps.transform}
onTransform={updateTransform}
```

Add compact button styles using existing tokens:

```css
.spending-transform-controls {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 0 16px 8px;
}

.spending-transform-controls button {
  min-width: 36px;
  min-height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}

.spending-transform-controls button:disabled { opacity: 0.4; }
.spending-transform-controls button:focus-visible { outline: 2px solid var(--accent); }
```

- [ ] **Step 6: Verify the component compiles and the default stays static**

Run: `npm run typecheck`

Expected: `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 7: Commit only Task 1 files**

```bash
git add src/lib/spending/components/spending-chart-interaction.ts src/lib/spending/components/spending-chart-interaction.check.ts src/lib/spending/components/SpendingBarChart.svelte
git commit -m "feat: add LayerChart spending interactions"
```

### Task 2: Build and verify the three-option study route

**Files:**
- Create: `src/routes/spending-chart-study/+page.svelte`
- Modify: `scripts/spending-chart-alternatives.check.mjs`
- Delete: `docs/prototypes/spending-chart-alternatives.html`

**Interfaces:**
- Consumes: `SpendingBarChart` with `interaction: SpendingChartInteraction` and `MonthlySpendingRow`.
- Produces: `/spending-chart-study` with cards identified by `data-study="brush"`, `data-study="pan-zoom"`, and `data-study="brush-pan-zoom"`.

- [ ] **Step 1: Replace the old standalone smoke check with a failing live-route check**

```js
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${address.port}/spending-chart-study`);

  assert.equal(await page.locator("[data-study]").count(), 3);
  assert.equal(await page.locator("[data-study] svg.lc-layout-svg").count(), 3);

  const brush = page.locator('[data-study="brush"] .lc-brush-context');
  const brushBox = await brush.boundingBox();
  assert.ok(brushBox);
  await page.mouse.move(brushBox.x + brushBox.width * 0.2, brushBox.y + brushBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(brushBox.x + brushBox.width * 0.5, brushBox.y + brushBox.height * 0.5);
  await page.mouse.up();
  assert.equal(await page.locator('[data-study="brush"] .lc-brush-range').count(), 1);

  const panZoom = page.locator('[data-study="pan-zoom"] [data-interaction="pan-zoom"]');
  await panZoom.locator('[data-action="zoom-in"]').click();
  assert.ok(Number(await panZoom.getAttribute("data-transform-scale")) > 1);

  const combined = page.locator('[data-study="brush-pan-zoom"] .lc-brush-context');
  const combinedBox = await combined.boundingBox();
  assert.ok(combinedBox);
  await page.mouse.move(combinedBox.x + combinedBox.width * 0.2, combinedBox.y + combinedBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(combinedBox.x + combinedBox.width * 0.55, combinedBox.y + combinedBox.height * 0.5);
  await page.mouse.up();
  const combinedChart = page.locator('[data-study="brush-pan-zoom"] [data-interaction="brush-pan-zoom"]');
  assert.ok(Number(await combinedChart.getAttribute("data-transform-scale")) > 1);
  await combinedChart.locator('[data-action="reset"]').click();
  assert.equal(Number(await combinedChart.getAttribute("data-transform-scale")), 1);
} finally {
  await browser.close();
  await server.close();
}
```

- [ ] **Step 2: Run the route check and verify RED**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: FAIL because `/spending-chart-study` does not contain `[data-study]` cards.

- [ ] **Step 3: Create the study route with shared mock data**

```svelte
<script lang="ts">
  import SpendingBarChart from "$lib/spending/components/SpendingBarChart.svelte";
  import type { SpendingCategoryAmounts, MonthlySpendingRow } from "$lib/spending/model.ts";

  const categories = (seed: number, weight: number): SpendingCategoryAmounts => ({
    food: Math.round((4200 + seed * 240) * weight),
    daily: Math.round((1800 + (seed % 4) * 360) * weight),
    transport: Math.round((700 + (seed % 3) * 180) * weight),
    shopping: Math.round((900 + (seed % 5) * 460) * weight),
    home: Math.round((1200 + (seed % 4 === 0 ? 2600 : 0)) * weight),
    leisure: Math.round((600 + (seed % 6) * 210) * weight),
    other: Math.round((250 + (seed % 4) * 120) * weight),
  });

  const rows: MonthlySpendingRow[] = Array.from({ length: 24 }, (_, index) => {
    const invoice = categories(index, 0.82);
    const account = categories(index + 2, 0.18);
    return {
      month: new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 7),
      invoice,
      account,
      total: Object.values(invoice).reduce((sum, value) => sum + value, 0)
        + Object.values(account).reduce((sum, value) => sum + value, 0),
    };
  });

  const concepts = [
    { id: "brush", label: "A · Brush selection", interaction: "brush", copy: "Drag across month bands to keep a precise period selected." },
    { id: "pan-zoom", label: "B · Domain pan + zoom", interaction: "pan-zoom", copy: "Drag to pan; use the controls or modifier-wheel to zoom." },
    { id: "brush-pan-zoom", label: "C · Brush + transform", interaction: "brush-pan-zoom", copy: "Brush to zoom, then pan the focused range. Recommended." },
  ] as const;
</script>

<svelte:head><title>LayerChart spending interaction study</title></svelte:head>

<main class="study-page">
  <header>
    <p class="eyebrow">LayerChart interaction study</p>
    <h1>Monthly spending, three native interaction models</h1>
    <p>Each option uses the same data and chart; only the LayerChart interaction configuration changes.</p>
  </header>

  {#each concepts as concept}
    <section class="study-card" data-study={concept.id}>
      <div class="study-heading">
        <div><h2>{concept.label}</h2><p>{concept.copy}</p></div>
        <code>{concept.interaction}</code>
      </div>
      <SpendingBarChart rows={rows} kind="month" interaction={concept.interaction} label={concept.label} />
    </section>
  {/each}
</main>

<style>
  .study-page { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 80px; }
  header { max-width: 760px; margin-bottom: 32px; }
  .eyebrow { color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  h1 { margin: 8px 0 12px; font-size: clamp(32px, 5vw, 56px); line-height: 1.02; letter-spacing: -0.05em; }
  header p, .study-heading p { color: var(--muted); line-height: 1.6; }
  .study-card { margin-top: 24px; padding: clamp(18px, 3vw, 32px); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  .study-heading { display: flex; align-items: start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
  .study-heading h2, .study-heading p { margin: 0; }
  .study-heading p { margin-top: 6px; }
  code { padding: 6px 9px; border-radius: var(--radius-sm); background: var(--surface-2); white-space: nowrap; }
  @media (max-width: 640px) { .study-page { width: calc(100% - 16px); padding-top: 24px; } .study-heading { flex-direction: column; } }
</style>
```

- [ ] **Step 4: Delete the obsolete simulated HTML prototype**

Delete `docs/prototypes/spending-chart-alternatives.html`. The study now renders real LayerChart components at `/spending-chart-study`.

- [ ] **Step 5: Run the live browser check and verify GREEN**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: exits `0` with no output after verifying all three LayerChart modes.

- [ ] **Step 6: Run complete validation**

Run: `npm run typecheck`

Expected: `svelte-check found 0 errors and 0 warnings`.

Run: `npm test`

Expected: all tests pass, including `scripts/spending-chart-alternatives.check.mjs`.

Run: `npm run build:renderer`

Expected: exits `0` and prerenders `/spending-chart-study`.

- [ ] **Step 7: Commit only Task 2 files**

```bash
git add src/routes/spending-chart-study/+page.svelte scripts/spending-chart-alternatives.check.mjs docs/prototypes/spending-chart-alternatives.html
git commit -m "feat: add LayerChart spending study"
```
