import assert from "node:assert/strict";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_TASKS,
  CSV_IMPORT_DEPENDENCY_IDS,
  enabledAutomationTasks,
  enabledCsvImportDependencyIds,
  taskById,
} from "./tasks.ts";
import { businessDayUtcRange } from "./business-day.ts";
import { credentialStatus, updateEnvText } from "./env-file.ts";
import { automationGroupEnabledStatus } from "./settings.ts";

const fubonUserKey = "LIBRETTO_CLOUD_FUBON" + "_USER_ID";

assert.deepEqual(
  CSV_IMPORT_DEPENDENCY_IDS,
  [
    "fubon-all-statements",
    "esun-credit-card-statements",
    "yuanta-all-statements",
    "yuanta-trade-statements",
    "cathay-all-statements",
    "hncb-statements",
  ],
);

assert.equal(taskById("sync-maicoin")?.kind, "sync");
assert.equal(taskById("import-downloads-csv")?.kind, "import");
assert.deepEqual(
  taskById("import-downloads-csv")?.dependencies,
  CSV_IMPORT_DEPENDENCY_IDS,
);
assert.equal(AUTOMATION_TASKS.every((task) => task.maxAttempts >= 1), true);
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "fubon")?.credentialKeys,
  [
    "LIBRETTO_CLOUD_FUBON_USER_ID",
    "LIBRETTO_CLOUD_FUBON_ACCOUNT",
    "LIBRETTO_CLOUD_FUBON_PASSWORD",
  ],
);

const enabledGroups = automationGroupEnabledStatus("LIBRETTO_CLOUD_ESUN_ENABLED=false\n", {});
assert.equal(enabledGroups.fubon, true);
assert.equal(enabledGroups.esun, false);
assert.equal(enabledAutomationTasks(enabledGroups).some((task) => task.id === "esun-credit-card-statements"), false);
assert.equal(enabledAutomationTasks(enabledGroups).some((task) => task.id === "import-downloads-csv"), true);
assert.deepEqual(
  enabledCsvImportDependencyIds(enabledGroups),
  [
    "fubon-all-statements",
    "yuanta-all-statements",
    "yuanta-trade-statements",
    "cathay-all-statements",
    "hncb-statements",
  ],
);

const taipeiRange = businessDayUtcRange(
  new Date("2026-06-30T16:30:00.000Z"),
  "Asia/Taipei",
);
assert.equal(taipeiRange.businessDate, "2026-07-01");
assert.equal(taipeiRange.startUtc.toISOString(), "2026-06-30T16:00:00.000Z");
assert.equal(taipeiRange.endUtc.toISOString(), "2026-07-01T16:00:00.000Z");

const updatedEnv = updateEnvText(
  `# keep me\n${fubonUserKey}=old\nOTHER=value\n`,
  {
    [fubonUserKey]: "new-user",
    MAX_SUB_ACCOUNT: "main",
  },
);
assert.equal(
  updatedEnv,
  `# keep me\n${fubonUserKey}=new-user\nOTHER=value\nMAX_SUB_ACCOUNT=main\n`,
);

assert.deepEqual(
  credentialStatus(`${fubonUserKey}=abc\nMAX_SECRET_KEY=\n`),
  {
    [fubonUserKey]: true,
    MAX_SECRET_KEY: false,
  },
);
