# YuanTa Password Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the YuanTa securities trade workflow continue when an authenticated login intermittently opens the optional password-change reminder.

**Architecture:** Add one optional Playwright post-login step that clicks the exact `暫不變更` button when visible, then reuse the existing navigation settling and disclaimer handlers. Keep authentication readiness, credentials, report parsing, and session lifecycle unchanged.

**Tech Stack:** TypeScript, Node test runner, Playwright locators, Libretto workflow runtime.

## Global Constraints

- Only `src/workflows/yuanta-trade-statements.ts` and its focused check may change.
- Do not change credentials, other YuanTa workflows, App session lifecycle, or report parsing.
- Do not add dependencies, retries, URL whitelists, or a Libretto patch.
- Absence of `暫不變更` is optional; click or navigation failures must propagate.
- Validation must use a fresh headed Libretto session and close it afterward.

---

### Task 1: Dismiss the optional password-change reminder

**Files:**
- Create: `src/workflows/yuanta-trade-statements.check.ts`
- Modify: `src/workflows/yuanta-trade-statements.ts:539-625`

**Interfaces:**
- Consumes: Playwright `Page.getByRole()`, the existing `settleAfterNavigation(page)` helper, and the existing sign-in callback.
- Produces: `dismissPasswordChangeReminderIfPresent(page: Page): Promise<void>`.

- [ ] **Step 1: Write the failing regression check**

Create `src/workflows/yuanta-trade-statements.check.ts` with one test covering both states:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { dismissPasswordChangeReminderIfPresent } from "./yuanta-trade-statements.ts";

function fakePage(reminderVisible: boolean) {
  let clicks = 0;
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "暫不變更", exact: true });
      return {
        async isVisible() {
          return reminderVisible;
        },
        async click() {
          clicks += 1;
        },
      };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  } as unknown as Page;

  return { page, clicks: () => clicks };
}

test("dismisses only a visible YuanTa password reminder", async () => {
  const visible = fakePage(true);
  await dismissPasswordChangeReminderIfPresent(visible.page);
  assert.equal(visible.clicks(), 1);

  const absent = fakePage(false);
  await dismissPasswordChangeReminderIfPresent(absent.page);
  assert.equal(absent.clicks(), 0);
});
```

- [ ] **Step 2: Run the check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/workflows/yuanta-trade-statements.check.ts
```

Expected: FAIL because `dismissPasswordChangeReminderIfPresent` is not exported.

- [ ] **Step 3: Implement the smallest production change**

Add immediately after `settleAfterNavigation()`:

```ts
export async function dismissPasswordChangeReminderIfPresent(
  page: Page,
): Promise<void> {
  const postpone = page.getByRole("button", {
    name: "暫不變更",
    exact: true,
  });
  if (!(await postpone.isVisible({ timeout: 2_000 }).catch(() => false))) return;

  await postpone.click();
  await settleAfterNavigation(page);
}
```

In the existing `signIn` callback, call it after `completeCertificateIfPresent(...)` and before `dismissPersonalMessageIfPresent(authPage)`:

```ts
await dismissPasswordChangeReminderIfPresent(authPage);
await dismissPersonalMessageIfPresent(authPage);
await acceptDisclaimerIfPresent(authPage);
```

- [ ] **Step 4: Run targeted and project checks**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/workflows/yuanta-trade-statements.check.ts
npm run typecheck
npm test
```

Expected: the focused check passes, typecheck reports 0 errors and 0 warnings, and the full suite has 0 failures.

- [ ] **Step 5: Commit the fix**

```bash
git add src/workflows/yuanta-trade-statements.ts src/workflows/yuanta-trade-statements.check.ts
git commit -m "fix: dismiss yuanta password reminder"
```

---

### Task 2: Validate the real YuanTa flow with Libretto

**Files:**
- Verify: `src/workflows/yuanta-trade-statements.ts`
- Temporary output: `/tmp/octopusbeak-yuanta-trade-validation`

**Interfaces:**
- Consumes: the corrected `yuantaTradeStatements` workflow and the user's manual CAPTCHA completion.
- Produces: a successful Libretto workflow result with `holdingPageCount: 1` and no retained validation browser.

- [ ] **Step 1: Start a clean headed validation run**

Run:

```bash
npx libretto run src/workflows/yuanta-trade-statements.ts \
  --session validate-yuanta-password-reminder \
  --headed \
  --stay-open-on-success \
  --params '{"includeHoldings":true,"includeTrades":false,"holdingTypes":["Stock"],"outputDir":"/tmp/octopusbeak-yuanta-trade-validation"}'
```

Expected: the workflow pauses at CAPTCHA and prints the exact resume command.

- [ ] **Step 2: Resume after the user completes CAPTCHA**

Run:

```bash
npx libretto resume --session validate-yuanta-password-reminder
```

Expected: when the password reminder appears, the workflow clicks `暫不變更`, accepts the existing AssetReport disclaimer, reaches progress 100, and returns a result with `holdingPageCount: 1`.

- [ ] **Step 3: Inspect the successful page and output**

Run:

```bash
npx libretto snapshot --session validate-yuanta-password-reminder
```

Confirm the page is under `/NexusWebTrade/AssetReport/`, `#btnLogout` is present, and the returned metadata describes the Stock holdings capture. Do not print account numbers or row contents.

- [ ] **Step 4: Close the validation session**

Run:

```bash
npx libretto close --session validate-yuanta-password-reminder
```

Expected: `Browser closed (session: validate-yuanta-password-reminder).`

- [ ] **Step 5: Record validation without committing temporary data**

Run `git status --short` and confirm only the pre-existing untracked exchange-rate plan remains. Do not add `/tmp/octopusbeak-yuanta-trade-validation` or any captured financial data to git.
