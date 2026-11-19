import assert from "node:assert/strict";
import test from "node:test";
import { activeSectionAt } from "./section-spy.ts";

const sections = (...tops: number[]) => tops.map((top, index) => ({ id: `s${index}`, top }));

test("the active section is the last one whose top reached the reading line", () => {
  assert.equal(activeSectionAt(sections(70, 360, 600, 900), 120, false), "s0", "at the top the first section is active, though the next is in view");
  assert.equal(activeSectionAt(sections(-400, -100, 110, 500), 120, false), "s2");
  assert.equal(activeSectionAt(sections(-900, -600, -300, 400), 120, false), "s2", "a section stays active while it fills the view");
  assert.equal(activeSectionAt(sections(200, 500), 120, false), "s0", "before any section reaches the line, the first is active");
});

test("at the end of the page the last section is active, even when it is short", () => {
  assert.equal(activeSectionAt(sections(-900, -600, 300, 600), 120, true), "s3");
  assert.equal(activeSectionAt([], 120, true), null);
});
