# Automation Timezone Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace misleading `UTC` automation labels with labels that reactively name the configured IANA system timezone.

**Architecture:** Keep UTC storage, structured logs, and the scheduled CLI argument unchanged. Move complete timezone-aware display strings into the existing translation object and have `AutomationDashboard.svelte` call them with the existing shared `systemTimezone` store value.

**Tech Stack:** Svelte 5, TypeScript, Node test/check scripts, Electron CDP

## Global Constraints

- Stored timestamps and structured logs remain UTC.
- Internal APIs, formatter names, and the raw `--scheduled-at-utc` command argument remain unchanged.
- Human-facing Automation timestamp labels must not say `UTC`.
- No dependency or friendly-name timezone mapping is added.

---

### Task 1: Render Automation labels with the configured timezone

**Files:**
- Modify: `src/lib/i18n/i18n.check.ts`
- Modify: `src/lib/i18n/i18n.ts`
- Modify: `src/lib/automation/AutomationDashboard.svelte`

**Interfaces:**
- Consumes: `systemTimezone`, a Svelte store containing the configured IANA timezone string.
- Produces: `translations.<locale>.automation.latestTime(timezone)`, `historyStartedTime(timezone)`, and `historyFinishedTime(timezone)`, each returning a complete localized label.

- [ ] **Step 1: Write the failing translation check**

Append these assertions before the key-parity assertion in `src/lib/i18n/i18n.check.ts`:

```ts
assert.equal(translations.en.automation.latestTime("Asia/Taipei"), "Latest (Asia/Taipei)");
assert.equal(translations.en.automation.historyStartedTime("Asia/Taipei"), "Started (Asia/Taipei)");
assert.equal(translations.en.automation.historyFinishedTime("Asia/Taipei"), "Finished (Asia/Taipei)");
assert.equal(translations["zh-TW"].automation.latestTime("Asia/Taipei"), "最新（Asia/Taipei）");
assert.equal(translations["zh-TW"].automation.historyStartedTime("Asia/Taipei"), "開始（Asia/Taipei）");
assert.equal(translations["zh-TW"].automation.historyFinishedTime("Asia/Taipei"), "完成（Asia/Taipei）");
```

- [ ] **Step 2: Run the focused check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
```

Expected: FAIL because `latestTime`, `historyStartedTime`, and `historyFinishedTime` do not exist.

- [ ] **Step 3: Implement the localized label functions**

Replace the three `*Utc` strings in each locale's `automation` translations:

```ts
// English
latestTime: (timezone: string) => `Latest (${timezone})`,
historyStartedTime: (timezone: string) => `Started (${timezone})`,
historyFinishedTime: (timezone: string) => `Finished (${timezone})`,

// Traditional Chinese
latestTime: (timezone: string) => `最新（${timezone}）`,
historyStartedTime: (timezone: string) => `開始（${timezone}）`,
historyFinishedTime: (timezone: string) => `完成（${timezone}）`,
```

Update the three display sites in `AutomationDashboard.svelte`:

```svelte
<span>{$t.automation.latestTime($systemTimezone)}: {latestTaskTime(task)}</span>
<th>{$t.automation.historyStartedTime($systemTimezone)}</th>
<th>{$t.automation.historyFinishedTime($systemTimezone)}</th>
```

- [ ] **Step 4: Run focused and regression checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
npm run typecheck
npm test
```

Expected: all commands PASS; the full suite reports 131 tests passed.

- [ ] **Step 5: Verify the live Electron UI through CDP**

With the existing development app on port 9222, run:

```bash
curl --silent --show-error http://127.0.0.1:9222/json/list
npx libretto connect http://127.0.0.1:9222 --session electron-timezone-labels
npx libretto snapshot --session electron-timezone-labels
```

Navigate to Automation if necessary and open Run history. Confirm the task-row label and both history headings contain the configured IANA timezone and no human-facing `UTC`. Close the Libretto inspection session afterward.

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/i18n.check.ts src/lib/i18n/i18n.ts src/lib/automation/AutomationDashboard.svelte
git commit -m "fix: label automation times with system timezone"
```
