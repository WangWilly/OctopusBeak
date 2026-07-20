# Data Issue Progressive Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the data-issue prototype into one progressively expanding card whose primary action says「排除錯誤匯入」and whose diagnosis and preview stages animate into place.

**Architecture:** Keep the existing `list → diagnosis → preview` state machine and render those states inside the same card structure. Use Svelte's installed `slide` transition for the newly revealed body only; do not add dependencies or change ledger behavior.

**Tech Stack:** Svelte 5, TypeScript, Svelte built-in transitions, Node test runner, Electron/CDP.

## Global Constraints

- Remove the initial status chip, diagnosis breadcrumb, and error-history UI.
- Preserve error records in `prototype-model.ts`.
- Use the exact Traditional Chinese entry copy `排除錯誤匯入`.
- Respect `prefers-reduced-motion` by setting transition duration to zero.
- Do not add dependencies, real ledger writes, routes, or new state abstractions.

---

### Task 1: Progressive data-issue card

**Files:**
- Modify: `src/lib/data-issues/prototype-ui.check.ts`
- Modify: `src/lib/data-issues/DataIssuesPrototype.svelte`
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Consumes: existing `state.screen`, `send(event)`, and `open-diagnosis` / `preview` events.
- Produces: a single `.workflow-card` for `list`, `diagnosis`, and `preview`, plus `.stage-reveal` elements using Svelte `slide`.

- [ ] **Step 1: Write the failing source checks**

```ts
test("data issue workflow progressively reveals the next stage", async () => {
  const source = await readFile(new URL("./DataIssuesPrototype.svelte", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../i18n/i18n.ts", import.meta.url), "utf8");

  assert.match(source, /import \{ slide \} from "svelte\/transition"/);
  assert.match(source, /class="stage-reveal" transition:slide/);
  assert.match(i18n, /excludeInvalidImport: "排除錯誤匯入"/);
  assert.doesNotMatch(source, /class="chip"/);
  assert.doesNotMatch(source, /class="case-heading"/);
  assert.doesNotMatch(source, /class="error-history"/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/prototype-ui.check.ts`

Expected: FAIL because `slide`, `.stage-reveal`, and `excludeInvalidImport` are absent.

- [ ] **Step 3: Add the minimal translation key**

Add to the English and Traditional Chinese `dataIssues` dictionaries:

```ts
excludeInvalidImport: "Exclude invalid import",
excludeInvalidImport: "排除錯誤匯入",
```

- [ ] **Step 4: Render all three states in one card**

Import the existing Svelte transition and compute its duration from the platform preference:

```svelte
import { slide } from "svelte/transition";

let reduceMotion = false;

onMount(() => {
  reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // existing sessionStorage restoration stays here
});

const stageTransition = { duration: reduceMotion ? 0 : 220 };
```

Replace the separate `list`, `diagnosis`, and `preview` cards with one conditional `.workflow-card`. Keep the initial issue facts as the card header. Reveal diagnosis and preview bodies with:

```svelte
{#if state.screen === "diagnosis"}
  <div class="stage-reveal" transition:slide={stageTransition}>
    <!-- existing source-selection controls -->
  </div>
{:else if state.screen === "preview" && state.preview}
  <div class="stage-reveal" transition:slide={stageTransition}>
    <!-- existing impact-preview controls -->
  </div>
{/if}
```

The initial primary action must dispatch the unchanged event and use the new copy:

```svelte
<button class="button primary" onclick={() => send({ type: "open-diagnosis" })}>
  {$t.dataIssues.excludeInvalidImport}
</button>
```

Delete the rendered `.chip`, `.case-heading`, and `.error-history` blocks only. Do not delete `state.errors` or error transitions from the model.

- [ ] **Step 5: Keep the transition clipped and responsive**

```css
.workflow-card { overflow: hidden; }
.stage-reveal { overflow: hidden; border-top: 1px solid var(--border); }
```

Reuse the existing workflow-step, source, preview, form, and action styles. Remove selectors that no longer have markup.

- [ ] **Step 6: Run focused checks and verify GREEN**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/prototype-ui.check.ts src/lib/data-issues/prototype-model.check.ts`

Expected: 5 tests pass, 0 fail.

- [ ] **Step 7: Commit the working interaction**

```bash
git add src/lib/data-issues/prototype-ui.check.ts src/lib/data-issues/DataIssuesPrototype.svelte src/lib/i18n/i18n.ts
git commit -m "feat: animate data issue workflow"
```

### Task 2: Electron and design QA

**Files:**
- Modify: `design-qa.md`

**Interfaces:**
- Consumes: the built Electron renderer and CDP endpoint on port 9222.
- Produces: visual evidence for list, diagnosis, preview, and narrow states plus a passing `design-qa.md`.

- [ ] **Step 1: Run static verification**

Run: `npm run typecheck && npm test && npm run build`

Expected: all commands exit 0; typecheck reports 0 errors and 0 warnings; all tests pass.

- [ ] **Step 2: Verify the Electron interaction through CDP**

At `#/data-issues`, confirm:

```text
initial: no 調查中 chip; 排除錯誤匯入 visible
click entry action: source stage appears in the same workflow card
select source + preview: impact stage appears in the same workflow card
diagnosis/preview: no breadcrumb and no error-history disclosure
console: no errors
```

Also inspect a narrow viewport and assert `document.documentElement.scrollWidth === document.documentElement.clientWidth`.

- [ ] **Step 3: Update design QA evidence**

Update `design-qa.md` with the four user screenshots as source truth, new Electron capture paths, desktop and narrow viewport states, interaction evidence, required fidelity surfaces, comparison history, and exactly:

```text
final result: passed
```

Use `blocked` instead if any actionable P0/P1/P2 mismatch remains.

- [ ] **Step 4: Commit QA evidence**

```bash
git add -f design-qa.md
git commit -m "docs: verify progressive data issue workflow"
```
