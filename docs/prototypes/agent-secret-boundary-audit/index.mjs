import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";

import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  setAutomationCredentialCodec,
  writeAutomationCredentialsFile,
} from "../../../src/lib/automation/server/config-files.ts";
import {
  AUTOMATION_SECRET_KEYS,
  AUTOMATION_TASKS,
} from "../../../src/lib/automation/server/tasks.ts";
import {
  appendLog,
  automationCleanupFailureDetails,
} from "../../../src/lib/automation/server/automation-session-disposition.ts";
import {
  accumulateAutomationOutput,
  automationProcessEnv,
} from "../../../src/lib/automation/server/task-run-execution.ts";
import {
  agentHelperProcessEnv,
  agentProviderProcessEnv,
} from "../../../src/lib/agent/server/process-environment.ts";
import { finalFailureMessage } from "../../../src/lib/automation/server/task-run-finalization.ts";
import {
  createAutomationSecretBoundaryGate,
} from "../../../src/lib/automation/server/secret-boundary.ts";
import {
  createTaskRun,
  latestTaskRuns,
  recentTaskRuns,
  updateTaskRun,
} from "../../../src/lib/automation/server/store.ts";
import {
  logLibrettoRunCdpPatchOutput,
} from "../../../src/lib/automation/server/runner.ts";
import { openLedgerDatabase } from "../../../src/ledger/db/client.ts";
import {
  createInitialState,
  projectProviderInput,
  reduce,
  scenarioActions,
} from "../agent-runtime/state-machine.mjs";

const require = createRequire(import.meta.url);
const forgeConfig = require("../../../forge.config.cjs");
const tempRoot = mkdtempSync(join(tmpdir(), "octopusbeak-secret-boundary-"));
const credentialPath = join(tempRoot, "automation-credentials.json");
const key = randomBytes(32);

function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decrypt(payload) {
  const bytes = Buffer.from(payload, "base64");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

function containsCanary(value, canaries) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return canaries.some((canary) => text.includes(canary));
}

function observation(id, status, evidence, boundary) {
  return { id, status, evidence, boundary };
}

