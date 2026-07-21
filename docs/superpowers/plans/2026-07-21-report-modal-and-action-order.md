# Report Modal and Action Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the report-data-issue dialog centered in the Electron viewport after scrolling and keep its trigger as the rightmost account action.

**Architecture:** Preserve the native `<dialog>` and existing shared account toolbar. Add a local fixed-position override to the report dialog and place the report trigger last in DOM order so visual and keyboard order agree.

**Tech Stack:** Svelte 5 compatibility syntax, TypeScript, CSS, Node test runner, Electron CDP.

## Global Constraints

- Do not change global modal positioning or other modal components.
- Do not use CSS `order`; DOM order must match keyboard focus order.
- Do not add dependencies or components.
- Do not create `design-qa.md`.

---

### Task 1: Pin the report dialog and trigger positions

**Files:**
- Modify: `src/lib/data-issues/data-issues-ui.check.ts`
- Modify: `src/lib/data-issues/ReportDataIssueModal.svelte`
- Modify: `src/lib/shared-accounts/components/AccountTable.svelte`

**Interfaces:**
- Consumes: existing `ReportDataIssueModal` native `<dialog>` and `AccountTable` action group.
- Produces: unchanged component props and events; only layout behavior changes.

- [ ] **Step 1: Add the failing source check**

Append this check to `src/lib/data-issues/data-issues-ui.check.ts`:

```ts
test("report dialog stays viewport-centered", async () => {
  const modal = await readFile(new URL("./ReportDataIssueModal.svelte", import.meta.url), "utf8");

  assert.match(modal, /\.report-modal\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?margin:\s*auto;/);
});

test("report trigger is the final account action", async () => {
  const accounts = await readFile(new URL("../shared-accounts/components/AccountTable.svelte", import.meta.url), "utf8");

  const actions = accounts.match(/<div class="action-group">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(actions);
  assert.ok(actions.lastIndexOf("report-issue-button") > actions.lastIndexOf("positionsOpen = true"));
});
```

- [ ] **Step 2: Run the focused check and confirm the regression is red**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts
```

Expected: FAIL because `.report-modal` is not fixed and the report button precedes the positions button.

- [ ] **Step 3: Keep the dialog centered on the viewport**

Update `.report-modal` in `src/lib/data-issues/ReportDataIssueModal.svelte`:

```css
.report-modal {
  position: fixed;
  inset: 0;
  width: min(680px, calc(100vw - 40px));
  margin: auto;
  padding: 0;
}
```

- [ ] **Step 4: Make the report trigger the final action**

In `src/lib/shared-accounts/components/AccountTable.svelte`, keep the positions button where it is and move the existing report button block immediately after it:

```svelte
{#if mode === "asset" && selectedPositions.length > 0}
  <button class="button secondary" type="button" on:click={() => (positionsOpen = true)}>{$t.accounts.positions}</button>
{/if}
{#if onReportDataIssue && selectedAccount.valueAvailability === "available"}
  <button
    class="button secondary report-issue-button"
    type="button"
    aria-label={$t.dataIssues.reportProblem}
    title={$t.dataIssues.reportProblem}
    on:click={() => onReportDataIssue?.(selectedAccount)}
  >
    <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" />
  </button>
{/if}
```

- [ ] **Step 5: Run automated verification**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts
npm run typecheck
npm test
git diff --check
```

Expected: focused check passes, typecheck reports 0 errors and 0 warnings, all tests pass, and `git diff --check` exits 0.

- [ ] **Step 6: Verify the visible Electron behavior through CDP**

Start the development app if port 9222 is unavailable:

```bash
npm run desktop:dev
curl -fsS http://127.0.0.1:9222/json/version
npx libretto connect http://127.0.0.1:9222 --session electron-cdp
npx libretto snapshot --session electron-cdp
```

On the assets page, select an account with a positions action, scroll the page, and open the report dialog. Confirm in the live CDP page that:

- the report icon follows the positions button;
- the dialog center matches the viewport center before and after scrolling;
- closing the dialog restores focus without leaving rendered modal content behind;
- the renderer console has no new errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/lib/data-issues/data-issues-ui.check.ts src/lib/data-issues/ReportDataIssueModal.svelte src/lib/shared-accounts/components/AccountTable.svelte
git commit -m "Keep report controls viewport aligned"
```
