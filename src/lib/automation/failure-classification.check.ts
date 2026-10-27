import assert from "node:assert/strict";
import test from "node:test";
import { CaptchaProviderRejectedError } from "./captcha-rejection.ts";
import { ExternalPrerequisiteUnavailableError } from "./external-prerequisite.ts";
import { classifyFailure, lastOperation, type FailureEvidence, type FailureEvidenceEvent } from "./failure-classification.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import { BrowserRuntimeConfigurationError } from "./server/browser-runtime.ts";
import { ProviderProtocolOutdatedError, SourceAccessChallengeError, SourceUnavailableError } from "./source-access.ts";
import { SourceTextIntegrityError } from "./source-text.ts";
import { FailureCodeError, type TypedWorkflowErrorCode } from "./workflow-failures.ts";

const at = (stage: FailureEvidenceEvent["stage"], outcome: FailureEvidenceEvent["outcome"] = "started"): FailureEvidenceEvent =>
  ({ stage, outcome });
const signal = (name: NonNullable<FailureEvidenceEvent["signal"]>): FailureEvidenceEvent =>
  ({ stage: "authentication", outcome: "failed", signal: name });
const timeout = Object.assign(new Error("private provider text"), { name: "TimeoutError" });
const untyped = new Error("contains private account 123");
const emptySummary = { status: "failed", sourceCaptureCount: 0, rowCount: 0, itemCount: 0, committedCount: 0, products: [] } as const;

const cases: ReadonlyArray<readonly [string, Partial<FailureEvidence>, TypedWorkflowErrorCode]> = [
  ["a missing solver route outranks a thrown error", { error: new SourceUnavailableError(), events: [signal("solver-route-unavailable")] }, "verification-configuration-failed"],
  ["a missing solver route outranks the worker's code", { reported: "verification-failed", events: [signal("solver-route-unavailable")] }, "verification-configuration-failed"],
  ["an unsupported challenge is a configuration failure", { events: [signal("solver-challenge-unsupported")] }, "verification-configuration-failed"],

  ["a Failure code error keeps its code", { error: new FailureCodeError("device-registration-required") }, "device-registration-required"],
  ["an interrupted product run keeps its code", { error: new ProductCollectionInterruptedError("collection-scope-changed", emptySummary) }, "collection-scope-changed"],
  ["browser runtime configuration", { error: new BrowserRuntimeConfigurationError("unsupported-profile") }, "browser-runtime-config-failed"],
  ["source text integrity", { error: new SourceTextIntegrityError("invalid-encoding") }, "source-integrity-failed"],
  ["source access challenge", { error: new SourceAccessChallengeError() }, "source-access-challenged"],
  ["source unavailable", { error: new SourceUnavailableError() }, "source-unavailable"],
  ["provider protocol outdated during sign-in", { error: new ProviderProtocolOutdatedError(), events: [at("authentication")] }, "provider-protocol-outdated"],
  ["external prerequisite", { error: new ExternalPrerequisiteUnavailableError("yuanta-servisign"), events: [at("authentication")] }, "external-prerequisite-unavailable"],
  ["CAPTCHA provider rejection", { error: new CaptchaProviderRejectedError() }, "captcha-provider-rejected"],
  ["a thrown error outranks a stop", { error: new CaptchaProviderRejectedError(), stopped: true }, "captcha-provider-rejected"],
  ["a thrown error outranks an exhausted solver", { error: new CaptchaProviderRejectedError(), events: [signal("verification-solver-exhausted")] }, "captcha-provider-rejected"],
  ["a thrown error outranks a reported stage", { error: new SourceUnavailableError(), events: [at("validation", "failed")] }, "source-unavailable"],
  ["the worker's code outranks the host's events", { reported: "source-access-challenged", events: [at("validation", "failed")] }, "source-access-challenged"],

  ["a stop names an untyped error", { error: timeout, events: [at("authentication"), at("finalization", "failed")], stopped: true }, "cancelled"],
  ["a stop outranks an exhausted solver", { events: [signal("verification-solver-exhausted")], stopped: true }, "cancelled"],

  ["an exhausted solver", { error: untyped, events: [signal("verification-solver-exhausted")] }, "verification-failed"],
  ["failed human assistance", { events: [signal("human-assistance-failed")] }, "verification-failed"],

  ["a failed decoding stage", { error: untyped, events: [at("decoding", "failed"), at("collection")] }, "source-integrity-failed"],
  ["a failed validation stage", { error: untyped, events: [at("validation", "failed")] }, "source-validation-failed"],
  ["decoding outranks validation", { events: [at("validation", "failed"), at("decoding", "failed")] }, "source-integrity-failed"],

  ["a sign-in timeout", { error: timeout, events: [at("commit"), at("authentication"), at("finalization", "failed")] }, "authentication-timeout"],
  ["an interrupting sign-in dialog", { events: [signal("login-dialog-interrupted")] }, "authentication-dialog-interrupted"],
  ["an untyped sign-in failure", { error: untyped, events: [at("collection"), at("authentication")] }, "authentication-failed"],
  ["an untyped collection failure", { error: untyped, events: [at("authentication"), at("collection")] }, "source-collection-failed"],
  ["an untyped failure while decoding", { error: untyped, events: [at("decoding")] }, "source-collection-failed"],
  ["the last operation, not the first", { error: timeout, events: [at("authentication"), at("preparation"), at("finalization", "failed")] }, "workflow-failed"],
  // ADR 0056: commit stage events report progress; only Commit attempts decide the commit outcome.
  ["a failed commit stage", { error: untyped, events: [at("commit", "failed")] }, "workflow-failed"],

  ["no evidence", { error: untyped }, "workflow-failed"],
];

test("Failure classification names the first matching evidence (ADR 0068)", () => {
  for (const [name, evidence, expected] of cases) {
    assert.equal(classifyFailure({ events: [], stopped: false, ...evidence }), expected, name);
  }
});

test("the last operation skips finalization", () => {
  assert.equal(lastOperation([at("authentication"), at("collection"), at("finalization", "failed")])?.stage, "collection");
  assert.equal(lastOperation([at("finalization", "failed")]), undefined);
});
