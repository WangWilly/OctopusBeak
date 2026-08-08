import assert from "node:assert/strict";
import test from "node:test";
import {
  externalPrerequisiteSignal,
  isValidExternalPrerequisiteMetadata,
  parseExternalPrerequisiteSignals,
} from "./external-prerequisite.ts";

test("external prerequisite signals are explicit, stable, and deduplicated", () => {
  const signal = externalPrerequisiteSignal("yuanta-servisign");
  assert.equal(signal, "automation-prerequisite: yuanta-servisign");
  assert.deepEqual(
    parseExternalPrerequisiteSignals(
      `progress\n${signal}\n${signal}\nautomation-prerequisite: another-component\n`,
    ),
    ["yuanta-servisign", "another-component"],
  );
  assert.deepEqual(
    parseExternalPrerequisiteSignals("The task failed: automation-prerequisite: fake"),
    [],
  );
});

test("external prerequisite signal IDs reject unsafe values", () => {
  assert.throws(() => externalPrerequisiteSignal("https://example.com"), /Invalid/);
});

test("installer metadata must be HTTPS and match its provider host allowlist", () => {
  const metadata = {
    id: "component",
    provider: "Provider",
    component: "Component",
    downloadUrl: "https://provider.example.test/installer.pkg",
    allowedHosts: ["provider.example.test"],
    instructions: { en: "Install it.", "zh-TW": "請安裝。" },
  } as const;
  assert.equal(isValidExternalPrerequisiteMetadata(metadata), true);
  assert.equal(
    isValidExternalPrerequisiteMetadata({ ...metadata, downloadUrl: "http://provider.example.test/installer.pkg" }),
    false,
  );
  assert.equal(
    isValidExternalPrerequisiteMetadata({ ...metadata, downloadUrl: "https://evil.example.test/installer.pkg" }),
    false,
  );
});
