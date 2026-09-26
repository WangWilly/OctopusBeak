import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VERIFICATION_ACTOR,
  VERIFICATION_ACTORS,
  VERIFICATION_CONFIDENCE_THRESHOLD_KEYS,
  challengeConfidenceThreshold,
  verificationActorForSource,
} from "./verification-config.ts";

test("an App source with a verification actor key defaults to solver", () => {
  assert.equal(DEFAULT_VERIFICATION_ACTOR, "solver");
  assert.equal(
    verificationActorForSource("LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR", {}),
    "solver",
  );
  assert.equal(verificationActorForSource(undefined, {}), "solver");
});

test("an explicitly configured actor is read back", () => {
  assert.equal(
    verificationActorForSource("KEY", { KEY: "human" }),
    "human",
  );
  assert.equal(
    verificationActorForSource("KEY", { KEY: "solver" }),
    "solver",
  );
});

test("an unrecognized actor value falls back to solver", () => {
  assert.equal(
    verificationActorForSource("KEY", { KEY: "robot" }),
    "solver",
  );
  assert.equal(
    verificationActorForSource("KEY", { KEY: "SOLVER" }),
    "solver",
  );
});

test("only human and solver are valid verification actors", () => {
  assert.deepEqual(VERIFICATION_ACTORS, ["human", "solver"]);
});

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
