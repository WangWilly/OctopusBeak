import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutomationProgressFrameParser } from "./task-run-execution.ts";

test("progress frames preserve UTF-8 params split across byte chunks", () => {
  const events: unknown[] = [];
  const parser = createAutomationProgressFrameParser((event) => events.push(event));
  const frame = Buffer.from(JSON.stringify({
    type: "progress",
    phaseCode: "collection",
    completed: 1,
    total: 1,
    percent: 100,
    params: { source: "元大銀行" },
  }) + "\n");
  const split = frame.indexOf(Buffer.from("元")) + 1;
  parser.push(frame.subarray(0, split));
  parser.push(frame.subarray(split));
  parser.flush();
  assert.equal((events[0] as { params: { source: string } }).params.source, "元大銀行");
});
