import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowStartUrlForTask,
} from "./app-workflow-registry.ts";
import { taskById } from "./tasks.ts";

const LOGIN_URL = "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private";
const credentialKey = (suffix: string) => ["LIBRETTO", "CLOUD", "HNCB", suffix].join("_");
const syntheticEnvironment = () => ({
  [credentialKey("USER_ID")]: "synthetic-user-id",
  [credentialKey("ACCOUNT")]: "synthetic-account",
  [credentialKey("PASSWORD")]: "synthetic-password",
});

test("HNCB statements resolve to the App-owned typed workflow", () => {
  const task = taskById("hncb-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "hncb-statements");
  assert.equal(task.script, "workflow:hncb-statements");
  assert.deepEqual(task.command, []);

  const definition = workflowDefinitionForTask(task.workflowId);
  assert.equal(definition?.id, "hncb-statements");
  assert.equal(definition?.requiresFinancialCommit, true);
  assert.equal(workflowStartUrlForTask(task.workflowId), LOGIN_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      hncb_user_id: "synthetic-user-id",
      hncb_account: "synthetic-account",
      hncb_password: "synthetic-password",
    },
  });
});
