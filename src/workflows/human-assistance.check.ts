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
      focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"], initialZoom: 1.6 },
    }, (value) => frames.push(JSON.stringify(value)));
  assert.deepEqual(contract.targets[0]?.rect, { x: 10, y: 20, width: 100, height: 24 });
  assert.deepEqual(contract.contextRegions[0]?.rect, { x: 0, y: 0, width: 200, height: 80 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.includes("captcha-answer"), false);
});
