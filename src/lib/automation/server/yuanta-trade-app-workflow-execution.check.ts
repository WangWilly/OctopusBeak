import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type {
  WorkflowBrowserPort,
  WorkflowFinancialCommitPort,
} from "../workflow-executor.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { StatementSelectionError } from "../statement-selection.ts";

const [{ taskById }, { executeTaskRunForCheck }, {
  appWorkflowRegistration,
  workflowStartUrlForWorkflow,
}, { YUANTA_TRADE_LOGIN_URL }] = await Promise.all([
  import("./tasks.ts"),
  import("./task-run-check-support.ts"),
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
  assert.equal(appWorkflowRegistration(task.workflowId)?.definition?.id, "yuanta-trade-statements");
  assert.equal(appWorkflowRegistration(task.workflowId)?.definition?.requiresFinancialCommit, true);
  assert.equal(workflowStartUrlForWorkflow(task.workflowId), YUANTA_TRADE_LOGIN_URL);
  assert.deepEqual(appWorkflowRegistration(task.workflowId)?.inputFromEnvironment(syntheticEnvironment()), {
    credentials: {
      yuanta_trade_user_id: "synthetic-user-id",
      yuanta_trade_password: "synthetic-password",
      yuanta_trade_ca_path: "/synthetic/certificate.pfx",
      yuanta_trade_ca_password: "synthetic-certificate-password",
    },
    statementTypes: ["securities"],
  });
  assert.throws(
    () => appWorkflowRegistration(task.workflowId)?.inputFromEnvironment({ ...syntheticEnvironment(), [credentialKey("STATEMENT_TYPES")]: "" }),
    (error: unknown) => error instanceof StatementSelectionError && error.reason === "missing-selection",
  );

  const root = await mkdtemp(join(tmpdir(), "yuanta-trade-app-workflow-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await createTestPGlite("operational"));
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
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: task.id,
      kind: task.kind,
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const result = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId: created.taskRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workerPorts: { financialCommit },
      workflowBrowserPort: ({ startUrl }) => {
        observedStartUrl = startUrl;
        return browser;
      },
    });
    const run = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(result.status, "failed", "the sentinel stops before provider source collection");
    assert.equal(observedStartUrl, YUANTA_TRADE_LOGIN_URL);
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
