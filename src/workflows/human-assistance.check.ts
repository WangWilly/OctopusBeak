import assert from "node:assert/strict";
import test from "node:test";
import { emitHumanAssistanceStage } from "./human-assistance.ts";

test("workflow assistance stages publish resolved target geometry without input values", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    const contract = await emitHumanAssistanceStage({
      stageId: "yuanta-bank-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
        modes: ["type"],
        locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
      }],
      contextRegions: [{
        id: "captcha-challenge",
        label: "CAPTCHA challenge",
        semanticId: "yuanta-bank.login.captcha-challenge",
      }],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"], initialZoom: 1.6 },
    });
    assert.deepEqual(contract.targets[0]?.rect, { x: 10, y: 20, width: 100, height: 24 });
    assert.match(lines[0] ?? "", /^human-assistance-contract:/);
    assert.equal(lines.join("\n").includes("captcha-answer"), false);
  } finally {
    console.log = originalLog;
  }
});

