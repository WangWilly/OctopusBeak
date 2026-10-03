import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VERIFICATION_ACTOR,
  VERIFICATION_ACTORS,
  VERIFICATION_CONFIDENCE_THRESHOLD_KEYS,
  challengeConfidenceThreshold,
  effectiveVerificationActorForSourceKey,
} from "./verification-config.ts";

test("an App source with a verification actor key defaults to solver", () => {
  assert.equal(DEFAULT_VERIFICATION_ACTOR, "solver");
  assert.equal(
    effectiveVerificationActorForSourceKey("LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR", {
      isPackaged: false,
      env: {},
    }),
    "solver",
  );
  assert.equal(effectiveVerificationActorForSourceKey(undefined, {
    isPackaged: false,
    env: { LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR: "human" },
  }), "solver");
});

test("only unpackaged host launch environment can select manual verification", () => {
  assert.equal(
    effectiveVerificationActorForSourceKey("KEY", {
      isPackaged: false,
      env: { KEY: "human" },
    }),
    "human",
  );
  assert.equal(
    effectiveVerificationActorForSourceKey("KEY", {
      isPackaged: false,
      env: { KEY: "solver" },
    }),
    "solver",
  );
});

test("packaged builds ignore human process overrides", () => {
  assert.equal(
    effectiveVerificationActorForSourceKey("KEY", {
      isPackaged: true,
      env: { KEY: "human" },
    }),
    "solver",
  );
});

test("missing trusted package metadata fails closed to solver", () => {
  assert.equal(effectiveVerificationActorForSourceKey("KEY", {
    isPackaged: undefined,
    env: { KEY: "human" },
  } as unknown as Parameters<typeof effectiveVerificationActorForSourceKey>[1]), "solver");
});

test("unrecognized actor values fail closed to solver", () => {
  assert.equal(effectiveVerificationActorForSourceKey("KEY", {
    isPackaged: false,
    env: { KEY: "robot" },
  }), "solver");
  assert.equal(effectiveVerificationActorForSourceKey("KEY", {
    isPackaged: false,
    env: { KEY: " HUMAN ".toUpperCase() },
  }), "human");
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
