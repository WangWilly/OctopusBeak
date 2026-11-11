import assert from "node:assert/strict";
import test from "node:test";
import { projectAutomationBlock } from "./automation-block.ts";

test("an automation block carries only the fields its view renders", () => {
  const model = {
    automation: { active: false },
    credentialGroups: [{ id: "bank" }],
    runtimeSessionId: "session",
    runtimeRevision: 4,
    credentialState: { revision: 3 },
  };
  assert.deepEqual(projectAutomationBlock(model, "summary"), {
    route: "automation",
    block: "summary",
    data: { automation: model.automation, runtimeSessionId: "session", runtimeRevision: 4 },
  });
  for (const block of ["list", "details"] as const) {
    assert.deepEqual(projectAutomationBlock(model, block).data, {
      automation: model.automation,
      credentialGroups: model.credentialGroups,
      runtimeSessionId: "session",
      runtimeRevision: 4,
    }, `${block} adds credential groups and nothing else`);
  }
});
