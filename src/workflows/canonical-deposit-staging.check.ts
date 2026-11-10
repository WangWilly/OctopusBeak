import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalFinancialDepositCapture } from "../ledger/canonical/canonical-financial-deposit-admission.ts";
import type { CanonicalSourceEvidence } from "../ledger/canonical/canonical-source-evidence.ts";
import type { CurrentDepositBalanceCaptureInput } from "../ledger/pglite/current-deposit-admission.ts";
import type { PGliteWorkflowCommand } from "../ledger/pglite/workflow-client.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import {
  admitDeposit,
  stageCanonicalDeposits,
  type DepositAdmission,
  type DepositCurrentBalance,
} from "./canonical-deposit-staging.ts";
import type { CurrentStateSnapshotStaging } from "./current-state-snapshot-capture.ts";

type Balance = Readonly<{ account: string }>;
type Row = Readonly<{ account: string; amount: string; broken?: true }>;

const capture = (id: string) => ({ captureId: id }) as unknown as CanonicalFinancialDepositCapture;
const source = (id: string) => ({ captureId: id }) as unknown as CanonicalSourceEvidence;

const snapshot = (validate?: () => void): CurrentStateSnapshotStaging<Row, Balance> => ({
  product: "current-balance",
  matching: {
    captureKey: ({ account }) => account,
    rowKey: ({ account }) => account,
    duplicates: "first-wins",
    sameIdentity: () => true,
    ambiguousMessage: "Synthetic balances are ambiguous.",
    unmatched: { kind: "skip" },
  },
  build: (row, balance) => ({ row, balance }) as unknown as CurrentDepositBalanceCaptureInput,
  kind: {
    stage: (input) => {
      const { row } = input as unknown as { row: Row };
      if (row.broken) throw new Error("Synthetic balance is broken.");
      return {
        itemKey: `current-balance:${row.account}`,
        command: { kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND, request: row } as unknown as PGliteWorkflowCommand,
      };
    },
  },
  ...(validate ? { validate } : {}),
});

const rows = (...read: Row[]): DepositCurrentBalance<never, Row, Balance, "required"> => ({ snapshot: snapshot(), rows: read });

function harness(signal = new AbortController().signal) {
  const log: string[] = [];
  const calls: (readonly ProductStageRequest[])[] = [];
  const product = productCollectionHandle({
    now: () => "2026-08-26T07:30:00.000Z",
    text: strictSourceText,
    signal,
    event: async (stage, outcome, code) => {
      log.push(`${stage}:${outcome}:${code}`);
    },
    stage: (...requests) => {
      calls.push(requests);
      log.push(`stage:${requests.map((request) => request.itemKey).join(",")}`);
    },
    reportActivity: async () => undefined,
    collectionPeriod: () => assert.fail("staging reads no collection period"),
  });
  return { product, log, calls };
}

async function admissions(product: Parameters<typeof admitDeposit>[0]): Promise<DepositAdmission<Balance>[]> {
  const relationCommands = () => [{ kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND, request: {} }] as never;
  return [
    await admitDeposit(product, () => ({ product: "domestic-deposit", capture: capture("financial-a"), balance: { account: "a" }, relationCommands })),
    await admitDeposit(product, () => ({ product: "domestic-deposit", sourceOnly: source("source-b") })),
    await admitDeposit(product, () => ({
      product: "foreign-currency",
      capture: capture("financial-c"),
      balance: { account: "c" },
    })),
  ];
}

