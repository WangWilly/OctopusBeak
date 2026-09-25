import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type { WorkflowBrowserPort, WorkflowFinancialCommitPort } from "../workflow-executor.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(".js")) return nextResolve(specifier, context);
    const typescriptSpecifier = `${specifier.slice(0, -3)}.ts`;
    try {
      return nextResolve(typescriptSpecifier, context);
    } catch {
      return nextResolve(specifier, context);
    }
  },
});

const [{ taskById }, { runAutomationTaskExecution }, {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowStartUrlForTask,
}] = await Promise.all([
  import("./tasks.ts"),
  import("./task-run-execution.ts"),
  import("./app-workflow-registry.ts"),
]);

const LOGIN_URL = "https://www.cathaybk.com.tw/MyBank/";
const credentialKey = (suffix: string) => ["LIBRETTO", "CLOUD", "CATHAY", suffix].join("_");
const syntheticEnvironment = () => ({
  [credentialKey("USER_ID")]: "synthetic-user-id",
  [credentialKey("ACCOUNT")]: "synthetic-account",
  [credentialKey("PASSWORD")]: "synthetic-password",
  LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES: "domestic,foreign_currency",
});

test("Cathay task dispatch resolves the typed App registration and preserves selected types", async () => {
  const task = taskById("cathay-all-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "cathay-all-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  const definition = workflowDefinitionForTask(task.workflowId);
  assert.equal(definition?.id, "cathay-all-statements");
  assert.equal(definition?.requiresFinancialCommit, true);
  assert.equal(workflowStartUrlForTask(task.workflowId), LOGIN_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      cathay_user_id: "synthetic-user-id",
      cathay_account: "synthetic-account",
      cathay_password: "synthetic-password",
    },
    statementTypes: ["domestic", "foreign_currency"],
  });

  const root = await mkdtemp(join(tmpdir(), "cathay-app-workflow-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  let observedStartUrl: string | undefined;
  let browserDispatches = 0;
  let commitCalls = 0;
  const browser: WorkflowBrowserPort = {
    async withPage() {
      browserDispatches += 1;
      throw new Error("fixture App browser host reached");
    },
  };
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute() {
      commitCalls += 1;
      throw new Error("source collection should precede commit");
    },
  };
  try {
    process.chdir(root);
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: task.id,
      kind: task.kind,
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const result = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: created.taskRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: ({ startUrl }) => {
        observedStartUrl = startUrl;
        return browser;
      },
    }, async () => {});
    const run = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(result.status, "failed", "the sentinel stops before provider source collection");
    assert.equal(observedStartUrl, LOGIN_URL);
    assert.equal(browserDispatches, 1, "the App executor entered the typed browser port");
    assert.equal(commitCalls, 0);
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.deepEqual(await readdir(root), [], "typed App dispatch creates no statement or log files");
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
