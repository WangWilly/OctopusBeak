# Data Issue Navigation and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users report asset and liability balance issues, return from a case to the exact originating account with screen focus, and understand or step back from an exclusion preview.

**Architecture:** Keep hash routing and the existing shared account table. Extend only the assets/liabilities route payload with an optional account ID, let `AccountTable` own selection/scroll/focus, and enrich the existing exclusion preview DTO with the already-available account label. Reuse the current modal and inline CSS patterns; add no route, persistence model, dependency, or shared tooltip abstraction.

**Tech Stack:** Svelte 5, TypeScript, Electron desktop API, Node test runner, SQLite-backed ledger store, Lucide Svelte icons.

## Global Constraints

- Deep links are `#/assets/{accountId}` and `#/liabilities/{accountId}`; investment accounts return to assets.
- Returning selects the exact account row, scrolls it into view, and gives it keyboard/screen-reader focus.
- Closing or cancelling the report dialog removes it from layout and never leaves a page-bottom panel.
- Asset and liability dashboards use the same report modal and creation API.
- Preview labels show the account name first and the internal account ID second.
- The three impact metrics explain why an account is affected, what is excluded, what is retained, and why it is retained on hover and keyboard focus.
- The preview-stage Back action returns to source selection without clearing the selected source.
- Respect `prefers-reduced-motion`; do not add dependencies, routes, persistence fields, or a tooltip component framework.
- Tests and documentation use de-identified synthetic accounts and values.

---

### Task 1: Shared Reporting and Account Deep Links

**Files:**
- Modify: `src/routes/+page.svelte`
- Modify: `src/lib/assets/AssetsDashboard.svelte`
- Modify: `src/lib/liabilities/LiabilitiesDashboard.svelte`
- Modify: `src/lib/shared-accounts/components/AccountTable.svelte`
- Modify: `src/lib/data-issues/ReportDataIssueModal.svelte`
- Modify: `src/lib/data-issues/DataIssuesDashboard.svelte`
- Test: `src/lib/data-issues/data-issues-ui.check.ts`
- Test: `src/lib/shared-accounts/components/AccountTable.check.ts`

**Interfaces:**
- Consumes: `AccountRowDto.id`, `AccountRowDto.group`, `ReportDataIssueModal`, and `window.octopusBeak.dataIssues.create(input)`.
- Produces: dashboard prop `focusAccountId: string | null`, table prop `focusAccountId: string | null`, and account detail hashes `#/assets/{encodedAccountId}` or `#/liabilities/{encodedAccountId}`.

- [ ] **Step 1: Write failing source-contract tests**

Add assertions that require: asset reporting through `ReportDataIssueModal`; both dashboards passing `focusAccountId`; route parsing that preserves and decodes account IDs; an issue-detail backlink based on account group; rows with `data-account-id`, roving `tabindex`, `focus({ preventScroll: true })`, and `scrollIntoView`; and modal markup guarded by `{#if account && open}`.

```ts
assert.match(assets, /onReportDataIssue=\{openReport\}/);
assert.match(assets, /<ReportDataIssueModal bind:open=\{reportOpen\}/);
assert.match(route, /focusAccountId/);
assert.match(route, /decodeURIComponent/);
assert.match(dashboard, /accountReturnHref\(issue\.account\)/);
assert.match(table, /data-account-id=\{account\.id\}/);
assert.match(table, /focus\(\{ preventScroll: true \}\)/);
assert.match(table, /scrollIntoView/);
assert.match(modal, /\{#if account && open\}/);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts src/lib/shared-accounts/components/AccountTable.check.ts`

Expected: FAIL on the newly added asset-reporting, deep-link focus, backlink, and modal-unmount assertions.

- [ ] **Step 3: Implement the minimal shared behavior**

In `+page.svelte`, decode the optional second hash segment only for `assets`, `liabilities`, and `data-issues`; pass it as `focusAccountId` to the corresponding dashboard. In both account dashboards, pass that prop to `AccountTable`; add the liabilities report state/create pattern to assets. In `AccountTable`, use a reactive async helper with `tick()` to select, locate by exact `dataset.accountId`, scroll, and focus the requested row; make rows keyboard-focusable. In the issue detail, compute the group-based backlink. Render the dialog only while both account and open are truthy.

```ts
function accountReturnHref(account: DataIssueDetailDto["account"]) {
  const route = account.group === "liability" ? "liabilities" : "assets";
  return `#/${route}/${encodeURIComponent(account.id)}`;
}
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts src/lib/shared-accounts/components/AccountTable.check.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the navigation slice**

```bash
git add src/routes/+page.svelte src/lib/assets/AssetsDashboard.svelte src/lib/liabilities/LiabilitiesDashboard.svelte src/lib/shared-accounts/components/AccountTable.svelte src/lib/data-issues/ReportDataIssueModal.svelte src/lib/data-issues/DataIssuesDashboard.svelte src/lib/data-issues/data-issues-ui.check.ts src/lib/shared-accounts/components/AccountTable.check.ts
git commit -m "feat: link data issues back to accounts"
```

