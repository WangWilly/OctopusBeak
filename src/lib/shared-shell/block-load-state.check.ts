import assert from "node:assert/strict";
import test from "node:test";
import { loadIndependentBlocks, renderBlockContent } from "./block-load-state.ts";

test("a ready block passes its payload into the renderer", () => {
  const rendered = renderBlockContent(
    { status: "ready", data: { title: "summary payload" } },
    (data) => data.title,
  );
  assert.equal(rendered, "summary payload");
  assert.equal(renderBlockContent({ status: "loading" }, () => "should not render"), undefined);
});

test("a slow or failed block does not suppress a sibling block", async () => {
  let releaseChart!: (value: string) => void;
  const chart = new Promise<string>((resolve) => { releaseChart = resolve; });
  const settledKeys: string[] = [];
  const pending = loadIndependentBlocks({
    summary: async () => "summary-ready",
    chart: () => chart,
    list: async () => {
      throw new Error("list unavailable");
    },
  }, (key) => settledKeys.push(key));

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(settledKeys.sort(), ["list", "summary"]);

  const beforeChart = await Promise.race([
    pending.then((value) => value.chart),
    Promise.resolve("pending"),
  ]);
  assert.equal(beforeChart, "pending");
  releaseChart("chart-ready");

  const blocks = await pending;
  assert.deepEqual(blocks.summary, { status: "ready", data: "summary-ready" });
  assert.deepEqual(blocks.chart, { status: "ready", data: "chart-ready" });
  assert.deepEqual(blocks.list, { status: "error", message: "list unavailable" });
});
