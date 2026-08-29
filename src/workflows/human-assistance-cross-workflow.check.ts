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

const solverBackedCaptchaWorkflows = [
  { provider: "Fubon", source: "../workflows/fubon-auth.ts" },
  { provider: "Yuanta Bank", source: "../workflows/yuanta-auth.ts" },
  { provider: "HNCB", source: "../workflows/hncb-statements.ts" },
  { provider: "Chunghwa Post", source: "../workflows/post-statements.ts" },
  { provider: "SinoPac", source: "../workflows/sinopac-statements.ts" },
  { provider: "E-Invoice", source: "../workflows/einvoice-personal-invoices.ts" },
] as const;

const explicitlyExcludedCaptchaWorkflows = [
  {
    provider: "Yuanta Trade",
    source: "../workflows/yuanta-trade-statements.ts",
    reason: "checkbox and image-selection remain human-assisted",
  },
  {
    provider: "Cathay United Bank",
    source: "../workflows/cathay-statements.ts",
    reason: "Email OTP remains human-assisted",
  },
] as const;

function rechecksInlineVerificationInput(source: string): boolean {
  if (source.includes("inputValue()).trim()")) return true;

  const assignedInputValue =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[\s\S]{0,400}?\.inputValue\(\)[\s\S]{0,120}?;/g;
  for (const match of source.matchAll(assignedInputValue)) {
    const valueName = match[1];
    if (!valueName || match.index === undefined) continue;
    const continuation = source.slice(
      match.index + match[0].length,
      match.index + match[0].length + 240,
    );
    const escapedValueName = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`if\\s*\\(\\s*!${escapedValueName}\\.trim\\(\\)\\s*\\)`).test(
        continuation,
      )
    ) {
      return true;
    }
  }
  return false;
}

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

test("solver-backed CAPTCHA workflow contract is explicit and excludes human flows", async () => {
  const solverSources = await Promise.all(
    solverBackedCaptchaWorkflows.map(async ({ provider, source }) => ({
      provider,
      source,
      content: await readFile(new URL(source, import.meta.url), "utf8"),
    })),
  );
  assert.deepEqual(
    solverSources.map(({ provider }) => provider),
    ["Fubon", "Yuanta Bank", "HNCB", "Chunghwa Post", "SinoPac", "E-Invoice"],
  );
  for (const { provider, content } of solverSources) {
    assert.match(
      content,
      /challengeKind:\s*["']text-captcha["']/,
      `${provider} must declare the text CAPTCHA consumed by the local solver`,
    );
    assert.match(
      content,
      /challengeImageRegion:/,
      `${provider} must expose a challenge image region to the local solver`,
    );
  }

  const excludedSources = await Promise.all(
    explicitlyExcludedCaptchaWorkflows.map(async ({ provider, source, reason }) => ({
      provider,
      reason,
      content: await readFile(new URL(source, import.meta.url), "utf8"),
    })),
  );
  const solverSourcePaths = new Set<string>(
    solverBackedCaptchaWorkflows.map(({ source }) => source),
  );
  for (const { provider, reason, content } of excludedSources) {
    assert.ok(
      !content.includes("challengeKind: \"text-captcha\""),
      `${provider} must remain outside the solver-backed workflow table (${reason})`,
    );
  }
  for (const { provider, source, reason } of explicitlyExcludedCaptchaWorkflows) {
    assert.equal(
      solverSourcePaths.has(source),
      false,
      `${provider} must remain outside the solver-backed workflow table (${reason})`,
    );
  }
  const yuantaTrade = excludedSources.find(({ provider }) => provider === "Yuanta Trade");
  assert.ok(yuantaTrade);
  assert.match(yuantaTrade.content, /challengeKind:\s*["']checkbox["']/);
  assert.match(yuantaTrade.content, /challengeKind:\s*["']image-selection["']/);
  const cathay = excludedSources.find(({ provider }) => provider === "Cathay United Bank");
  assert.ok(cathay);
  assert.doesNotMatch(cathay.content, /challengeKind:\s*["']text-captcha["']/);
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
    .filter(([, source]) => !rechecksInlineVerificationInput(source))
    .map(([file]) => file);
  assert.deepEqual(
    missingInputChecks,
    [],
    "inline verification must confirm the declared field is non-empty after Assist Resume",
  );
});

test("inline verification check recognizes a deadline-wrapped value probe", () => {
  assert.equal(
    rechecksInlineVerificationInput(`
      const currentValue = await withDeadline(
        "completion probe",
        currentInput.inputValue(),
      );
      if (!currentValue.trim()) throw new Error("empty");
    `),
    true,
  );
  assert.equal(
    rechecksInlineVerificationInput(`
      const currentValue = await withDeadline(
        "completion probe",
        currentInput.inputValue(),
      );
      submit();
    `),
    false,
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

test("Yuanta Trade declares a checkbox click and a solver image-selection challenge", async () => {
  const source = await readFile(
    new URL("./yuanta-trade-statements.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /challengeKind: "checkbox"/);
  assert.match(source, /challengeKind: "image-selection"/);
  assert.match(source, /challengeImageRegion/);
  assert.match(source, /prompt:/);
});