### Task 2: Explainable, Reversible Exclusion Preview

**Files:**
- Modify: `src/lib/data-issues/types.ts`
- Modify: `src/lib/data-issues/server/store.ts`
- Modify: `src/lib/data-issues/DataIssuesDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Test: `src/lib/data-issues/server/store.check.ts`
- Test: `src/lib/data-issues/data-issues-ui.check.ts`

**Interfaces:**
- Consumes: `ExclusionPreviewDto`, `buildAccountOverview(...)`, `selectedSource`, and existing progressive `slide` transition.
- Produces: `affectedAccounts[].accountLabel: string`, three accessible metric explanations, and `backToSourceSelection()` that retains `selectedSource`.

- [ ] **Step 1: Write failing store and UI tests**

Extend the store fixture assertion so every affected preview row has the account label returned by the visible before/after account map. Extend UI checks for label-first/ID-second rendering, three `role="tooltip"` nodes reachable by `aria-describedby`, localized explanation copy, and a secondary preview Back button calling `backToSourceSelection`.

```ts
assert.equal(preview.affectedAccounts[0]?.accountLabel, "Example Bank loan ****0420");
assert.match(dashboard, /<strong>\{account\.accountLabel\}<\/strong>/);
assert.equal((dashboard.match(/role="tooltip"/g) ?? []).length, 3);
assert.match(dashboard, /onclick=\{backToSourceSelection\}/);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/store.check.ts src/lib/data-issues/data-issues-ui.check.ts`

Expected: FAIL because `accountLabel`, tooltips, and preview Back do not exist.

- [ ] **Step 3: Add the preview label at the store boundary**

Add `accountLabel: string` to `ExclusionPreviewDto.affectedAccounts`. In `affectedAccounts`, resolve the display record with `after.get(accountId) ?? before.get(accountId)` and use its `label`, falling back to the account ID only if neither map has a record.

```ts
const account = after.get(accountId) ?? before.get(accountId);
return {
  accountId,
  accountLabel: account?.label ?? accountId,
  before: accountState(before, accountId),
  after: accountState(after, accountId),
};
```

- [ ] **Step 4: Implement preview explanations and Back**

Render `accountLabel` as the primary line and `accountId` as muted secondary metadata. Wrap each metric in a focusable `.impact-metric` using `aria-describedby`; show its adjacent `role="tooltip"` content on `:hover` and `:focus-within`. Add localized copy describing exact-source physical exclusion, duplicate retention by another active source, and affected-account dependency/fallback. Add a secondary Back action before the primary action.

```ts
function backToSourceSelection() {
  state = { ...state, preview: null };
  stageError = null;
}
```

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/store.check.ts src/lib/data-issues/data-issues-ui.check.ts`

Expected: all focused tests PASS.

- [ ] **Step 6: Commit the preview slice**

```bash
git add src/lib/data-issues/types.ts src/lib/data-issues/server/store.ts src/lib/data-issues/DataIssuesDashboard.svelte src/lib/i18n/i18n.ts src/lib/data-issues/server/store.check.ts src/lib/data-issues/data-issues-ui.check.ts
git commit -m "feat: clarify data issue exclusion impact"
```

### Task 3: Full Verification and Desktop Interaction QA

**Files:**
- Modify: `design-qa.md`

**Interfaces:**
- Consumes: completed Task 1 and Task 2 behavior.
- Produces: verification evidence for tests, types, build, modal lifecycle, both report entry points, transition Back, tooltips, and account focus.

- [ ] **Step 1: Run the complete automated verification suite**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: Svelte and TypeScript report 0 errors.

Run: `npm run build`

Expected: renderer and Electron builds complete successfully.

- [ ] **Step 2: Launch a synthetic desktop ledger**

Run the existing mock-ledger seed and desktop development command with a temporary user-data directory. Do not read or modify the user's production ledger.

Expected: Electron launches with the current feature branch and synthetic accounts.

- [ ] **Step 3: Verify the six user journeys through Electron CDP**

Verify: closing and cancelling the report dialog leaves no page-bottom panel; asset and liability alert actions both open the modal; the issue backlink returns to the exact account and the row is selected, visible, and `document.activeElement`; each impact metric reveals its explanation on hover and keyboard focus; affected rows show name then ID; preview Back animates to source selection and preserves the chosen source.

- [ ] **Step 4: Compare the implemented states visually and record evidence**

Capture the same desktop viewport for the source-selection and impact-preview states, compare alignment, spacing, typography, borders, action hierarchy, clipping, and reduced-motion behavior against the approved screenshots, then update `design-qa.md` with the observed results and any resolved mismatch.

- [ ] **Step 5: Commit QA evidence**

```bash
git add design-qa.md
git commit -m "test: verify data issue navigation refinements"
```
