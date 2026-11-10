import assert from "node:assert/strict";
import test from "node:test";
import type { LoanCaptureInput } from "../ledger/canonical/loan-financial-contracts.ts";
import {
  PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { admitLoan, stageCanonicalLoans, type LoanDecision } from "./canonical-loan-staging.ts";

function capture(name: string): LoanCaptureInput {
  return {
    captureId: `capture:${name}`,
    observedAt: "2026-08-26T07:30:00.000Z",
    identity: { sourceConnectionKey: "capture-connection", identityEpochKey: `epoch:${name}`, accountKey: `account:${name}` },
    scope: { startDate: "2026-07-01", endDate: "2026-07-31" },
  } as unknown as LoanCaptureInput;
}

function decision(name: string, mandate = true): LoanDecision {
  return {
    capture: capture(name),
    sourceConnectionKey: "run-connection",
    integrationNamespace: "synthetic",
    ...(mandate
      ? {
          repaymentMandate: {
            accountValue: "01234567890123",
            sourceRecordKey: `record:${name}`,
            sourceField: "selector",
            contractVersion: "synthetic/mandate/v1",
          },
        }
      : {}),
  };
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

test("loans stage in admission order in one call, keyed by capture id, with the mandate bound to each capture", async () => {
  const { product, calls } = harness();
  stageCanonicalLoans(product, [await admitLoan(product, () => decision("a")), await admitLoan(product, () => decision("b", false))]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.map(({ product, itemKey, command }) => [product, itemKey, command]), [
    ["loan", "capture:a", { kind: PGLITE_CANONICAL_LOAN_COMMIT_COMMAND, request: { capture: capture("a") } }],
    ["loan", "capture:b", { kind: PGLITE_CANONICAL_LOAN_COMMIT_COMMAND, request: { capture: capture("b") } }],
  ]);
  assert.deepEqual(calls[0]![0]!.relationCommands!(null), [{
    kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
    request: {
      sourceConnectionKey: "run-connection",
      integrationNamespace: "synthetic",
      observedAt: "2026-08-26T07:30:00.000Z",
      counterpartyEvidence: [{
        captureId: "capture:a",
        sourceRecordKey: "record:a",
        sourceConnectionKey: "capture-connection",
        identityEpochKey: "epoch:a",
        accountValue: "01234567890123",
        role: "beneficiary",
        purpose: "loan_repayment",
        scope: "loan_contract",
        evidenceKind: "repayment-mandate",
        sourceField: "selector",
        contractVersion: "synthetic/mandate/v1",
        effectiveStartDate: "2026-07-01",
        effectiveEndDate: "2026-07-31",
        accountKey: "account:a",
      }],
    },
  }]);
  assert.deepEqual(
    calls[0]![1]!.relationCommands!(null),
    [{
      kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
      request: { sourceConnectionKey: "run-connection", integrationNamespace: "synthetic", observedAt: "2026-08-26T07:30:00.000Z", counterpartyEvidence: [] },
    }],
    "a loan without a proven repayment account still resolves, with no evidence",
  );
});

test("a thrown admission is reported as a validation rejection", async () => {
  const { product, log } = harness();
  await assert.rejects(admitLoan(product, () => { throw new Error("broken loan"); }), /broken loan/u);
  assert.deepEqual(log, ["validation:failed:source-validation-rejected"]);
});

test("a cancelled run stages nothing", async () => {
  const controller = new AbortController();
  const { product, calls } = harness(controller.signal);
  const admission = await admitLoan(product, () => decision("a"));
  controller.abort(new Error("cancelled"));
  assert.throws(() => stageCanonicalLoans(product, [admission]), /cancelled/u);
  assert.deepEqual(calls, []);
});
