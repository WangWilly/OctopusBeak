import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CAPTCHA_DEBUG_ENV = "OCTOPUSBEAK_CAPTCHA_DEBUG";

export function captchaDebugEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[CAPTCHA_DEBUG_ENV];
  return value === "1" || value === "true";
}

export type CaptchaDebugSession = {
  writeImage(name: string, buffer: Buffer): void;
  writeResult(text: string, confidence: number): void;
};

let debugAttempt = 0;

export function openCaptchaDebugSession(
  env: NodeJS.ProcessEnv = process.env,
  baseDir = "data/captcha-debug",
  now: () => number = Date.now,
): CaptchaDebugSession | null {
  if (!captchaDebugEnabled(env)) return null;
  const dir = join(baseDir, `${now()}-${debugAttempt++}`);
  mkdirSync(dir, { recursive: true });
  return {
    writeImage(name, buffer) {
      writeFileSync(join(dir, `${name}.png`), buffer);
    },
    writeResult(text, confidence) {
      const line = JSON.stringify({
        text,
        confidence,
        at: new Date().toISOString(),
      });
      appendFileSync(join(dir, "result.jsonl"), `${line}\n`);
      console.error("captcha-debug", { dir, text, confidence });
    },
  };
}
