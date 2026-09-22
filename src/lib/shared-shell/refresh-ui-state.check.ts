import assert from "node:assert/strict";
import test from "node:test";
import {
  beginRefresh,
  markRefreshInvalidated,
  settleRefresh,
} from "./refresh-ui-state.ts";
import { initialRefreshUiState } from "./refresh-context.ts";

test("invalidation during a refresh latches stale until the round settles", () => {
  const refreshing = beginRefresh(initialRefreshUiState);
  const invalidated = markRefreshInvalidated(refreshing, {
    version: 8,
    reason: "automation-completed",
    changedAt: "2026-09-19T00:00:08.000Z",
  });

  assert.equal(invalidated.status, "refreshing");
  assert.equal(invalidated.staleDuringRefresh, true);

  const settled = settleRefresh(invalidated, {
    status: "complete",
    snapshot: { version: 7, stale: true, changedAt: "2026-09-19T00:00:07.000Z" },
    successful: ["overview"],
    failed: [],
    values: { overview: {} },
    errors: [],
    acknowledged: false,
  });

  assert.deepEqual(settled, {
    status: "stale",
    version: 8,
    changedAt: "2026-09-19T00:00:08.000Z",
    failed: [],
    staleDuringRefresh: false,
  });
});

test("a refreshed latest version clears an invalidation received during the click", () => {
  const invalidated = markRefreshInvalidated(beginRefresh(initialRefreshUiState), {
    version: 8,
    reason: "automation-completed",
    changedAt: "2026-09-19T00:00:08.000Z",
  });

  const settled = settleRefresh(invalidated, {
    status: "complete",
    snapshot: { version: 8, stale: true, changedAt: "2026-09-19T00:00:08.000Z" },
    successful: ["overview"],
    failed: [],
    values: { overview: {} },
    errors: [],
    acknowledged: true,
  });

  assert.equal(settled.status, "current");
  assert.equal(settled.version, 8);
});
