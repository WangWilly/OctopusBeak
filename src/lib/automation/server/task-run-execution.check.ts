import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  automationTaskChild,
  createAutomationProgressFrameParser,
  runAutomationTaskExecution,
} from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";

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

test("command-only tasks are rejected before persistence or execution", async () => {
  const baseTask = taskById("exchange-rates");
  assert.ok(baseTask);
  const task = {
    ...baseTask,
    id: "legacy-command-task",
    script: "run:legacy-command-task",
    command: ["node", "-e", "process.exit(42)"],
    workflowId: undefined,
  };
  let persistenceCalls = 0;
  const persistence = new Proxy({}, {
    get() {
      persistenceCalls += 1;
      return async () => undefined;
    },
  });

  await assert.rejects(
    () => runAutomationTaskExecution(
      task,
      persistence as never,
      {},
      async () => {},
    ),
    /App workflow definition is unavailable/,
  );
  assert.equal(persistenceCalls, 0);
});

test("Libretto session resumes are rejected by the App executor before persistence", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  let persistenceCalls = 0;
  const persistence = new Proxy({}, {
    get() {
      persistenceCalls += 1;
      return async () => undefined;
    },
  });

  await assert.rejects(
    () => runAutomationTaskExecution(
      task,
      persistence as never,
      { resumeSession: "legacy-session" },
      async () => {},
    ),
    /Libretto session resume is not supported/,
  );
  assert.equal(persistenceCalls, 0);
  assert.equal(automationTaskChild(task.id), undefined);
});

test("exchange-rate dispatch remains typed and stores no output-file path", async () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    const result = await runAutomationTaskExecution(
      task,
      provider.automation,
      {
        runExchangeRateSync: async ({ emitProgress }) => {
          emitProgress?.({
            phaseCode: "collection",
            completed: 1,
            total: 1,
            percent: 100,
          });
          return { status: "completed" };
        },
      },
      async (id) => { taskRunId = id; },
    );

    assert.equal(result.status, "completed");
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.logPath, "");
    assert.equal(run?.logTail, "");
    assert.ok(run?.events.some((event) => event.code === "progress-update"));
  } finally {
    await store.close();
  }
});

test("task execution module keeps only runner compatibility types, not process or file-log execution", async () => {
  const source = await readFile(new URL("./task-run-execution.ts", import.meta.url), "utf8");
  assert.match(source, /import type \{ ChildProcess \} from "node:child_process"/);
  assert.doesNotMatch(source, /import\s+\{[^}]*\b(?:spawn|spawnSync)\b[^}]*\}\s+from\s+"node:child_process"/);
  assert.doesNotMatch(source, /\bspawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(source, /\bexecuteAutomationTaskProcess\b/);
  assert.doesNotMatch(source, /\bresolveTaskCommand\b/);
  assert.doesNotMatch(source, /\bappendLog\s*\(/);
  assert.doesNotMatch(source, /\breadFileSync\s*\(/);
  assert.doesNotMatch(source, /\bmkdirSync\s*\(/);
  assert.doesNotMatch(source, /\brmSync\s*\(/);
});
