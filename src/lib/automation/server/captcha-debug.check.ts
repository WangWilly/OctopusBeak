import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTCHA_DEBUG_ENV,
  captchaDebugEnabled,
  openCaptchaDebugSession,
} from "./captcha-debug.ts";

test("captcha debug is off by default and enabled by the env flag", () => {
  assert.equal(captchaDebugEnabled({}), false);
  assert.equal(captchaDebugEnabled({ [CAPTCHA_DEBUG_ENV]: "1" }), true);
  assert.equal(captchaDebugEnabled({ [CAPTCHA_DEBUG_ENV]: "true" }), true);
  assert.equal(captchaDebugEnabled({ [CAPTCHA_DEBUG_ENV]: "0" }), false);
});

test("openCaptchaDebugSession returns null when the flag is unset", () => {
  assert.equal(openCaptchaDebugSession({}), null);
});

test("openCaptchaDebugSession writes images and the parsed result", () => {
  const dir = mkdtempSync(join(tmpdir(), "captcha-debug-"));
  const originalError = console.error;
  console.error = () => {};
  try {
    const session = openCaptchaDebugSession(
      { [CAPTCHA_DEBUG_ENV]: "1" },
      dir,
      () => 42,
    );
    assert.ok(session);
    session.writeImage("raw", Buffer.from("raw-image"));
    session.writeImage("denoised", Buffer.from("denoised-image"));
    session.writeResult("A1B2", 0.88);
    const attemptDir = join(dir, "42-0");
    assert.equal(readFileSync(join(attemptDir, "raw.png"), "utf8"), "raw-image");
    assert.equal(
      readFileSync(join(attemptDir, "denoised.png"), "utf8"),
      "denoised-image",
    );
    assert.match(
      readFileSync(join(attemptDir, "result.jsonl"), "utf8"),
      /"text":"A1B2"/,
    );
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});
