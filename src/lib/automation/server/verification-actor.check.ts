import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_NON_SECRET_KEYS,
} from "./tasks.ts";
import { automationGroupVerificationActors } from "./settings.ts";
import {
  readAutomationSettingsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";
import { VERIFICATION_CONFIDENCE_THRESHOLD_KEYS } from "../verification-config.ts";

const nonSecretKeys = AUTOMATION_NON_SECRET_KEYS as readonly string[];

test("every supported source defaults its verification actor to human", () => {
  const actors = automationGroupVerificationActors({});
  for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
    assert.equal(actors[group.id], "human");
  }
});

test("a per-source actor override is read back while others stay human", () => {
  const fubon = AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "fubon");
  assert.ok(fubon?.verificationActorKey);
  const actors = automationGroupVerificationActors({
    [fubon.verificationActorKey!]: "solver",
  });
  assert.equal(actors.fubon, "solver");
  assert.equal(actors.esun, "human");
});

test("verification actor and confidence threshold keys are operational settings", () => {
  for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
    if (!group.verificationActorKey) continue;
    assert.equal(nonSecretKeys.includes(group.verificationActorKey), true);
  }
  for (const key of Object.values(VERIFICATION_CONFIDENCE_THRESHOLD_KEYS)) {
    assert.equal(nonSecretKeys.includes(key), true);
  }
});

test("actor and threshold settings round-trip through the settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "verification-actor-"));
  try {
    const path = join(dir, "settings.json");
    writeAutomationSettingsFile(path, {
      LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR: "solver",
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "0.9",
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["image-selection"]]: "0.75",
    });
    const read = readAutomationSettingsFile(path);
    assert.equal(read.LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR, "solver");
    assert.equal(read[VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]], "0.9");
    assert.equal(read[VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["image-selection"]], "0.75");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
