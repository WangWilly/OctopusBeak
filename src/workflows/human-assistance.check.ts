import assert from "node:assert/strict";
import test from "node:test";
import { emitHumanAssistanceStage } from "./human-assistance.ts";

test("workflow assistance stages publish resolved target geometry without input values", async () => {
  const frames: string[] = [];
  const contract = await emitHumanAssistanceStage({
      stageId: "yuanta-bank-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
        modes: ["click", "type"],
        locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
      }],
      contextRegions: [{
        id: "captcha-challenge",
        label: "CAPTCHA challenge",
        semanticId: "yuanta-bank.login.captcha-challenge",
        locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
      }],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"], initialZoom: 1.15 },
    }, (value) => frames.push(JSON.stringify(value)));
  assert.deepEqual(contract.targets[0]?.rect, { x: 10, y: 20, width: 100, height: 24 });
  assert.deepEqual(contract.contextRegions[0]?.rect, { x: 0, y: 0, width: 200, height: 80 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.includes("captcha-answer"), false);
});

test("assistance stages publish a declared challenge kind and solver image region", async () => {
  const frames: string[] = [];
  const contract = await emitHumanAssistanceStage({
      stageId: "yuanta-bank-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
        modes: ["click", "type"],
        locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
      }],
      contextRegions: [{
        id: "captcha-challenge",
        label: "CAPTCHA challenge",
        semanticId: "yuanta-bank.login.captcha-challenge",
        locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
      }],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"], initialZoom: 1.15 },
      challengeKind: "text-captcha",
      challengeImageRegion: {
        id: "captcha-image",
        label: "CAPTCHA image",
        semanticId: "yuanta-bank.login.captcha-image",
        locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
      },
    }, (value) => frames.push(JSON.stringify(value)));
  assert.equal(contract.challengeKind, "text-captcha");
  assert.deepEqual(contract.challengeImageRegion, {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "yuanta-bank.login.captcha-image",
    rect: { x: 0, y: 0, width: 200, height: 80 },
  });
});

test("assistance stages reject an unresolvable solver image region", async () => {
  await assert.rejects(
    emitHumanAssistanceStage({
      stageId: "yuanta-bank-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
        modes: ["click", "type"],
        locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
      }],
      contextRegions: [],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: [] },
      challengeKind: "image-selection",
      challengeImageRegion: {
        id: "captcha-image",
        label: "CAPTCHA image",
        semanticId: "yuanta-bank.login.captcha-image",
        locator: { boundingBox: async () => null },
      },
    }, () => {}),
    /challenge image region cannot be resolved: yuanta-bank\.login\.captcha-image/,
  );
});