test("source-only items, then deposits, then balances stage in one call, each keyed by its capture id", async () => {
  const { product, log, calls } = harness();
  await stageCanonicalDeposits(product, await admissions(product), rows(
    { account: "a", amount: "100" },
    { account: "c", amount: "5" },
  ));
  assert.deepEqual(log, [
    "validation:started:current-balance-validation-started",
    "validation:completed:current-balance-validation-completed",
    "stage:source-b,financial-a,financial-c,current-balance:a,current-balance:c",
  ]);
  const [staged] = calls;
  assert.equal(calls.length, 1);
  assert.deepEqual(staged!.map(({ product, command }) => [product, command]), [
    ["domestic-deposit", { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: source("source-b") }],
    ["domestic-deposit", { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture: capture("financial-a") } }],
    ["foreign-currency", { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture: capture("financial-c") } }],
    ["current-balance", { kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND, request: { account: "a", amount: "100" } }],
    ["current-balance", { kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND, request: { account: "c", amount: "5" } }],
  ]);
  assert.equal(staged![1]!.relationCommands?.(null)[0]?.kind, PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND);
  assert.equal("relationCommands" in staged![2]!, false);
});

test("rows the snapshot excludes come back to the source and stage nothing", async () => {
  const { product, calls } = harness();
  const excluding = snapshot();
  const excluded = await stageCanonicalDeposits(
    product,
    [await admitDeposit<Balance>(product, () => ({ product: "domestic-deposit", capture: capture("financial-a"), balance: { account: "a" } }))],
    {
      snapshot: { ...excluding, matching: { ...excluding.matching, unmatched: { kind: "exclude" } } },
      rows: [{ account: "a", amount: "1" }, { account: "z", amount: "9" }],
    },
  );
  assert.deepEqual(excluded, [{ account: "z", amount: "9" }]);
  assert.deepEqual(calls[0]!.map(({ itemKey }) => itemKey), ["financial-a", "current-balance:a"]);
});

test("an admission that throws is reported as the product's validation failure", async () => {
  const { product, log, calls } = harness();
  await assert.rejects(
    admitDeposit(product, () => {
      throw new Error("Synthetic admission failed.");
    }),
    /Synthetic admission failed/u,
  );
  assert.deepEqual(log, ["validation:failed:source-validation-rejected"]);
  assert.deepEqual(calls, []);
});

test("a current balance that fails validation stages no deposit", async () => {
  const { product, log, calls } = harness();
  await assert.rejects(
    stageCanonicalDeposits(product, await admissions(product), rows({ account: "a", amount: "1", broken: true })),
    /Synthetic balance is broken/u,
  );
  assert.deepEqual(log, [
    "validation:started:current-balance-validation-started",
    "validation:failed:source-validation-rejected",
  ]);
  assert.deepEqual(calls, []);
});

test("source-only admissions stage alone and never acquire the current balances", async () => {
  const { product, log, calls } = harness();
  await stageCanonicalDeposits(
    product,
    [await admitDeposit(product, () => ({ product: "domestic-deposit", sourceOnly: source("source-b") }))],
    { snapshot: snapshot() as never, acquire: () => assert.fail("no admitted deposit reads the current balances") },
  );
  assert.deepEqual(log, ["stage:source-b"]);
  assert.equal(calls.length, 1);
});

test("a deposit with no balance capture stages without acquiring the current balances", async () => {
  const { product, log } = harness();
  await stageCanonicalDeposits(
    product,
    [await admitDeposit<Balance>(product, () => ({ product: "foreign-currency", capture: capture("financial-f") }))],
    { snapshot: snapshot() as never, acquire: () => assert.fail("a deposit without a balance capture reads no current balances") },
  );
  assert.deepEqual(log, ["stage:financial-f"]);
});

test("no admissions stage nothing", async () => {
  const { product, log, calls } = harness();
  await stageCanonicalDeposits(product, [], rows({ account: "a", amount: "1" }));
  assert.deepEqual(log, []);
  assert.deepEqual(calls, []);
});

test("an abort after the current balances validate stages nothing", async () => {
  const controller = new AbortController();
  const { product, calls } = harness(controller.signal);
  const admitted = await admissions(product);
  await assert.rejects(
    stageCanonicalDeposits(product, admitted, {
      snapshot: snapshot(() => controller.abort(new Error("Synthetic abort."))),
      rows: [{ account: "a", amount: "1" }],
    }),
    /Synthetic abort/u,
  );
  assert.deepEqual(calls, []);
});
