import assert from "node:assert/strict";
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
  automationConfigEnv,
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  setAutomationCredentialCodec,
  writeAutomationCredentialsFile,
} from "../../../src/lib/automation/server/config-files.ts";
import { AUTOMATION_SECRET_KEYS } from "../../../src/lib/automation/server/tasks.ts";
import { automationCleanupFailureDetails } from "../../../src/lib/automation/server/automation-session-disposition.ts";
import {
  accumulateAutomationOutput,
} from "../../../src/lib/automation/server/task-run-execution.ts";
import { finalFailureMessage } from "../../../src/lib/automation/server/task-run-finalization.ts";
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
  const workerEnv = automationConfigEnv({
    baseEnv: { PATH: process.env.PATH },
    settings: {},
    credentials: restoredCredentials,
  });

  const output = accumulateAutomationOutput(
    { logTail: "", resumeFailure: null },
    `provider failed: ${credentials[requestedKey]}\n`,
  );
  const failureMessage = finalFailureMessage(output.logTail, 1);
  const cleanupFailure = automationCleanupFailureDetails(
    {
      taskRunId: "audit-task-run",
      session: "audit-session",
      pid: 12345,
    },
    new Error(`cleanup failed: ${credentials[requestedKey]}`),
  );

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
      "Electron Forge does not exclude the gitignored root credentials.json from packaged App resources.",
      "production-desktop",
    ),
    observation(
      "renderer-status-projection",
      !containsCanary(credentialStatus, canaries) &&
        Object.values(credentialStatus).every(Boolean)
        ? "PASS"
        : "FAIL",
      "Credential projection exposes presence booleans, not values.",
      "production-desktop",
    ),
    observation(
      "task-scoped-worker-capability",
      workerEnv[requestedKey] === credentials[requestedKey] &&
        workerEnv[unrelatedKey] === undefined
        ? "PASS"
        : "FAIL",
      "A worker requesting one credential receives the unrelated credential too.",
      "production-automation-worker",
    ),
    observation(
      "stdout-stderr-redaction",
      containsCanary(output, canaries) ? "FAIL" : "PASS",
      "The output accumulator strips terminal controls but preserves the canary in logChunk and logTail.",
      "production-automation-worker",
    ),
    observation(
      "persisted-failure-redaction",
      containsCanary(failureMessage, canaries) ? "FAIL" : "PASS",
      "The final failure selector preserves a canary-bearing log line for persistence.",
      "production-automation-worker",
    ),
    observation(
      "cleanup-diagnostic-redaction",
      containsCanary(cleanupFailure, canaries) ? "FAIL" : "PASS",
      "Cleanup diagnostics preserve the raw Error message.",
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
    [
      "packaged-root-secret-exclusion",
      "task-scoped-worker-capability",
      "stdout-stderr-redaction",
      "persisted-failure-redaction",
      "cleanup-diagnostic-redaction",
    ],
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
    productionFailureCount: productionFailures.length,
    observations,
  }, null, 2)}\n`);
} finally {
  setAutomationCredentialCodec(null);
  rmSync(tempRoot, { recursive: true, force: true });
}
