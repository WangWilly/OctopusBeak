# Compact Data-Issue Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the existing data-issue prototype into the approved compact workflow and retain every failed attempt in visible error history.

**Architecture:** Extend the existing pure prototype state with append-only error records, then render the same state through one compact Svelte workflow. Reuse the installed icon component and existing shell/tokens; add no dependency or backend work.

**Tech Stack:** Svelte 5, TypeScript, Node test runner, existing OctopusBeak components and CSS tokens.

## Global Constraints

- Renderer-only prototype; no SQLite or IPC changes.
- No extra report icon on the data-issue page.
- Remove the user-facing scenario selector.
- Every failed or blocked attempt remains visible in error history.
- Add no package.

---

### Task 1: Append-only prototype errors

**Files:**
- Modify: `src/lib/data-issues/prototype-model.check.ts`
- Modify: `src/lib/data-issues/prototype-model.ts`

**Interfaces:**
- Produces: `DataIssueErrorRecord` and `DataIssuePrototypeState.errors`.
- Consumes: existing `preview` state transition.

- [ ] Add a failing assertion that blocked and failed previews append ordered error records and preserve `currentValue`.
- [ ] Run `node --no-warnings --experimental-strip-types --test src/lib/data-issues/prototype-model.check.ts`; expect the new assertion to fail because `errors` is absent.
- [ ] Add the minimal error type, seeded history, and append behavior to the two failure branches.
- [ ] Re-run the focused check; expect all tests to pass.
- [ ] Commit model and test together.

### Task 2: Compact workflow and icon action

**Files:**
- Modify: `src/lib/data-issues/DataIssuesPrototype.svelte`
- Modify: `src/lib/shared-accounts/components/AccountTable.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Create: `src/lib/data-issues/prototype-ui.check.ts`

**Interfaces:**
- Consumes: `DataIssuePrototypeState.errors` and the existing transition functions.
- Produces: compact diagnosis/preview UI and accessible icon-only report action.

- [ ] Add a source check requiring the warning icon, accessible report label, error disclosure, and absence of the prototype scenario selector.
- [ ] Run the focused check; expect failure against the current markup.
- [ ] Replace the account text action with the installed warning icon while retaining `aria-label` and `title`.
- [ ] Render diagnosis and preview in one three-row workflow, use direct safe preview in the UI, and add the error disclosure.
- [ ] Add only the new English and Traditional Chinese labels required by the compact workflow.
- [ ] Re-run the focused check and prototype model check; expect both to pass.
- [ ] Commit the UI change.

### Task 3: Visual and regression verification

**Files:**
- Create: `design-qa.md`

**Interfaces:**
- Consumes: the approved simplified option 3 image and built Electron app.
- Produces: a passing design QA report.

- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`; expect zero failures.
- [ ] Open the Electron app through CDP and exercise report, diagnosis, preview, error disclosure, and quarantine confirmation guards.
- [ ] Capture the implemented preview at the same desktop state as the approved reference and inspect both images.
- [ ] Record comparison findings in `design-qa.md`, fix P0-P2 issues, and repeat until it says `final result: passed`.
- [ ] Commit the QA report and any final fixes.
