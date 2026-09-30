import assert from "node:assert/strict";
import test from "node:test";
import {
  createHumanAssistanceContract,
  parseHumanAssistanceContract,
  type HumanAssistanceContractInput,
} from "../human-assistance.ts";

const contract: HumanAssistanceContractInput = {
  stageId: "yuanta-bank-captcha",
  title: "Complete the CAPTCHA",
  targets: [{
    id: "captcha-input",
    label: "CAPTCHA input",
    semanticId: "yuanta-bank.login.captcha-input",
    modes: ["type"],
  }],
  contextRegions: [{
    id: "captcha-challenge",
    label: "CAPTCHA challenge",
    semanticId: "yuanta-bank.login.captcha-challenge",
  }],
  completion: { mode: "inline", targetIds: ["captcha-input"] },
  focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"] },
};

test("human assistance contracts round-trip in operational run metadata", () => {
  const contractRecord = createHumanAssistanceContract({
    ...contract,
    completion: { ...contract.completion, status: "entered" },
  }, 7);
  const serializedRecord = JSON.stringify({ humanAssistanceContract: contractRecord });
  assert.deepEqual(parseHumanAssistanceContract(serializedRecord), contractRecord);
  assert.equal(parseHumanAssistanceContract("{malformed"), null);
});
