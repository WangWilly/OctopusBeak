# Automation Active Task Jump Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one isolated Automation prototype where active tasks in the running summary navigate to their inline logs.

**Architecture:** Create one self-contained HTML prototype with realistic mock data and native browser behavior. Keep all presentation and interaction local to the prototype; add one source-level Node check for the required interaction contract.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js assertions.

## Global Constraints

- Do not modify the production app.
- Remove the 「查看日誌」 action from the prototype.
- Task start and polling never cause automatic expansion or scrolling.
- Preserve other manually opened inline logs.
- Use no new dependencies.

---

### Task 1: Active-task summary and inline-log navigation

**Files:**
- Create: `prototypes/automation-active-task-jump/index.html`
- Create: `prototypes/automation-active-task-jump/active-task-jump.check.mjs`

**Interfaces:**
- Consumes: browser `scrollIntoView`, `focus`, `matchMedia`, and DOM events.
- Produces: `revealTaskLog(taskId)` in the prototype script.

- [ ] **Step 1: Write the failing source contract check**

Assert that the prototype contains active-task buttons, no 「查看日誌」 button, `revealTaskLog`, `scrollIntoView`, focus transfer, reduced-motion handling, and multiple independently open inline logs.

- [ ] **Step 2: Run the check to verify it fails**

Run: `node prototypes/automation-active-task-jump/active-task-jump.check.mjs`
Expected: FAIL because `index.html` does not exist.

- [ ] **Step 3: Implement the self-contained prototype**

Build the existing Automation shell, running summary task buttons, three workflow stages, and inline log panels. Selecting an active task opens its stage and log, scrolls to it, focuses its heading, and applies a temporary highlight.

- [ ] **Step 4: Run the source check**

Run: `node prototypes/automation-active-task-jump/active-task-jump.check.mjs`
Expected: PASS.

- [ ] **Step 5: Render and visually verify**

Render at 1600 × 1000. Confirm typography, layout, active-task scanability, target highlight, and narrow responsiveness. Start a local-only static server and provide the prototype URL.

**Repository note:** Keep the existing dirty worktree uncommitted and preserve unrelated user changes.
