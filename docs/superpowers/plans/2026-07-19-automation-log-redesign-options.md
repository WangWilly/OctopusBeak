# Automation Log Redesign Options — Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the aggregate progress bar from the production Automation running summary and deliver three interactive, directly comparable log-viewer prototypes.

**Architecture:** Keep the production change narrowly scoped to `AutomationDashboard.svelte` and its source-level regression check. Build the three visual directions as isolated, self-contained HTML prototypes under `prototypes/automation-log-options/`, using the existing Automation shell, Traditional Chinese labels, realistic concurrent task data, and no Electron or banking side effects.

**Tech Stack:** Svelte 5 source checks for production; standalone HTML/CSS/JavaScript for prototypes.

---

### Task 1: Remove the production aggregate progress bar

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.check.ts`
- Modify: `src/lib/automation/AutomationDashboard.svelte`

**Step 1: Write the failing regression check**

- Replace the assertions for `combinedTaskProgress` with assertions that the running-summary aggregate progress markup and state are absent.
- Keep assertions proving per-task progress UI remains available.

**Step 2: Run the focused check to verify RED**

Run: `npx tsx src/lib/automation/AutomationDashboard.check.ts`
Expected: FAIL because the aggregate progress state/function/markup still exists.

**Step 3: Implement the minimal production change**

- Remove `aggregateProgress` reactive state.
- Remove `combinedTaskProgress`.
- Remove the hero `aggregate-progress` block only.
- Preserve running task count, 「查看日誌」, 「停止全部」, and per-task progress/status.

**Step 4: Run the focused check to verify GREEN**

Run: `npx tsx src/lib/automation/AutomationDashboard.check.ts`
Expected: PASS.

### Task 2: Build three isolated interactive log prototypes

**Files:**
- Create: `prototypes/automation-log-options/task-stack.html`
- Create: `prototypes/automation-log-options/console-matrix.html`
- Create: `prototypes/automation-log-options/merged-stream.html`
- Create: `prototypes/automation-log-options/index.html`

**Step 1: Build the three directions in parallel**

- Option 1 — Task stack: full-width stacked log sections with sticky task headers and independent collapse.
- Option 2 — Console matrix: equal responsive consoles with independent scroll and follow-tail controls.
- Option 3 — Merged stream: one chronological stream with task tags, filter/search, error-only, and pause/follow controls.
- In every option, one modal must show multiple active task logs simultaneously.
- Do not include the aggregate hero progress bar.

**Step 2: Add the comparison hub**

- Add a simple index page linking all three options and summarizing their operational trade-offs.
- Keep every option directly addressable by URL.

**Step 3: Render all three at one viewport**

- Produce same-size preview screenshots for direct visual comparison.
- Check modal fit, content density, controls, overflow, and task-state legibility.

### Task 3: Verify implementation and hand off for selection

**Files:**
- Modify: `design-qa.md`

**Step 1: Verify production code**

Run the focused dashboard check, typecheck, and build. Record any unrelated pre-existing failures without changing their scope.

**Step 2: Verify prototype interactions**

- Confirm open/close and Escape behavior.
- Confirm each option displays at least four active tasks at once.
- Confirm option-specific controls work.
- Confirm no option auto-opens on simulated task start.

**Step 3: Record visual QA and share links**

- Append a concise comparison result to `design-qa.md`.
- Return all three prototype links and ask the user to choose 1, 2, or 3 before production log UI implementation.

**Repository note:** Keep the current dirty worktree uncommitted; do not include unrelated user changes in a commit.
