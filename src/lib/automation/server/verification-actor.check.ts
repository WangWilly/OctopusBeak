import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOMATION_NON_SECRET_KEYS } from "./tasks.ts";
import {
  readAutomationSettingsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";
import { VERIFICATION_CONFIDENCE_THRESHOLD_KEYS } from "../verification-config.ts";

const nonSecretKeys = AUTOMATION_NON_SECRET_KEYS as readonly string[];

test("confidence threshold keys are operational settings and no actor key remains", () => {
  for (const key of Object.values(VERIFICATION_CONFIDENCE_THRESHOLD_KEYS)) {
    assert.equal(nonSecretKeys.includes(key), true);
  }
  assert.deepEqual(nonSecretKeys.filter((key) => key.endsWith("_VERIFICATION_ACTOR")), []);
});

test("a settings file with stale verification actor keys loads and drops them", () => {
  const dir = mkdtempSync(join(tmpdir(), "verification-actor-"));
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({
      LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR: "human",
      LIBRETTO_CLOUD_ESUN_VERIFICATION_ACTOR: "solver",
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "0.9",
    }));
    assert.deepEqual(readAutomationSettingsFile(path), {
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "0.9",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("threshold settings round-trip through the settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "verification-actor-"));
  try {
    const path = join(dir, "settings.json");
    writeAutomationSettingsFile(path, {
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "0.9",
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["image-selection"]]: "0.75",
    });
    const read = readAutomationSettingsFile(path);
    assert.equal(read[VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]], "0.9");
    assert.equal(read[VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["image-selection"]], "0.75");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
