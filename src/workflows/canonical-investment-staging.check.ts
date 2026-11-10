import assert from "node:assert/strict";
import test from "node:test";
import type { InvestmentCaptureInput } from "../ledger/canonical/investment-financial-admission.ts";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { admitInvestments, stageCanonicalInvestments } from "./canonical-investment-staging.ts";

function capture(name: string): InvestmentCaptureInput {
  return {
    captureId: `capture:${name}`,
    observedAt: `2026-08-26T07:30:0${name.length}.000Z`,
    identity: { sourceConnectionKey: `connection:${name}` },
  } as unknown as InvestmentCaptureInput;
}

function harness(signal = new AbortController().signal) {
  const log: string[] = [];
  const calls: (readonly ProductStageRequest[])[] = [];
  const product = productCollectionHandle({
    now: () => "2026-08-26T07:30:00.000Z",
    text: strictSourceText,
    signal,
    event: async (stage, outcome, code) => { log.push(`${stage}:${outcome}:${code}`); },
    stage: (...requests) => { calls.push(requests); },
    reportActivity: async () => undefined,
    collectionPeriod: () => assert.fail("staging reads no collection period"),
  });
  return { product, log, calls };
}

test("investment captures stage in admission order in one call, each resolving its own connection", async () => {
  const { product, calls } = harness();
  const admission = await admitInvestments(product, () => ({ captures: [capture("a"), capture("bb")], rowCount: 3 }));
  assert.equal(admission.rowCount, 3, "the source's own counts come back with the admission");
  stageCanonicalInvestments(product, admission);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.map(({ product, itemKey, command, relationCommands }) => [product, itemKey, command, relationCommands!(null)]), [
    ["investment", "capture:a", { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture: capture("a") } }, [{
      kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
      request: { sourceConnectionKey: "connection:a", observedAt: "2026-08-26T07:30:01.000Z" },
    }]],
    ["investment", "capture:bb", { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture: capture("bb") } }, [{
      kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
      request: { sourceConnectionKey: "connection:bb", observedAt: "2026-08-26T07:30:02.000Z" },
    }]],
  ]);
});

test("a thrown admission is reported as a validation rejection", async () => {
  const { product, log } = harness();
  await assert.rejects(admitInvestments(product, () => { throw new Error("broken investment"); }), /broken investment/u);
  assert.deepEqual(log, ["validation:failed:source-validation-rejected"]);
});

test("a cancelled run stages nothing", async () => {
  const controller = new AbortController();
  const { product, calls } = harness(controller.signal);
  const admission = await admitInvestments(product, () => ({ captures: [capture("a")] }));
  controller.abort(new Error("cancelled"));
  assert.throws(() => stageCanonicalInvestments(product, admission), /cancelled/u);
  assert.deepEqual(calls, []);
});