function observedChildEnvironment(env) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "process.stdout.write(JSON.stringify(process.env))"],
    { env, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

try {
  assert.ok(
    AUTOMATION_SECRET_KEYS.length >= 2,
    "The audit requires at least two independently scoped secret keys.",
  );

  const auditCredentialKeys = AUTOMATION_SECRET_KEYS.filter((credentialKey) =>
    /(PASSWORD|TOKEN|SECRET|COOKIE|API_KEY)/.test(credentialKey)
  );
  assert.ok(
    auditCredentialKeys.length >= 2,
    "The audit requires at least two value-bearing Authentication secret keys.",
  );
  const [requestedKey, unrelatedKey] = auditCredentialKeys;
  const requestedTask = AUTOMATION_TASKS.find((task) =>
    task.credentialKeys.includes(requestedKey)
  );
  assert.ok(requestedTask, `No automation task declares ${requestedKey}.`);
  assert.equal(
    requestedTask.credentialKeys.includes(unrelatedKey),
    false,
    "The task-scoped audit requires an unrelated credential.",
  );
  const credentials = {
    [requestedKey]: `audit-canary-${randomUUID()}`,
    [unrelatedKey]: `audit-canary-${randomUUID()}`,
  };
  const canaries = Object.values(credentials);

  setAutomationCredentialCodec({ encrypt, decrypt });
  writeAutomationCredentialsFile(credentialPath, credentials);

  const rawCredentialFile = readFileSync(credentialPath, "utf8");
  const restoredCredentials = readAutomationCredentialsFile(credentialPath);
  const credentialStatus = credentialStatusFromValues(
    restoredCredentials,
    [requestedKey, unrelatedKey],
  );
  const workerEnv = automationProcessEnv(requestedTask, {
    baseEnv: {
      PATH: process.env.PATH,
      [requestedKey]: credentials[requestedKey],
      [unrelatedKey]: credentials[unrelatedKey],
    },
    settings: {},
    credentials: restoredCredentials,
  });
  const agentBaseEnv = {
    PATH: process.env.PATH,
    [requestedKey]: credentials[requestedKey],
    [unrelatedKey]: credentials[unrelatedKey],
  };
  const helperEnv = observedChildEnvironment(agentHelperProcessEnv(agentBaseEnv));
  const providerEnv = observedChildEnvironment(agentProviderProcessEnv(agentBaseEnv));

  const gateFailures = [];
  const secretGate = createAutomationSecretBoundaryGate({
    secretValues: canaries,
    report: (failure) => gateFailures.push(failure),
  });
  const stdoutOutput = accumulateAutomationOutput(
    { logTail: "", resumeFailure: null },
    `provider failed: ${credentials[requestedKey]}\n`,
    secretGate,
    "stdout",
  );
  const output = accumulateAutomationOutput(
    {
      logTail: stdoutOutput.logTail,
      resumeFailure: stdoutOutput.resumeFailure,
    },
    `cleanup failed: ${credentials[unrelatedKey]}\n`,
    secretGate,
    "stderr",
  );
  const failureMessage = finalFailureMessage(output.logTail, 1, secretGate);
  const cleanupFailure = automationCleanupFailureDetails(
    {
      taskRunId: "audit-task-run",
      session: "audit-session",
      pid: 12345,
    },
    new Error(`cleanup failed: ${credentials[requestedKey]}`),
    secretGate,
  );
  const logPath = join(tempRoot, "automation.log");
  appendLog(
    logPath,
    `filesystem diagnostic: ${credentials[requestedKey]}\n`,
    secretGate,
  );
  const filesystemLog = readFileSync(logPath, "utf8");
  const taskDb = openLedgerDatabase(join(tempRoot, "ledger"));
  const taskRun = createTaskRun(taskDb, {
    taskId: "secret-boundary-audit",
    script: "run:secret-boundary-audit",
    kind: "sync",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-08-03T00:00:00.000Z",
    logPath,
    logTail: `sqlite tail: ${credentials[requestedKey]}`,
  }, secretGate);
  updateTaskRun(taskDb, taskRun.taskRunId, {
    status: "failed",
    finishedAt: "2026-08-03T00:00:01.000Z",
    errorMessage: `sqlite failure: ${credentials[unrelatedKey]}`,
  }, secretGate);
  const sqliteRecord = taskDb.prepare(
    "SELECT error_message, log_tail, record_json FROM automation_task_runs WHERE task_run_id = ?",
  ).get(taskRun.taskRunId);
  taskDb.prepare(`
    UPDATE automation_task_runs
    SET error_message = ?, log_tail = ?, record_json = ?
    WHERE task_run_id = ?
  `).run(
    credentials[requestedKey],
    credentials[unrelatedKey],
    JSON.stringify({ errorMessage: credentials[requestedKey] }),
    taskRun.taskRunId,
  );
  const diagnosticExport = recentTaskRuns(taskDb, 1, secretGate);
  const rendererProjection = latestTaskRuns(taskDb, secretGate);
  taskDb.close();
  const patchDiagnostics = [];
  let patchDiagnosticFailure = "";
  const previousPatchSecrets = Object.fromEntries(
    [requestedKey, unrelatedKey].map((key) => [key, process.env[key]]),
  );
  try {
    process.env[requestedKey] = credentials[requestedKey];
    process.env[unrelatedKey] = credentials[unrelatedKey];
    logLibrettoRunCdpPatchOutput(
      {
        stdout: `patch stdout: ${credentials[requestedKey]}`,
        stderr: `patch stderr: ${credentials[unrelatedKey]}`,
      },
      undefined,
      {
        info: (value) => patchDiagnostics.push(String(value)),
        warn: (value) => patchDiagnostics.push(String(value)),
      },
    );
  } catch (error) {
    patchDiagnosticFailure = error instanceof Error ? error.message : String(error);
  } finally {
    for (const [key, value] of Object.entries(previousPatchSecrets)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const prototypeState = scenarioActions("lifecycle").reduce(
    (state, action) => reduce(state, {
      ...action,
      auditCanary: credentials[requestedKey],
    }),
    createInitialState(),
  );
  const prototypeProviderInput = projectProviderInput(prototypeState);

  const boundaryState = scenarioActions("boundary").reduce(
    (state, action) => reduce(state, {
      ...action,
      auditCanary: credentials[requestedKey],
    }),
    createInitialState(),
  );
  const packagedRootCredentialsExcluded = forgeConfig.packagerConfig.ignore.some(
    (ignoredPath) => ignoredPath.test("/credentials.json"),
  );

  const observations = [
    observation(
      "encrypted-at-rest",
      containsCanary(rawCredentialFile, canaries) ? "FAIL" : "PASS",
      "The persisted credential envelope contains neither runtime canary.",
      "production-desktop",
    ),
    observation(
      "credential-file-mode",
      (statSync(credentialPath).mode & 0o777) === 0o600 ? "PASS" : "FAIL",
      "The atomic credential writer creates the file with mode 0600.",
      "production-desktop",
    ),
    observation(
      "packaged-root-secret-exclusion",
      packagedRootCredentialsExcluded ? "PASS" : "FAIL",
      "Electron Forge explicitly excludes the root credentials.json from packaged App resources.",
      "production-desktop",
    ),
    observation(
      "renderer-status-projection",
      !containsCanary(credentialStatus, canaries) &&
        Object.values(credentialStatus).every(Boolean)
        ? "PASS"
        : "FAIL",
      "Credential and task-run projections expose booleans/allowlisted fields, not values.",
      "production-desktop",
    ),
    observation(
      "task-scoped-worker-capability",
      workerEnv[requestedKey] === credentials[requestedKey] &&
        workerEnv[unrelatedKey] === undefined
        ? "PASS"
        : "FAIL",
      "The selected worker receives its declared credential and not the unrelated credential.",
      "production-automation-worker",
    ),
    observation(
      "agent-helper-process-environment",
      containsCanary(helperEnv, canaries) ? "FAIL" : "PASS",
      "The App-owned helper child environment is built from a non-secret allowlist.",
      "production-agent-launch-contract",
    ),
    observation(
      "agent-provider-process-environment",
      containsCanary(providerEnv, canaries) ? "FAIL" : "PASS",
      "The provider child environment is built from the same zero-secret allowlist.",
      "production-agent-launch-contract",
    ),
    observation(
      "stdout-stderr-redaction",
      !containsCanary({ stdoutOutput, output }, canaries) &&
        gateFailures.some(({ surface }) => surface === "stdout") &&
        gateFailures.some(({ surface }) => surface === "stderr")
        ? "PASS"
        : "FAIL",
      "The shared gate removes runtime canaries before stdout/stderr accumulation and reports only surface metadata.",
      "production-automation-worker",
    ),
    observation(
      "persisted-failure-redaction",
      containsCanary(failureMessage, canaries) ? "FAIL" : "PASS",
      "The final failure projection passes through the shared redaction and assertion gate.",
      "production-automation-worker",
    ),
    observation(
      "cleanup-diagnostic-redaction",
      containsCanary(cleanupFailure, canaries) ? "FAIL" : "PASS",
      "Cleanup diagnostics pass through the shared redaction and assertion gate.",
      "production-automation-worker",
    ),
    observation(
      "filesystem-log-redaction",
      containsCanary(filesystemLog, canaries) ? "FAIL" : "PASS",
      "The filesystem log writer gates content before append.",
      "production-automation-worker",
    ),
    observation(
      "sqlite-persistence-redaction",
      containsCanary(sqliteRecord, canaries) ? "FAIL" : "PASS",
      "SQLite columns and record_json pass through the allowlisted persistence gate.",
      "production-automation-worker",
    ),
    observation(
      "diagnostic-export-redaction",
      !containsCanary({ diagnosticExport, rendererProjection }, canaries)
        ? "PASS"
        : "FAIL",
      "Automation history and renderer task-run projections use allowlisted export schemas.",
      "production-automation-worker",
    ),
    observation(
      "patch-diagnostic-redaction",
      !containsCanary({ patchDiagnostics, patchDiagnosticFailure }, canaries) &&
        patchDiagnosticFailure ===
          "SECRET_BOUNDARY_VIOLATION surface=patch-stdout reason=authentication-secret-detected"
        ? "PASS"
        : "FAIL",
      "Libretto patch stdout/stderr include environment-only Authentication secrets in the shared gate before console projection.",
      "production-automation-worker",
    ),
    observation(
      "provider-projection-contract",
      !containsCanary(prototypeProviderInput, canaries) &&
        prototypeProviderInput.secretFields.length === 0 &&
        prototypeProviderInput.authority === "none"
        ? "PASS"
        : "FAIL",
      "The throwaway runtime projection excludes the injected canary and grants no authority.",
      "prototype-contract-only",
    ),
    observation(
      "secret-tool-rejection-contract",
      boundaryState.security.deniedSecretRequests === 1 &&
        !containsCanary(boundaryState, canaries)
        ? "PASS"
        : "FAIL",
      "The throwaway runtime rejects read_credentials and does not retain the injected canary.",
      "prototype-contract-only",
    ),
    observation(
      "checkpoint-fallback-contract",
      !containsCanary(prototypeState.checkpoint, canaries) &&
        !containsCanary(prototypeState.lineage, canaries) &&
        !containsCanary(prototypeState.logs, canaries)
        ? "PASS"
        : "FAIL",
      "The throwaway lifecycle excludes the injected canary from checkpoint, lineage, and logs.",
      "prototype-contract-only",
    ),
  ];

  const productionFailures = observations.filter(
    ({ status, boundary }) => status === "FAIL" && boundary.startsWith("production"),
  );
  assert.deepEqual(
    productionFailures.map(({ id }) => id),
    [],
    "Observed production boundary changed; review the audit contract and evidence.",
  );
  assert.equal(
    observations.some(
      ({ status, boundary }) =>
        status === "FAIL" && boundary === "prototype-contract-only",
    ),
    false,
    "The prototype contract leaked a canary.",
  );

  process.stdout.write(`${JSON.stringify({
    audit: "agent-authentication-secret-host-only-boundary",
    verdict: productionFailures.length === 0 ? "SHIP-ELIGIBLE" : "BLOCKED",
    canaryValuesEmitted: false,
    requestedCredentialKey: requestedKey,
    unrelatedCredentialKey: unrelatedKey,
    requestedTaskId: requestedTask.id,
    productionFailureCount: productionFailures.length,
    observations,
  }, null, 2)}\n`);
} finally {
  setAutomationCredentialCodec(null);
  rmSync(tempRoot, { recursive: true, force: true });
}
