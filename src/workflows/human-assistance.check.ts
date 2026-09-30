import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitHumanAssistanceStage } from "./human-assistance.ts";

test("workflow assistance stages send resolved contracts through an injected typed publisher", async () => {
  const published: unknown[] = [];
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
    }, (value) => published.push(value));
  assert.deepEqual(contract.targets[0]?.rect, { x: 10, y: 20, width: 100, height: 24 });
  assert.deepEqual(contract.contextRegions[0]?.rect, { x: 0, y: 0, width: 200, height: 80 });
  assert.deepEqual(published, [contract]);
  assert.equal(JSON.stringify(published[0]).includes("captcha-answer"), false);
});

test("assistance stages publish a declared challenge kind and solver image region", async () => {
  const published: unknown[] = [];
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
    }, (value) => published.push(value));
  assert.equal(contract.challengeKind, "text-captcha");
  assert.deepEqual(published, [contract]);
  assert.deepEqual(contract.challengeImageRegion, {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "yuanta-bank.login.captcha-image",
    rect: { x: 0, y: 0, width: 200, height: 80 },
  });
});

test("assistance stages omit an unresolvable solver image region", async () => {
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
  }, () => {});
  assert.equal(contract.challengeKind, "image-selection");
  assert.equal(contract.challengeImageRegion, undefined);
});

test("an explicit no-op publisher ignores legacy file and file-descriptor settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "human-assistance-no-file-"));
  const outputPath = join(directory, "contract.jsonl");
  const previousPath = process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH;
  const previousFd = process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD;
  process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH = outputPath;
  process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD = "987654";
  try {
    const contract = await emitHumanAssistanceStage({
      stageId: "typed-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "captcha.input",
        modes: ["type"],
        locator: { boundingBox: async () => ({ x: 1, y: 2, width: 30, height: 12 }) },
      }],
      contextRegions: [],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: [] },
    }, () => undefined);
    assert.equal(contract.stageId, "typed-captcha");
    assert.equal(existsSync(outputPath), false);
  } finally {
    if (previousPath === undefined) delete process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH;
    else process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH = previousPath;
    if (previousFd === undefined) delete process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD;
    else process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD = previousFd;
    rmSync(directory, { recursive: true, force: true });
  }
});
