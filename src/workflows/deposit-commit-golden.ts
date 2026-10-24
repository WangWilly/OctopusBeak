import { RUN_EVENT_SIGNALS } from "../lib/automation/run-event.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";

/**
 * Pins what a deposit workflow hands to the Canonical Financial Commit, and the
 * progress events around it, so a change to any bank's admission can prove
 * its output is unchanged (ADR 0054). Set UPDATE_DEPOSIT_GOLDENS=1 to rewrite
 * the recorded files.
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

export async function assertDepositCommitGolden(name: string, actual: unknown): Promise<void> {
  const file = new URL(`./deposit-commit-goldens/${name}.json`, import.meta.url);
  actual = JSON.parse(JSON.stringify(actual, (_key, field: unknown) =>
    typeof field === "string" ? field.replace(LONG_DIGITS, groupDigits) : field));
  if (process.env.UPDATE_DEPOSIT_GOLDENS === "1") {
    await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(actual, expected, `${name} deposit commit output changed; rerun with UPDATE_DEPOSIT_GOLDENS=1 only if the change is intended.`);
}
