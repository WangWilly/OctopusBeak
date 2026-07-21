# Data Issue Status Tracking List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the data-issue list a localized status-tracking view with segmented filters, visible statuses, and system-timezone timestamps.

**Architecture:** Keep the change in the existing dashboard and i18n dictionary. Reuse the current status mapping and timezone formatter; CSS mirrors the spending month selector without introducing a shared abstraction for two callers.

**Tech Stack:** Svelte 5, TypeScript, Node test runner, existing CSS tokens

## Global Constraints

- Do not add dependencies or components.
- Do not create `design-qa.md`.
- Preserve existing list filtering and navigation.

---

### Task 1: Status-tracking list presentation

**Files:**
- Modify: `src/lib/data-issues/data-issues-ui.check.ts`
- Modify: `src/lib/data-issues/DataIssuesDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Consumes: `formatUtcDateTime(value, $systemTimezone, $locale)` and `statusLabel(status)`
- Produces: no new interface

- [x] **Step 1: Write the failing check**

Add assertions that the list renders `statusLabel(issue.status)`, formats `issue.updatedAt`, uses `dataIssues.statusTracking` and `dataIssues.handleIncorrectImports`, and exposes the segmented container/selected-state CSS.

- [x] **Step 2: Run the focused check and verify failure**

Run: `node --test src/lib/data-issues/data-issues-ui.check.ts`

Expected: FAIL because the new list presentation is absent.

- [x] **Step 3: Implement the minimal dashboard and copy changes**

Use `sideValue={state.status === "detail" ? statusLabel(state.issue.status) : $t.dataIssues.handleIncorrectImports}`, replace the heading key, format `issue.updatedAt`, add a status badge, and restyle `.status-filter` as a single segmented surface.

- [x] **Step 4: Verify focused and project checks**

Run: `node --test src/lib/data-issues/data-issues-ui.check.ts`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [x] **Step 5: Verify the Electron UI**

Run the desktop app, inspect the data-issues list through CDP, and confirm the five requested visible changes at desktop width.
