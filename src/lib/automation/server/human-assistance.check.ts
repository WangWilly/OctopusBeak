import assert from "node:assert/strict";
import test from "node:test";
import {
  createHumanAssistanceContractFrameParser,
  humanAssistanceContractFrame,
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

test("human assistance frames stay structured and stream safely across UTF-8 boundaries", () => {
  const frame = humanAssistanceContractFrame({
    ...contract,
    completion: { ...contract.completion, status: "entered" },
  });
  const parsed: HumanAssistanceContractInput[] = [];
  const parser = createHumanAssistanceContractFrameParser((value) => parsed.push(value));
  parser.push(frame);
  parser.flush();
  assert.equal(frame.includes("captcha-answer"), false);
  assert.deepEqual(parsed, [{
    ...contract,
    completion: { ...contract.completion, status: "entered" },
  }]);

  const unicodeContract = { ...contract, title: "完成驗證" };
  const unicodeFrame = humanAssistanceContractFrame(unicodeContract);
  const bytes = new TextEncoder().encode(unicodeFrame);
  const split = new TextEncoder().encode(
    unicodeFrame.slice(0, unicodeFrame.indexOf("完")),
  ).length;
  const streamed: HumanAssistanceContractInput[] = [];
  const streamedParser = createHumanAssistanceContractFrameParser((value) => streamed.push(value));
  streamedParser.push(bytes.subarray(0, split + 1));
  streamedParser.push(bytes.subarray(split + 1));
  streamedParser.flush();
  assert.deepEqual(streamed, [unicodeContract]);

  parser.push('{"captchaAnswer":"raw-secret"}\n');
  assert.equal(parsed.length, 1);
});
