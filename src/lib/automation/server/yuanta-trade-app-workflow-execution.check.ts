import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type {
  WorkflowBrowserPort,
  WorkflowFinancialCommitPort,
} from "../workflow-executor.ts";

const [{ taskById }, { runAutomationTaskExecution }, {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowStartUrlForTask,
  registerWorkflowHumanAssistanceForTask,
}, { YUANTA_TRADE_LOGIN_URL }] = await Promise.all([
  import("./tasks.ts"),
  import("./task-run-execution.ts"),
  import("./app-workflow-registry.ts"),
  import("../../../workflows/yuanta-trade-statements.ts"),
]);

const credentialKey = (suffix: string) => ["LIBRETTO", "CLOUD", "YUANTA", "TRADE", suffix].join("_");
const syntheticEnvironment = () => ({
  [credentialKey("USER_ID")]: "synthetic-user-id",
  [credentialKey("PASSWORD")]: "synthetic-password",
  [credentialKey("CA_PATH")]: "/synthetic/certificate.pfx",
  [credentialKey("CA_PASSWORD")]: "synthetic-certificate-password",
});

test("Yuanta Trade dispatch uses the typed App workflow and maps credentials", async () => {
  const task = taskById("yuanta-trade-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "yuanta-trade-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.deepEqual(task.externalPrerequisites?.map(({ id }) => id), ["yuanta-servisign"]);
  assert.equal(workflowDefinitionForTask(task.workflowId)?.id, "yuanta-trade-statements");
  assert.equal(workflowDefinitionForTask(task.workflowId)?.requiresFinancialCommit, true);
  assert.equal(workflowStartUrlForTask(task.workflowId), YUANTA_TRADE_LOGIN_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      yuanta_trade_user_id: "synthetic-user-id",
      yuanta_trade_password: "synthetic-password",
      yuanta_trade_ca_path: "/synthetic/certificate.pfx",
      yuanta_trade_ca_password: "synthetic-certificate-password",
    },
  });

  const root = await mkdtemp(join(tmpdir(), "yuanta-trade-app-workflow-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  let observedStartUrl: string | undefined;
  let browserDispatches = 0;
  let commitCalls = 0;
  let assertAssistanceRegistered: (() => Promise<void>) | undefined;
  const browser: WorkflowBrowserPort = {
    async withPage() {
      browserDispatches += 1;
      await assertAssistanceRegistered?.();
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
    assertAssistanceRegistered = async () => {
      await assert.rejects(
        () => registerWorkflowHumanAssistanceForTask(task.workflowId, provider),
        /already registered for this task/u,
        "Yuanta Trade App dispatch registers its task-scoped assistance adapter",
      );
    };
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
    assert.equal(observedStartUrl, YUANTA_TRADE_LOGIN_URL);
    assert.equal(browserDispatches, 1, "the App executor entered the typed browser port");
    assert.equal(commitCalls, 0);
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.deepEqual(await readdir(root), [], "typed App dispatch creates no source or log files");
    const unregister = await registerWorkflowHumanAssistanceForTask(task.workflowId, provider);
    unregister();
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
