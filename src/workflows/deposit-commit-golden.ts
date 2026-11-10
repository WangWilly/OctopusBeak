import { RUN_EVENT_SIGNALS } from "../lib/automation/run-event.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";

/**
 * Pins what a deposit, credit-card or loan workflow hands to the Canonical
 * Financial Commit, and the progress events around it, so a change to any
 * bank's admission can prove its output is unchanged (ADR 0054). Set
 * UPDATE_DEPOSIT_GOLDENS=1, UPDATE_CREDIT_CARD_GOLDENS=1 or
 * UPDATE_LOAN_GOLDENS=1 to rewrite the recorded files.
 */
export type DepositCommitRecorder = Readonly<{
  financialCommit: WorkflowFinancialCommitPort;
  event: WorkflowContext["event"];
  signalEvent: WorkflowContext["signalEvent"];
  recorded(): Record<string, unknown>;
}>;

export function recordDepositCommit(): DepositCommitRecorder {
  const executions: unknown[] = [];
  const events: unknown[] = [];
  return {
    financialCommit: {
      async execute(items, options) {
        const received: PGliteWorkflowRunItem[] = [];
        for await (const item of items) received.push(item);
        executions.push({ options: { provider: options?.provider, product: options?.product }, items: received });
        return {
          status: "completed",
          items: received.map((item) => ({
            itemKey: item.itemKey,
            provider: item.provider,
            product: item.product,
            status: "committed" as const,
            admissionSummaries: [],
            value: null,
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: received.length,
          failedCount: 0,
        };
      },
    },
    async event(stage, outcome, code, counts) {
      events.push(counts === undefined ? { stage, outcome, code } : { stage, outcome, code, counts });
    },
    async signalEvent(signal) {
      events.push({ ...RUN_EVENT_SIGNALS[signal], code: signal, signal });
    },
    recorded: () => normalize({ executions, events }),
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
// The pre-commit privacy check rejects 10-19 digit runs beside account words,
// so recorded account numbers are split into groups of four.
const LONG_DIGITS = /\b\d{10,19}\b/gu;
const groupDigits = (digits: string): string => digits.match(/\d{1,4}/gu)!.join("_");

function normalize(value: unknown): Record<string, unknown> {
  const ids = new Map<string, string>();
  const json = JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field === "function") return "[function]";
    if (typeof field === "bigint") return `${field}n`;
    if (field instanceof Uint8Array) return `[bytes:${field.byteLength}]`;
    return field;
  });
  return JSON.parse(json.replace(UUID, (id) => {
    if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
    return ids.get(id)!;
  }));
}

const GOLDENS = {
  deposit: { directory: "deposit-commit-goldens", update: "UPDATE_DEPOSIT_GOLDENS" },
  "credit-card": { directory: "credit-card-commit-goldens", update: "UPDATE_CREDIT_CARD_GOLDENS" },
  loan: { directory: "loan-commit-goldens", update: "UPDATE_LOAN_GOLDENS" },
} as const;

async function assertCommitGolden(kind: keyof typeof GOLDENS, name: string, actual: unknown): Promise<void> {
  const { directory, update } = GOLDENS[kind];
  const file = new URL(`./${directory}/${name}.json`, import.meta.url);
  actual = JSON.parse(JSON.stringify(actual, (_key, field: unknown) =>
    typeof field === "string" ? field.replace(LONG_DIGITS, groupDigits) : field));
  if (process.env[update] === "1") {
    await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(actual, expected, `${name} ${kind} commit output changed; rerun with ${update}=1 only if the change is intended.`);
}

export function assertDepositCommitGolden(name: string, actual: unknown): Promise<void> {
  return assertCommitGolden("deposit", name, actual);
}

export function assertCreditCardCommitGolden(name: string, actual: unknown): Promise<void> {
  return assertCommitGolden("credit-card", name, actual);
}

export function assertLoanCommitGolden(name: string, actual: unknown): Promise<void> {
  return assertCommitGolden("loan", name, actual);
}

/**
 * Runs with counted UUIDs in place of random ones. A capture that hashes its
 * random capture id into page digests or occurrence keys is out of reach of
 * the recorder's UUID normalization, so the ids themselves are fixed.
 */
export async function withCountedUuids<T>(run: () => Promise<T>): Promise<T> {
  let next = 0;
  const randomUUID = mock.method(crypto, "randomUUID", () => {
    next += 1;
    return `00000000-0000-4000-8000-${next.toString(16).padStart(12, "0")}`;
  });
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    randomUUID.mock.restore();
    syncBuiltinESMExports();
  }
}
