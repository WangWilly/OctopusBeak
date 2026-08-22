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

const sharedProviderAssistanceWorkflows = new Set([
  "yuanta-statements.ts",
  "yuanta-credit-card-statements.ts",
  "yuanta-loan-statements.ts",
  "yuanta-fund-statements.ts",
  "yuanta-foreign-currency-statements.ts",
]);

test("all modelable human-assisted workflows publish a contract-backed stage", async () => {
  const sources = await Promise.all(
    providerWorkflows.map(
      async (file) =>
        [
          file,
          await readFile(new URL(`./${file}`, import.meta.url), "utf8"),
        ] as const,
    ),
  );
  const sharedYuantaAuth = await readFile(
    new URL("./yuanta-auth.ts", import.meta.url),
    "utf8",
  );
  for (const [file, source] of sources) {
    const focusSource = sharedProviderAssistanceWorkflows.has(file)
      ? sharedYuantaAuth
      : source;
    assert.match(
      focusSource,
      /emitHumanAssistanceStage/,
      `${file} must publish a human assistance stage`,
    );
    assert.doesNotMatch(
      focusSource,
      /human-assistance-contract:\s*\{[^}]*captcha/i,
      `${file} must not put raw CAPTCHA data in a contract signal`,
    );
  }
});

test("provider verification focus keeps the challenge readable", async () => {
  const sources = await Promise.all(
    providerWorkflows.map(
      async (file) =>
        [
          file,
          await readFile(new URL(`./${file}`, import.meta.url), "utf8"),
        ] as const,
    ),
  );
  const sharedYuantaAuth = await readFile(
    new URL("./yuanta-auth.ts", import.meta.url),
    "utf8",
  );
  const violations: string[] = [];
  for (const [file, source] of sources) {
    const focusSource = sharedProviderAssistanceWorkflows.has(file)
      ? sharedYuantaAuth
      : source;
    const zooms = [
      ...focusSource.matchAll(/initialZoom:\s*([0-9]+(?:\.[0-9]+)?)/g),
    ].map((match) => Number(match[1]));
    if (zooms.length === 0) violations.push(`${file}: missing focus zoom`);
    if (zooms.some((zoom) => zoom > 1.25)) {
      violations.push(`${file}: ${zooms.join(", ")}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "provider verification focus must keep the challenge readable",
  );
});

test("inline verification stages re-check the declared field before continuing", async () => {
  const sources = await Promise.all(
    providerWorkflows.map(
      async (file) =>
        [
          file,
          await readFile(new URL(`./${file}`, import.meta.url), "utf8"),
        ] as const,
    ),
  );
  const missingInputChecks = sources
    .filter(([, source]) => source.includes('completion: { mode: "inline"'))
    .filter(([, source]) => !source.includes("inputValue()).trim()"))
    .map(([file]) => file);
  assert.deepEqual(
    missingInputChecks,
    [],
    "inline verification must confirm the declared field is non-empty after Assist Resume",
  );
});

test("Yuanta Trade keeps checkbox and later challenge as separate declared stages", async () => {
  const [source, captchaSelectors] = await Promise.all([
    readFile(new URL("./yuanta-trade-statements.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../lib/automation/yuanta-trade-captcha.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(source, /yuanta-trade-captcha-checkbox/);
  assert.match(source, /yuanta-trade-captcha-challenge/);
  assert.match(source, /\.check-area/);
  assert.match(
    source,
    /from "\.\.\/lib\/automation\/yuanta-trade-captcha\.ts"/,
  );
  assert.match(
    captchaSelectors,
    /#modalYCaptchaV2, #captchaModal, \.captcha-modal/,
  );
  assert.match(captchaSelectors, /\.y-captcha-image:visible/);
  assert.match(
    source,
    /completion: \{ mode: "independent", targetIds: challengeTargets\.map/,
  );
  assert.match(source, /maxChallengeRetries = 2/);
});
