import assert from "node:assert/strict";
import test from "node:test";
import { FIRST_OVERVIEW_STORY, onboardingNodePresentation } from "./story.ts";

test("a resumed node opens the credentials sheet the way returning to it does", () => {
  const id = FIRST_OVERVIEW_STORY.id;
  assert.equal(onboardingNodePresentation(id, "source-selection"), "show-picker", "step 2 points into the source picker");
  assert.equal(onboardingNodePresentation(id, "credentials"), "show-details", "step 3 points into the source's details");
  assert.equal(onboardingNodePresentation(id, "source-entry"), "close-credentials", "step 1 points at the closed sheet's button");
  assert.equal(onboardingNodePresentation(id, "complete"), "none");
  assert.equal(onboardingNodePresentation("another-story", "credentials"), "none");
});
