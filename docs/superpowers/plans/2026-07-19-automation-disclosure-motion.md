# Automation Disclosure Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animate automation stage, inline-log, and show-all disclosures without changing their layout or state model.

**Architecture:** Reuse Svelte's installed `slide` transition through one local reduced-motion-aware wrapper in `AutomationDashboard.svelte`. Apply it to the three existing conditional surfaces and add a CSS transition to the existing caret.

**Tech Stack:** Svelte 5, TypeScript, native CSS, Node assertion checks, Electron CDP.

## Global Constraints

- No new dependency, route, data state, or visual redesign.
- Expansion and collapse duration is 220 ms; caret rotation is 180 ms.
- `prefers-reduced-motion: reduce` changes disclosure duration to 0 ms.
- Preserve table semantics, fixed column widths, labels, and controls.

---

### Task 1: Disclosure transitions

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.check.ts`
- Modify: `src/lib/automation/AutomationDashboard.svelte`

**Interfaces:**
- Consumes: Svelte `slide(node, { duration })`.
- Produces: `disclosureSlide(node: Element)` transition used by stage bodies, inline logs, and task rows.

- [ ] **Step 1: Write the failing source regression checks**

Add assertions for the `slide` import, reduced-motion wrapper, three transition directives, and caret transition:

```ts
assert.match(source, /import \{ slide \} from "svelte\/transition"/);
assert.match(source, /function disclosureSlide\(node: Element\)/);
assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \? 0 : 220/);
assert.match(source, /class="stage-body"[^>]*transition:disclosureSlide/);
assert.match(source, /class="task-row"[^>]*transition:disclosureSlide/);
assert.match(source, /class="inline-log-panel"[^>]*transition:disclosureSlide/);
assert.match(source, /transition: transform 180ms ease/);
```

- [ ] **Step 2: Run the focused check and confirm the new assertions fail**

Run: `node --no-warnings --experimental-strip-types --test src/lib/automation/AutomationDashboard.check.ts`

Expected: FAIL on the missing `svelte/transition` import.

- [ ] **Step 3: Add the smallest implementation**

Import `slide`, add the local wrapper, apply `transition:disclosureSlide` to the existing stage body, keyed task rows, and inline log panel, and add `transition: transform 180ms ease` to `.stage-caret`.

```svelte
<script lang="ts">
  import { slide } from "svelte/transition";

  function disclosureSlide(node: Element) {
    return slide(node, {
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
    });
  }
</script>
```

- [ ] **Step 4: Run focused and project verification**

Run: `node --no-warnings --experimental-strip-types --test src/lib/automation/AutomationDashboard.check.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0 with no Svelte or TypeScript errors.

Run: `npm run build`

Expected: exit 0 and renderer/electron bundles emitted.

- [ ] **Step 5: Verify the live Electron interactions**

Connect to `http://127.0.0.1:9222`, reload the built page, and verify stage collapse/expand, inline-log collapse/expand, and show-all/collapse. Capture the implementation at the same desktop viewport and confirm there are no fresh console errors.

- [ ] **Step 6: Record design QA**

Update `design-qa.md` with the source screenshot paths, implementation screenshot path, viewport/state, the three interactions, console result, focused comparison, and `final result: passed` only when no actionable P0/P1/P2 mismatch remains.
