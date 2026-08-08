import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const providerWorkflows = [
  "yuanta-statements.ts",
  "yuanta-credit-card-statements.ts",
  "yuanta-loan-statements.ts",
  "yuanta-fund-statements.ts",
  "yuanta-foreign-currency-statements.ts",
  "yuanta-trade-statements.ts",
  "fubon-statements.ts",
  "fubon-credit-card-statements.ts",
  "fubon-loan-statements.ts",
  "cathay-statements.ts",
  "sinopac-statements.ts",
  "hncb-statements.ts",
  "einvoice-personal-invoices.ts",
  "post-statements.ts",
] as const;

test("all modelable human-assisted workflows publish a contract-backed stage", async () => {
  const sources = await Promise.all(providerWorkflows.map(async (file) => [
    file,
    await readFile(new URL(`./${file}`, import.meta.url), "utf8"),
  ] as const));
  for (const [file, source] of sources) {
    assert.match(source, /emitHumanAssistanceStage/, `${file} must publish a human assistance stage`);
    assert.doesNotMatch(source, /human-assistance-contract:\s*\{[^}]*captcha/i, `${file} must not put raw CAPTCHA data in a contract signal`);
  }
});

test("Yuanta Trade keeps checkbox and later challenge as separate declared stages", async () => {
  const source = await readFile(new URL("./yuanta-trade-statements.ts", import.meta.url), "utf8");
  assert.match(source, /yuanta-trade-captcha-checkbox/);
  assert.match(source, /yuanta-trade-captcha-challenge/);
  assert.match(source, /#chbYCaptchaV2/);
  assert.match(source, /#captchaModal, \.captcha-modal/);
  assert.match(source, /\[data-captcha-control\]/);
  assert.match(source, /completion: \{ mode: "independent", targetIds: \["captcha-checkbox"\] \}/);
  assert.match(source, /maxChallengeRetries = 2/);
});
