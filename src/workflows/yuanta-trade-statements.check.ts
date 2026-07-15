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
