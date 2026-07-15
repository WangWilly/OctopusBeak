import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { dismissPasswordChangeReminderIfPresent } from "./yuanta-trade-statements.ts";

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
