import assert from "node:assert/strict";
import test from "node:test";
import {
  ExternalPrerequisiteUnavailableError,
  isValidExternalPrerequisiteMetadata,
} from "./external-prerequisite.ts";

test("external prerequisite IDs reject unsafe values", () => {
  assert.equal(new ExternalPrerequisiteUnavailableError("yuanta-servisign").prerequisiteId, "yuanta-servisign");
  assert.throws(() => new ExternalPrerequisiteUnavailableError("https://example.com"), /Invalid/u);
});

test("installer metadata must be HTTPS and match its provider host allowlist", () => {
  const metadata = {
    id: "component",
    provider: "Provider",
    component: "Component",
    downloadUrl: "https://provider.example.test/installer.pkg",
    allowedHosts: ["provider.example.test"],
    unavailableEventCode: "component-unavailable",
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
