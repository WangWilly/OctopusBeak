import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "automation-desktop-api-"));
const originalCwd = process.cwd();
const credentialPrefix = "LIBRETTO_CLOUD_" + "FUBON_";
const enabledKey = `${credentialPrefix}ENABLED`;
const userIdKey = `${credentialPrefix}USER_ID`;
const accountKey = `${credentialPrefix}ACCOUNT`;
const passwordKey = `${credentialPrefix}PASSWORD`;
const certificatePathKey = "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH";
let resetCredentialCodec: (() => void) | null = null;

try {
  process.chdir(dir);
  writeFileSync(
    "settings.json",
    JSON.stringify(
      {
        AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
        [enabledKey]: true,
        LIBRETTO_CLOUD_ESUN_ENABLED: false,
        LIBRETTO_CLOUD_YUANTA_ENABLED: false,
        LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: false,
        LIBRETTO_CLOUD_CATHAY_ENABLED: false,
        LIBRETTO_CLOUD_HNCB_ENABLED: false,
        LIBRETTO_CLOUD_CTBC_ENABLED: false,
        LIBRETTO_CLOUD_POST_ENABLED: false,
        LIBRETTO_CLOUD_SINOPAC_ENABLED: false,
        LIBRETTO_CLOUD_LINEBANK_ENABLED: false,
        LIBRETTO_CLOUD_EINVOICE_ENABLED: true,
      },
      null,
      2,
    ),
  );
  const initialSettingsText = readFileSync("settings.json", "utf8");
  writeFileSync(
    "credentials.json",
    JSON.stringify(
      {
        [userIdKey]: "user",
        [accountKey]: "acct",
        [passwordKey]: "pw",
        [certificatePathKey]: join(dir, "certificate.txt"),
      },
      null,
      2,
    ),
  );

  const configFiles = await import("./config-files.ts");
  resetCredentialCodec = () => configFiles.setAutomationCredentialCodec(null);
  const api = await import("./desktop-api.ts");
  const { openLedgerDatabase } = await import("../../../ledger/db/client.ts");
  const { createTaskRun } = await import("./store.ts");
  const db = openLedgerDatabase(dir);
  try {
    createTaskRun(db, {
      taskId: "fubon-all-statements",
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "completed",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      logPath: "data/automation/logs/fubon.log",
      logTail: "ok",
    });
  } finally {
    db.close();
  }

  const model = api.loadAutomationDesktopModel(dir);
  assert.equal(
    api.automationSetupGuideLink("maicoin", "api-guide", "en")?.url,
    "https://campaign.maicoin.com/en/api",
  );
  assert.equal(api.automationSetupGuideLink("maicoin", "missing", "en"), null);
  const fubonGroup = model.credentialGroups.find(
    (group) => group.id === "fubon",
  );
  assert.equal(fubonGroup?.enabled, true);
  assert.deepEqual(fubonGroup?.selectedStatementTypeIds, [
    "deposit",
    "credit_card",
    "loan",
  ]);
  assert.equal(fubonGroup?.statementSetupRequired, false);
  assert.equal(model.automation.credentials[passwordKey], true);
  const yuantaSecuritiesGroup = model.credentialGroups.find(
    (group) => group.id === "yuanta-trade",
  );
  assert.equal(
    yuantaSecuritiesGroup?.invalidCredentialFileReasons?.[certificatePathKey],
    "invalid-extension",
  );
  assert.equal(
    yuantaSecuritiesGroup?.invalidCredentialFileKeys.includes(
      certificatePathKey,
    ),
    true,
  );
  const credentialsWithMissingCertificate = JSON.parse(
    readFileSync("credentials.json", "utf8"),
  );
  credentialsWithMissingCertificate[certificatePathKey] = join(
    dir,
    "missing.PFX",
  );
  writeFileSync(
    "credentials.json",
    JSON.stringify(credentialsWithMissingCertificate, null, 2),
  );
  const missingCertificateModel = api.loadAutomationDesktopModel(dir);
  assert.equal(
    missingCertificateModel.credentialGroups.find(
      (group) => group.id === "yuanta-trade",
    )?.invalidCredentialFileReasons?.[certificatePathKey],
    "missing-or-unreadable",
  );
  assert.equal(model.automation.credentials.MAX_SUB_ACCOUNT, true);
  assert.equal(Object.hasOwn(model.automation, "runHistory"), false);
  assert.equal(
    model.automation.tasks.find((task) => task.id === "fubon-all-statements")
      ?.ranToday,
    true,
  );
  assert.equal(
    model.automation.tasks.find((task) => task.id === "fubon-all-statements")
      ?.primaryAction,
    "Run",
  );
  assert.equal(
    api.automationRunHistory(dir)[0]?.taskId,
    "fubon-all-statements",
  );
  assert.throws(
    () => api.assertHumanAssistanceCompletionCanResume(null),
    /contract is missing/i,
  );
  assert.throws(
    () =>
      api.assertHumanAssistanceCompletionCanResume({
        mode: "inline",
        targetIds: ["captcha-input"],
        status: "pending",
      }),
    /input is incomplete/i,
  );
  assert.throws(
    () =>
      api.assertHumanAssistanceCompletionCanResume({
        mode: "independent",
        targetIds: ["captcha-checkbox"],
        status: "entered",
      }),
    /Run Check verification/i,
  );
  api.assertHumanAssistanceCompletionCanResume({
    mode: "inline",
    targetIds: ["captcha-input"],
    status: "entered",
  });
  api.assertHumanAssistanceCompletionCanResume({
    mode: "independent",
    targetIds: ["captcha-checkbox"],
    status: "verified",
  });
  assert.doesNotThrow(() =>
    api.assertAutomationTaskCanStart("fubon-all-statements", dir),
  );
  const modelWithDisabledFubon = {
    ...model,
    credentialGroups: model.credentialGroups.map((group) =>
      group.id === "fubon" ? { ...group, enabled: false } : group,
    ),
  };
  assert.equal(
    api.assertAutomationTasksCanStart(
      ["fubon-all-statements"],
      modelWithDisabledFubon,
    )[0]?.id,
    "fubon-all-statements",
  );

  const previousEnabledEnv = process.env[enabledKey];
  const settingsWithoutEnabledKey = JSON.parse(initialSettingsText) as Record<
    string,
    unknown
  >;
  delete settingsWithoutEnabledKey[enabledKey];
  process.env[enabledKey] = "false";
  writeFileSync(
    "settings.json",
    `${JSON.stringify(settingsWithoutEnabledKey, null, 2)}\n`,
  );
  try {
    const envOverrideModel = api.loadAutomationDesktopModel(dir);
    const envOverrideGroup = envOverrideModel.credentialGroups.find(
      (group) => group.id === "fubon",
    );
    assert.equal(envOverrideGroup?.enabled, false);
    assert.equal(envOverrideGroup?.statementSetupRequired, false);
  } finally {
    if (previousEnabledEnv === undefined) delete process.env[enabledKey];
    else process.env[enabledKey] = previousEnabledEnv;
    writeFileSync("settings.json", initialSettingsText);
  }

  const credentialsBeforeInvalidSave = readFileSync("credentials.json", "utf8");
  assert.deepEqual(
    api.automationSaveCredentials({ LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "" }),
    { saved: true },
  );
  assert.equal(
    JSON.parse(readFileSync("settings.json", "utf8"))
      .LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES,
    "deposit,credit_card,loan",
  );
  const settingsAfterSelectionSave = readFileSync("settings.json", "utf8");
  assert.equal(
    readFileSync("credentials.json", "utf8"),
    credentialsBeforeInvalidSave,
  );

  assert.deepEqual(
    api.automationSaveCredentials({ [certificatePathKey]: "relative.PFX" }),
    {
      saved: false,
      error: "invalid-certificate-file",
      credentialKey: certificatePathKey,
      reason: "missing-or-unreadable",
    },
  );
  assert.deepEqual(
    api.automationSaveCredentials({
      [certificatePathKey]: join(dir, "certificate.txt"),
    }),
    {
      saved: false,
      error: "invalid-certificate-file",
      credentialKey: certificatePathKey,
      reason: "invalid-extension",
    },
  );
  assert.equal(
    readFileSync("settings.json", "utf8"),
    settingsAfterSelectionSave,
  );
  assert.equal(
    readFileSync("credentials.json", "utf8"),
    credentialsBeforeInvalidSave,
  );

  const staleSettings = JSON.parse(readFileSync("settings.json", "utf8"));
  staleSettings.LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES = "deposit,retired_type";
  writeFileSync("settings.json", `${JSON.stringify(staleSettings, null, 2)}\n`);
  const repairModel = api.loadAutomationDesktopModel(dir);
  const repairGroup = repairModel.credentialGroups.find(
    (group) => group.id === "fubon",
  );
  assert.deepEqual(repairGroup?.selectedStatementTypeIds, [
    "deposit",
    "credit_card",
    "loan",
  ]);
  assert.equal(repairGroup?.statementSetupRequired, false);
  assert.equal(
    repairModel.automation.tasks.find(
      (task) => task.id === "fubon-all-statements",
    )?.primaryAction,
    "Run",
  );
  assert.doesNotThrow(() =>
    api.assertAutomationTaskCanStart("fubon-all-statements", dir),
  );
  assert.deepEqual(api.automationSaveCredentials({ [enabledKey]: "true" }), {
    saved: true,
  });

  api.automationSaveCredentials({
    LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "loan, deposit,loan",
  });
  assert.equal(
    JSON.parse(readFileSync("settings.json", "utf8"))
      .LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES,
    "deposit,credit_card,loan",
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(readFileSync("credentials.json", "utf8")),
      "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES",
    ),
    false,
  );

  assert.deepEqual(
    api
      .assertAutomationTasksCanStart(
        ["fubon-all-statements", "fubon-all-statements"],
        model,
      )
      .map((task) => task.id),
    ["fubon-all-statements"],
  );

  assert.throws(
    () => api.assertAutomationTaskCanStart("import-downloads-csv", dir),
    /Import is locked/,
  );

  const waitingDb = openLedgerDatabase(dir);
  try {
    createTaskRun(waitingDb, {
      taskId: "fubon-all-statements",
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date(Date.now() + 1_000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      logPath: "data/automation/logs/fubon-waiting.log",
      logTail: "Workflow paused. resume --session ses-fubon-waiting",
    });
  } finally {
    waitingDb.close();
  }
  assert.throws(
    () => api.assertAutomationTaskCanStart("fubon-all-statements", dir),
    /waiting for human/i,
  );

  const fakeCodec = {
    encrypt(text: string) {
      return Buffer.from(`safe:${text}`, "utf8").toString("base64");
    },
    decrypt(payload: string) {
      const text = Buffer.from(payload, "base64").toString("utf8");
      if (!text.startsWith("safe:"))
        throw new Error("bad fake credential payload");
      return text.slice("safe:".length);
    },
  };
  configFiles.setAutomationCredentialCodec(fakeCodec);

  const settingsBeforeEncryptionFailure = readFileSync("settings.json", "utf8");
  const credentialsBeforeEncryptionFailure = readFileSync(
    "credentials.json",
    "utf8",
  );
  configFiles.setAutomationCredentialCodec({
    encrypt() {
      throw new Error("fake encryption failure");
    },
    decrypt: fakeCodec.decrypt,
  });
  assert.throws(
    () =>
      api.automationSaveCredentials({
        [enabledKey]: "false",
        [accountKey]: "must-not-encrypt",
      }),
    /fake encryption failure/,
  );
  assert.equal(
    readFileSync("settings.json", "utf8"),
    settingsBeforeEncryptionFailure,
  );
  assert.equal(
    readFileSync("credentials.json", "utf8"),
    credentialsBeforeEncryptionFailure,
  );
  configFiles.setAutomationCredentialCodec(fakeCodec);

  const settingsBeforeCredentialWriteFailure = readFileSync(
    "settings.json",
    "utf8",
  );
  const credentialsBeforeCredentialWriteFailure = readFileSync(
    "credentials.json",
    "utf8",
  );
  const blockedCredentialTempPath = `credentials.json.tmp-${process.pid}`;
  mkdirSync(blockedCredentialTempPath);
  try {
    assert.throws(
      () =>
        api.automationSaveCredentials({
          [enabledKey]: "false",
          [accountKey]: "must-not-persist",
        }),
      /EISDIR|directory/i,
    );
  } finally {
    rmSync(blockedCredentialTempPath, { recursive: true, force: true });
  }
  assert.equal(
    readFileSync("settings.json", "utf8"),
    settingsBeforeCredentialWriteFailure,
  );
  assert.equal(
    readFileSync("credentials.json", "utf8"),
    credentialsBeforeCredentialWriteFailure,
  );

  const saveResult = api.automationSaveCredentials({
    [enabledKey]: "false",
    [accountKey]: "next-acct",
  });
  assert.deepEqual(saveResult, { saved: true });

  const settings = JSON.parse(readFileSync("settings.json", "utf8"));
  const rawCredentialsText = readFileSync("credentials.json", "utf8");
  const rawCredentials = JSON.parse(rawCredentialsText) as { format?: unknown };
  const credentials =
    configFiles.readAutomationCredentialsFile("credentials.json");
  assert.equal(settings[enabledKey], false);
  assert.equal(Object.hasOwn(settings, accountKey), false);
  assert.equal(
    rawCredentials.format,
    configFiles.AUTOMATION_CREDENTIALS_FORMAT,
  );
  assert.equal(rawCredentialsText.includes("next-acct"), false);
  assert.equal(credentials[accountKey], "next-acct");
  assert.equal(Object.hasOwn(credentials, enabledKey), false);

  const settingsBeforeCredentialReadFailure = readFileSync(
    "settings.json",
    "utf8",
  );
  const credentialsBeforeCredentialReadFailure = readFileSync(
    "credentials.json",
    "utf8",
  );
  configFiles.setAutomationCredentialCodec({
    encrypt: fakeCodec.encrypt,
    decrypt() {
      throw new Error("fake decryption failure");
    },
  });
  assert.throws(
    () =>
      api.automationSaveCredentials({
        [enabledKey]: "true",
        [accountKey]: "must-not-read",
      }),
    /fake decryption failure/,
  );
  assert.equal(
    readFileSync("settings.json", "utf8"),
    settingsBeforeCredentialReadFailure,
  );
  assert.equal(
    readFileSync("credentials.json", "utf8"),
    credentialsBeforeCredentialReadFailure,
  );
  configFiles.setAutomationCredentialCodec(fakeCodec);

  resetCredentialCodec();
  assert.throws(
    () => configFiles.readAutomationCredentialsFile("credentials.json"),
    /Credential encryption is not configured/,
  );
} finally {
  resetCredentialCodec?.();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
}
