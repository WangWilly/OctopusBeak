# Automation Logging Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify parallel sync launch and provide three directly comparable live-log presentations.

**Architecture:** Keep one React app and one parallel-run state. Select `drawer`, `inline`, or `console` from `?logging=`; each presentation renders the same deterministic log event list, so only layout changes between links.

**Tech Stack:** React 19, Vite 6, Phosphor Icons, native CSS, Node test runner, Sites hosting.

## Global Constraints

- Reuse the existing task data, timer, dialogs, sidebar, and three-stage workflow.
- Do not add routes, packages, backend calls, persistence, scheduling, queues, or retry logic.
- Keep Traditional Chinese product copy.
- Keep the existing `.openai/hosting.json` project and workspace-wide access.

---

### Task 1: Shared live-log events

**Files:**
- Modify: `prototypes/automation-guided-flow/src/task-state.test.mjs`
- Modify: `prototypes/automation-guided-flow/src/task-state.mjs`

**Interfaces:**
- Produces: `buildRunLogs(progress: number, elapsedSeconds: number): Array<{time: string, task: string, message: string, level: "info" | "success" | "error"}>`

- [ ] **Step 1: Write the failing test**

Add a test that imports `buildRunLogs`, checks that progress `4` returns only the dispatch event, and checks that progress `60` includes the failed 渣打 event with `level: "error"`.

```js
test("buildRunLogs reveals chronological task events as progress advances", () => {
  assert.equal(buildRunLogs(4, 0).length, 1);
  const logs = buildRunLogs(60, 18);
  assert.equal(logs.at(-1).task, "渣打銀行對帳單");
  assert.equal(logs.at(-1).level, "error");
});
```

- [ ] **Step 2: Verify the test fails for the missing export**

Run: `node --test src/task-state.test.mjs`

Expected: FAIL because `buildRunLogs` is not exported.

- [ ] **Step 3: Implement the smallest deterministic event builder**

Use one ordered event array with progress thresholds and return only reached events. Format time from `elapsedSeconds` without timers or I/O.

```js
export function buildRunLogs(progress, elapsedSeconds) {
  const now = (offset) => `00:${String(Math.max(0, elapsedSeconds - offset)).padStart(2, "0")}`;
  return [
    [0, "系統", "已送出 14 個同步任務", "info", 0],
    [10, "富邦全部對帳單", "已連線銀行網站", "info", 3],
    [24, "玉山信用卡對帳單", "登入完成，開始下載", "info", 7],
    [42, "富邦全部對帳單", "已下載 5 個檔案", "success", 12],
    [58, "渣打銀行對帳單", "登入逾時，需要重新執行", "error", 18],
  ].filter(([threshold]) => progress >= threshold).map(([, task, message, level, offset]) => ({ time: now(offset), task, message, level }));
}
```

- [ ] **Step 4: Verify all state tests pass**

Run: `node --test src/task-state.test.mjs`

Expected: 5 tests pass.

### Task 2: Simplified launch and three presentations

**Files:**
- Modify: `prototypes/automation-guided-flow/src/App.jsx`
- Modify: `prototypes/automation-guided-flow/src/styles.css`

**Interfaces:**
- Consumes: `buildRunLogs(progress, elapsedSeconds)` from Task 1.
- Produces: direct variants at `?logging=drawer`, `?logging=inline`, and `?logging=console`.

- [ ] **Step 1: Simplify the idle hero and confirmation sheet**

Change the hero to one heading and one `同步全部` button. Remove summary counts and `調整任務`. Trim `PreflightSheet` to credential readiness, selected tasks, `取消`, and `開始同步`; delete warning and acknowledgement state/props.

```jsx
<section className="hero simple-hero">
  <h1>{count} 個任務可以同步執行</h1>
  <button className="button primary hero-primary" onClick={onStart}><Play size={18} weight="fill" />同步全部</button>
</section>
```

- [ ] **Step 2: Select the presentation from the query parameter**

Normalize once at module load and default invalid values to `drawer`.

```js
const requestedLoggingMode = new URLSearchParams(window.location.search).get("logging");
const loggingMode = ["drawer", "inline", "console"].includes(requestedLoggingMode) ? requestedLoggingMode : "drawer";
```

- [ ] **Step 3: Add one shared log renderer**

Render time, task, message, and error/success color from `buildRunLogs`. Keep the markup reusable in all three surfaces.

```jsx
function LogEntries({ logs }) {
  return <ol className="log-entries">{logs.map((log) => <li className={log.level} key={`${log.time}-${log.task}`}><time>{log.time}</time><div><strong>{log.task}</strong><span>{log.message}</span></div></li>)}</ol>;
}
```

- [ ] **Step 4: Add drawer, inline, and console wrappers**

- Drawer: fixed right panel with aggregate progress, `LogEntries`, close, and stop-all.
- Inline: add a unique `日誌` button per included task row and expand the selected row directly beneath it.
- Console: fixed bottom panel with chronological `LogEntries`, collapse, and stop-all.

All three wrappers receive only `run`, `logs`, visibility callbacks, and `onStop`; they do not own run state.

- [ ] **Step 5: Connect launch and visibility**

On confirm, start the existing parallel run, close confirmation, then open the selected log surface. During a run, the hero contains `查看日誌` and `停止全部`; `查看日誌` reopens the relevant surface.

- [ ] **Step 6: Style only the new surfaces and delete obsolete rules**

Remove `.preflight-warning`, `.acknowledge`, and unused multi-check spacing. Add `.live-log-drawer`, `.inline-log`, `.log-console`, and shared `.log-entries` rules using existing colors and borders. Keep the drawer responsive and the console above the 64px sidebar breakpoint.

- [ ] **Step 7: Build and verify**

Run: `node --test src/task-state.test.mjs && npm run build && git diff --check`

Expected: tests pass, Vite emits `dist/server/index.js`, and diff check is clean.

### Task 3: Browser QA and existing Sites deployment

**Files:**
- Modify: `prototypes/automation-guided-flow/design-qa.md`
- Generated build output only: `prototypes/automation-guided-flow/dist/**`

**Interfaces:**
- Consumes the three query-parameter variants from Task 2.
- Produces an updated version at the existing Sites URL.

- [ ] **Step 1: Verify all three local variants**

For each query parameter, launch sync and confirm the expected logging surface appears. Check that removed copy and controls are absent, `同步全部` is present, and the browser console has no fresh errors.

- [ ] **Step 2: Verify responsive layout**

At the existing narrow browser viewport, confirm no document-level horizontal overflow and that the active logging surface can be closed and reopened.

- [ ] **Step 3: Update design QA**

Record the simplified launch flow, three tested variants, interaction checks, browser-console result, and `final result: passed` in `design-qa.md`.

- [ ] **Step 4: Publish the validated source**

Push the exact source state to the existing Sites source repository, package the current `dist`, save version 2 with the pushed commit SHA, deploy it, poll to `succeeded`, and retain `workspace_all` access.

- [ ] **Step 5: Return three direct links**

Return the same deployed base URL with `?logging=drawer`, `?logging=inline`, and `?logging=console` so the user can compare without a new route or selector UI.
