import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialFreshnessBroadcaster,
  latestKnowledgePointFromDatabase,
  type FinancialFreshnessEvent,
} from "./financial-freshness.ts";

test("financial freshness broadcasts each newer commit to every live window", () => {
  const sent: Array<{ window: string; event: FinancialFreshnessEvent }> = [];
  const windows = [
    {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, event: FinancialFreshnessEvent) => {
          sent.push({ window: "first", event });
        },
      },
    },
    {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, event: FinancialFreshnessEvent) => {
          sent.push({ window: "second", event });
        },
      },
    },
  ];
  const broadcaster = createFinancialFreshnessBroadcaster({
    getWindows: () => windows,
  });

  assert.equal(broadcaster.publish({ commitSequence: 4 }), true);
  assert.equal(broadcaster.publish({ commitSequence: 4 }), false);
  assert.equal(broadcaster.publish({ commitSequence: 3 }), false);
  assert.equal(broadcaster.publish({ commitSequence: 7 }), true);
  assert.equal(broadcaster.latestKnowledgePoint(), 7);
  assert.deepEqual(
    sent.map(({ window, event }) => [window, event]),
    [
      ["first", { knowledgePoint: 4 }],
      ["second", { knowledgePoint: 4 }],
      ["first", { knowledgePoint: 7 }],
      ["second", { knowledgePoint: 7 }],
    ],
  );
  assert.deepEqual(Object.keys(sent[0]!.event), ["knowledgePoint"]);
});

test("financial freshness ignores destroyed windows and sanitizes delivery failures", () => {
  const warnings: string[] = [];
  let failedSends = 0;
  const broadcaster = createFinancialFreshnessBroadcaster({
    getWindows: () => [
      {
        isDestroyed: () => true,
        webContents: { send: () => assert.fail("destroyed window was sent to") },
      },
      {
        isDestroyed: () => false,
        webContents: {
          send: () => {
            failedSends += 1;
            throw new Error("contains a physical detail");
          },
        },
      },
    ],
    warn: (message) => warnings.push(message),
  });

  assert.equal(broadcaster.publish({ commitSequence: 8 }), true);
  assert.equal(failedSends, 1);
  assert.deepEqual(warnings, ["financial-freshness-delivery-failed"]);
  assert.equal(broadcaster.latestKnowledgePoint(), 8);
});

test("latest knowledge point lookup returns only the canonical commit sequence", () => {
  assert.equal(
    latestKnowledgePointFromDatabase({
      prepare: (sql) => {
        assert.match(sql, /MAX\(commit_sequence\)/);
        return { get: () => ({ value: 12 }) };
      },
    }),
    12,
  );
  assert.equal(
    latestKnowledgePointFromDatabase({
      prepare: () => ({ get: () => ({ value: null }) }),
    }),
    0,
  );
  assert.throws(
    () => latestKnowledgePointFromDatabase({
      prepare: () => ({ get: () => ({ value: -1 }) }),
    }),
    /knowledge point is invalid/i,
  );
});
