import assert from "node:assert/strict";
import test from "node:test";

import {
  canResumeAssist,
  settleAssistDrag,
  settleAssistTextSubmission,
  shouldGuideAssistViewer,
} from "./assist-interaction.ts";
import type { HumanAssistanceCompletion } from "./human-assistance.ts";

const completion = (
  mode: HumanAssistanceCompletion["mode"],
  status: HumanAssistanceCompletion["status"],
): HumanAssistanceCompletion => ({ mode, status, targetIds: ["challenge"] });

test("failed Assist submission keeps the draft retryable and success clears it", () => {
  const draft = "  challenge answer  ";
  assert.deepEqual(settleAssistTextSubmission(draft, false), {
    floatingInput: draft,
    assistInteracted: false,
  });
  assert.deepEqual(settleAssistTextSubmission(draft, true), {
    floatingInput: null,
    assistInteracted: true,
  });
});

test("inline Assist resumes only after a successful entered completion", () => {
  const entered = completion("inline", "entered");
  assert.equal(canResumeAssist(true, false, entered), true);
  assert.equal(canResumeAssist(false, false, entered), false);
  assert.equal(canResumeAssist(true, true, entered), false);
  assert.equal(canResumeAssist(true, false, completion("inline", "failed")), false);
  assert.equal(canResumeAssist(true, false, null), false);
});

test("independent Assist requires verification while inline guidance waits for entry", () => {
  assert.equal(shouldGuideAssistViewer(false, false, completion("independent", "entered")), true);
  assert.equal(shouldGuideAssistViewer(true, false, completion("independent", "verified")), false);
  assert.equal(shouldGuideAssistViewer(false, false, completion("inline", "entered")), false);
  assert.equal(shouldGuideAssistViewer(false, false, completion("inline", "pending")), true);
  assert.equal(shouldGuideAssistViewer(false, true, completion("inline", "pending")), false);
});

test("a drag is settled only when the viewer operation succeeds", () => {
  assert.equal(settleAssistDrag(false), false);
  assert.equal(settleAssistDrag(true), true);
});
