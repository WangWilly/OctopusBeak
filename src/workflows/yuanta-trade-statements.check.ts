import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  dismissPasswordChangeReminderIfPresent,
  fillTradeLoginForm,
} from "./yuanta-trade-statements.ts";

function fakePage(reminderVisible: boolean | Error) {
  let clicks = 0;
  let settles = 0;
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "暫不變更", exact: true });
      return {
        async isVisible() {
          if (reminderVisible instanceof Error) throw reminderVisible;
          return reminderVisible;
        },
        async click() {
          clicks += 1;
        },
      };
    },
    async waitForLoadState() {
      settles += 1;
    },
    async waitForTimeout() {
      settles += 1;
    },
  } as unknown as Page;

  return { page, clicks: () => clicks, settles: () => settles };
}

test("dismisses only a visible YuanTa password reminder", async () => {
  const visible = fakePage(true);
  await dismissPasswordChangeReminderIfPresent(visible.page);
  assert.equal(visible.clicks(), 1);
  assert.equal(visible.settles(), 3);

  const absent = fakePage(false);
  await dismissPasswordChangeReminderIfPresent(absent.page);
  assert.equal(absent.clicks(), 0);
  assert.equal(absent.settles(), 0);
});

test("propagates errors while checking the YuanTa password reminder", async () => {
  const closed = fakePage(new Error("page closed"));
  await assert.rejects(
    dismissPasswordChangeReminderIfPresent(closed.page),
    /page closed/,
  );
});

test("ignores navigation races while checking the YuanTa password reminder", async () => {
  const navigating = fakePage(
    new Error(
      "page.evaluate: Execution context was destroyed, most likely because of a navigation",
    ),
  );
  await dismissPasswordChangeReminderIfPresent(navigating.page);
  assert.equal(navigating.clicks(), 0);
});

test("removes focus from the YuanTa password field after filling credentials", async () => {
  const actions: string[] = [];
  const page = {
    goto: async () => actions.push("goto"),
    locator: (selector: string) => ({
      fill: async (value: string) => actions.push(`fill:${selector}:${value}`),
      blur: async () => actions.push(`blur:${selector}`),
    }),
  } as unknown as Page;

  await fillTradeLoginForm(page, {
    yuanta_trade_user_id: "user",
    yuanta_trade_password: "password",
  });

  assert.deepEqual(actions, [
    "goto",
    "fill:#loginid:user",
    "fill:#loginPWD:password",
    "blur:#loginPWD",
  ]);
});
