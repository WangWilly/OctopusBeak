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
import { FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./config-files.ts";

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

const LOGIN_URL = "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const credentialKey = (suffix: string) => ["LIBRETTO", "CLOUD", "FUBON", suffix].join("_");
const syntheticEnvironment = () => ({
  [credentialKey("USER_ID")]: "synthetic-user-id",
  [credentialKey("ACCOUNT")]: "synthetic-account",
  [credentialKey("PASSWORD")]: "synthetic-password",
  [FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: "synthetic-fubon-managed-secret",
});

test("Fubon task dispatch uses the App-owned typed workflow and maps its sign-in details", async () => {
  const task = taskById("fubon-all-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "fubon-all-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.equal(workflowDefinitionForTask(task.workflowId)?.id, "fubon-all-statements");
  assert.equal(workflowDefinitionForTask(task.workflowId)?.requiresFinancialCommit, true);
  assert.equal(workflowStartUrlForTask(task.workflowId), LOGIN_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    managedIdentitySecret: "synthetic-fubon-managed-secret",
    credentials: {
      fubon_user_id: "synthetic-user-id",
      fubon_account: "synthetic-account",
      fubon_password: "synthetic-password",
    },
  });

  const root = await mkdtemp(join(tmpdir(), "fubon-app-workflow-"));
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
    assert.deepEqual(await readdir(root), [], "typed App dispatch creates no source or log files");
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
