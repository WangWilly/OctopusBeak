import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import type { CaptchaSourceOwner } from "./captcha-source-freshness.ts";
import {
  createProviderVerificationCapabilityRegistry,
  type ProviderVerificationCapabilityOwner,
} from "./provider-verification-capabilities.ts";

function contract(semanticId = "provider.login.captcha-input"): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version: 1,
    stageId: "captcha-stage",
    title: "Complete CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId,
      modes: ["type"],
      rect: { x: 0, y: 0, width: 10, height: 10 },
    }],
    contextRegions: [],
    completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
    challengeKind: "text-captcha",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
  };
}

function sourceOwner(id: string): CaptchaSourceOwner {
  return {
    id,
    capture: async () => null,
    isCurrent: async () => false,
  };
}

function owner(
  id: string,
  owns: (value: HumanAssistanceContract) => boolean,
): ProviderVerificationCapabilityOwner {
  return {
    id,
    capabilities: ["challenge-image"],
    owns,
    sourceOwner: sourceOwner(id),
  };
}

test("registry resolves the unique capability owner", () => {
  const first = owner("first", (value) => value.targets[0]?.semanticId === "provider.login.captcha-input");
  const registry = createProviderVerificationCapabilityRegistry([first]);
  const resolved = registry.resolve("challenge-image", contract());
  assert.equal(resolved, first);
  assert.equal(registry.resolveById("challenge-image", "first", contract()), first);
});

test("registry returns no owner when no provider claims the contract", () => {
  const registry = createProviderVerificationCapabilityRegistry([
    owner("first", () => false),
  ]);
  assert.equal(registry.resolve("challenge-image", contract()), null);
  assert.equal(registry.resolveById("challenge-image", "first", contract()), null);
});

test("registry fails closed when two owners claim the same capability", () => {
  const registry = createProviderVerificationCapabilityRegistry([
    owner("first", () => true),
    owner("second", () => true),
  ]);
  assert.equal(registry.resolve("challenge-image", contract()), null);
  assert.equal(registry.resolveById("challenge-image", "first", contract()), null);
});

test("freshness owner lookup stays bound to the capture owner", () => {
  const first = owner("first", (value) => value.targets[0]?.semanticId === "provider.login.captcha-input");
  const second = owner("second", (value) => value.targets[0]?.semanticId === "other.login.captcha-input");
  const registry = createProviderVerificationCapabilityRegistry([first, second]);
  assert.equal(registry.resolveById("challenge-image", "first", contract()), first);
  assert.equal(
    registry.resolveById("challenge-image", "second", contract()),
    null,
  );
  assert.equal(
    registry.resolveById("challenge-image", "first", contract("other.login.captcha-input")),
    null,
  );
});
