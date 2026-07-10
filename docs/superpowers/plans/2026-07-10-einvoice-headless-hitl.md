# E-Invoice Headless CAPTCHA Assist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the personal e-invoice crawler headlessly while continuing to use the existing user-triggered Assist modal for CAPTCHA input and resume.

**Architecture:** Reuse the current Libretto pause, automation `waiting_for_human` state, persisted resume session, and CDP-backed Assist viewer without modification. Make the e-invoice task consistent with every other crawler by adding `--headless` to its command and protect that behavior with one focused assertion.

**Tech Stack:** TypeScript, Node.js assertion checks, Libretto, Playwright/CDP, Svelte/Electron

## Global Constraints

- The Assist modal remains user-triggered through the existing Assist button.
- Do not add a task-level headless abstraction, a second browser, or e-invoice-specific Assist UI.
- Do not change the existing e-invoice CAPTCHA pause or resume flow.
- Do not add dependencies.
- Do not expose stored credentials or CAPTCHA values in logs, tests, screenshots, or commits.

---

### Task 1: Run E-Invoice Headlessly Through Existing HITL Assist

**Files:**
- Modify: `src/lib/automation/server/automation-core.check.ts:40-41`
- Modify: `src/lib/automation/server/tasks.ts:255-265`
- Verify unchanged integration: `src/workflows/einvoice-personal-invoices.ts:300-331`
- Verify unchanged integration: `src/lib/automation/server/runner.ts:34-36`
- Verify unchanged integration: `src/lib/automation/server/human-session.ts:10-32`
- Verify unchanged integration: `src/lib/automation/server/automation-viewer.ts:141-162`
- Verify unchanged integration: `src/lib/automation/AutomationDashboard.svelte:511-514`

**Interfaces:**
- Consumes: `taskById(taskId: string): AutomationTask | null` and the existing `AutomationTask.command: readonly string[]` task definition.
- Produces: `taskById("einvoice-personal-invoices")?.command` equal to `["libretto", "run", "src/workflows/einvoice-personal-invoices.ts", "--headless"]`.
- Preserves: the workflow's existing `pause(session)` output, which the runner maps to `waiting_for_human` and the Assist APIs resolve to the same paused CDP page.

- [ ] **Step 1: Add the failing headless command assertion**

Add this assertion immediately after the existing e-invoice `kind` and `credentialGroupId` assertions in `src/lib/automation/server/automation-core.check.ts`:

```ts
assert.deepEqual(
  taskById("einvoice-personal-invoices")?.command,
  [
    "libretto",
    "run",
    "src/workflows/einvoice-personal-invoices.ts",
    "--headless",
  ],
);
```

- [ ] **Step 2: Run the focused check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
```

Expected: FAIL with an `AssertionError` showing that the actual e-invoice command is missing `--headless`.

- [ ] **Step 3: Add the minimal headless task argument**

Change only the e-invoice task command in `src/lib/automation/server/tasks.ts`:

```ts
command: [
  "libretto",
  "run",
  "src/workflows/einvoice-personal-invoices.ts",
  "--headless",
],
```

- [ ] **Step 4: Rerun the focused check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
```

Expected: exit code 0 with no assertion failure.

- [ ] **Step 5: Verify runner pause and resume parsing checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
```

Expected: exit code 0.

- [ ] **Step 6: Verify human-session lookup checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/human-session.check.ts
```

Expected: exit code 0.

- [ ] **Step 7: Verify Assist viewer interaction checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-viewer.check.ts
```

Expected: exit code 0.

- [ ] **Step 8: Verify TypeScript compilation**

Run:

```bash
npx tsc --noEmit
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 9: Check for an existing Electron CDP endpoint**

Run:

```bash
curl http://127.0.0.1:9222/json/version
```

Expected when the app is already running: JSON containing `webSocketDebuggerUrl`. Record the actual port if it differs from `9222`.

- [ ] **Step 10: Start Electron when the CDP endpoint is unavailable**

If Step 9 cannot connect, start and preserve a development session:

```bash
npm run desktop:dev
```

Expected: logs include `Electron remote debugging listening on port 9222` or another explicit port. Use the printed port for the remaining commands. If Step 9 succeeded, leave the existing app running and continue.

- [ ] **Step 11: Connect Libretto to the Electron renderer**

Run with the active Electron CDP port:

```bash
npx libretto connect http://127.0.0.1:9222 --session electron-cdp
```

Expected: Libretto reports a connected `electron-cdp` session.

- [ ] **Step 12: Navigate the Electron renderer to Automation**

Run:

```bash
npx libretto exec --session electron-cdp "await page.evaluate(() => { location.hash = '/automation'; })"
```

Expected: the renderer changes to the Automation route without a Libretto execution error.

- [ ] **Step 13: Inspect the Automation dashboard through CDP**

Run:

```bash
npx libretto snapshot --session electron-cdp
```

Expected: the snapshot identifies the Automation dashboard and includes the E-Invoice personal invoices row. Confirm from the current UI state that Assist remains conditional on `waiting_for_human` with a non-empty human session.

- [ ] **Step 14: Verify the live CAPTCHA handoff without exposing secrets**

When saved e-invoice credentials are available in the Electron app:

1. Select Run for E-Invoice personal invoices.
2. Confirm no native Playwright browser window appears.
3. Wait for the task status to become `waiting_for_human`.
4. Confirm the Assist button appears; open it.
5. Confirm the modal screenshot displays the paused e-invoice login page and CAPTCHA.
6. Click the CAPTCHA input in the screenshot and confirm the floating text input appears.
7. Enter the CAPTCHA through the floating input, select Resume, and confirm the task leaves `waiting_for_human` and continues.

Do not capture credentials or the CAPTCHA value in logs or committed artifacts. If saved credentials or a live CAPTCHA session are unavailable, record that automated checks and CDP inspection passed but do not claim live CAPTCHA completion.

- [ ] **Step 15: Close the disposable Libretto CDP session**

Run:

```bash
npx libretto close --session electron-cdp
```

Expected: Libretto removes the `electron-cdp` session without terminating the Electron development app.

- [ ] **Step 16: Review the final diff**

Run:

```bash
git diff --check
git diff -- src/lib/automation/server/automation-core.check.ts src/lib/automation/server/tasks.ts
```

Expected: no whitespace errors, one added assertion, and one added `--headless` task argument. No Assist, runner, viewer, workflow, or dependency changes.

- [ ] **Step 17: Commit the implementation**

```bash
git add src/lib/automation/server/automation-core.check.ts src/lib/automation/server/tasks.ts
git commit -m "feat: run e-invoice automation headlessly"
```
