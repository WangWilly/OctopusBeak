import assert from "node:assert/strict";
import test from "node:test";
import {
  VERIFICATION_CONFIDENCE_THRESHOLD_KEYS,
  challengeConfidenceThreshold,
} from "./verification-config.ts";

test("challenge confidence thresholds are read per challenge kind", () => {
  const settings = {
    [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "0.9",
    [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["image-selection"]]: "0.75",
  };
  assert.equal(challengeConfidenceThreshold(settings, "text-captcha"), 0.9);
  assert.equal(challengeConfidenceThreshold(settings, "image-selection"), 0.75);
});

test("a missing or malformed threshold reads as unset", () => {
  assert.equal(challengeConfidenceThreshold({}, "text-captcha"), undefined);
  assert.equal(
    challengeConfidenceThreshold({
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "not-a-number",
    }, "text-captcha"),
    undefined,
  );
  assert.equal(
    challengeConfidenceThreshold({
      [VERIFICATION_CONFIDENCE_THRESHOLD_KEYS["text-captcha"]]: "",
    }, "text-captcha"),
    undefined,
  );
});
