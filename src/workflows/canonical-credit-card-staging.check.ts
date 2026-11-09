import assert from "node:assert/strict";
import test from "node:test";
import type { CreditCardCurrentBalanceCaptureInput } from "../ledger/canonical/credit-card-current-balance-admission.ts";
import type { PGliteCanonicalCreditCardCaptureRequest } from "../ledger/pglite/credit-card.ts";
import type { PGliteWorkflowCommand } from "../ledger/pglite/workflow-client.ts";
import {
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { stageCanonicalCreditCards, type CurrentUsedCredit } from "./canonical-credit-card-staging.ts";
import { issuerAggregateMatching } from "./current-state-snapshot-capture.ts";

type Capture = Readonly<{ name: string }>;
type Row = Readonly<{ used: string; broken?: true }>;

function card(name: string) {
  const request = {
    capture: { captureId: `capture:${name}` },
    identity: { sourceAccountKey: `account:${name}` },
  } as unknown as PGliteCanonicalCreditCardCaptureRequest;
  return { capture: { name }, request };
}

const usedCredit = (rows: readonly Row[]): CurrentUsedCredit<Row, Capture> => ({
  rows,
  snapshot: {
    product: "current-balance",
    matching: issuerAggregateMatching("Synthetic current used credit"),
    build: (row, { capture }) => ({ row, capture }) as unknown as CreditCardCurrentBalanceCaptureInput,
    kind: {
      stage: (input, { capture, cardIdentity }) => {
        const { row } = input as unknown as { row: Row };
        if (row.broken) throw new Error("Synthetic used credit is broken.");
        return {
          itemKey: `${capture.name}:current-used-credit`,
          command: {
            kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
            request: { used: row.used, cardIdentity },
          } as unknown as PGliteWorkflowCommand,
        };
      },
    },
  },
});

function harness(signal = new AbortController().signal) {
  const log: string[] = [];
  const calls: (readonly ProductStageRequest[])[] = [];
  const event = async (stage: string, outcome: string, code: string) => {
    log.push(`${stage}:${outcome}:${code}`);
  };
  const product = productCollectionHandle({
    now: () => "2026-08-26T07:30:00.000Z",
    text: strictSourceText,
    signal,
    event,
    stage: (...requests) => {
      calls.push(requests);
      log.push(`stage:${requests.map((request) => request.product).join(",")}`);
    },
    reportActivity: async () => undefined,
    collectionPeriod: () => assert.fail("staging reads no collection period"),
  });
  return { product, log, calls };
}

test("cards and their current used credit stage in one call, bound to the first card", async () => {
  const { product, log, calls } = harness();
  await stageCanonicalCreditCards(product, [card("a"), card("b")], usedCredit([{ used: "46989" }]));
  assert.deepEqual(log, [
    "validation:started:current-balance-validation-started",
    "validation:completed:current-balance-validation-completed",
    "stage:credit-card,credit-card,current-balance",
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.map(({ product, itemKey, command }) => [product, itemKey, command]), [
    ["credit-card", "capture:a", { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request: card("a").request }],
    ["credit-card", "capture:b", { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request: card("b").request }],
    ["current-balance", "a:current-used-credit", {
      kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
      request: { used: "46989", cardIdentity: { sourceAccountKey: "account:a" } },
    }],
  ]);
});

test("cards without current used credit stage alone and report no current-balance events", async () => {
  const { product, log, calls } = harness();
  await stageCanonicalCreditCards(product, [card("a")]);
  assert.deepEqual(log, ["stage:credit-card"]);
  assert.equal(calls.length, 1);
});

test("a current used credit that fails validation stages no card", async () => {
  const { product, log, calls } = harness();
  await assert.rejects(
    stageCanonicalCreditCards(product, [card("a")], usedCredit([{ used: "1", broken: true }])),
    /Synthetic used credit is broken/u,
  );
  assert.deepEqual(log, [
    "validation:started:current-balance-validation-started",
    "validation:failed:source-validation-rejected",
  ]);
  assert.deepEqual(calls, []);
});

test("no cards stage nothing and leave the current used credit unvalidated", async () => {
  const { product, log, calls } = harness();
  await stageCanonicalCreditCards(product, [], usedCredit([{ used: "46989" }]));
  assert.deepEqual(log, []);
  assert.deepEqual(calls, []);
});

test("an abort after validation stages nothing", async () => {
  const controller = new AbortController();
  const { product, calls } = harness(controller.signal);
  const credit = usedCredit([{ used: "46989" }]);
  const abortingCredit: CurrentUsedCredit<Row, Capture> = {
    ...credit,
    snapshot: { ...credit.snapshot, validate: () => controller.abort(new Error("Synthetic abort.")) },
  };
  await assert.rejects(stageCanonicalCreditCards(product, [card("a")], abortingCredit), /Synthetic abort/u);
  assert.deepEqual(calls, []);
});
