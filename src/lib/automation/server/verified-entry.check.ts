import assert from "node:assert/strict";
import test from "node:test";
import { FailureCodeError } from "../workflow-failures.ts";
import type { WorkflowContextWith } from "../workflow-executor.ts";
import { field, type VerifiedSource } from "./sources/verified-source.ts";
import { runVerifiedEntry, verifiedRunInput, type VerifiedWorkflowEntry } from "./verified-entry.ts";

const SOURCE = {
  label: "Check bank",
  credentialFields: [
    field("LIBRETTO_CLOUD_CHECK_USER_ID", "User ID", "使用者代號"),
    field("LIBRETTO_CLOUD_CHECK_PASSWORD", "Password", "密碼", "password", "none", { trim: false }),
  ],
  statementSelection: { key: "LIBRETTO_CLOUD_CHECK_STATEMENT_TYPES", products: [{ id: "deposit", stream: "domestic-deposit" }] },
  workflow: {
    input: { credentials: true, statementTypes: true },
    attachedPreviewProducts: { sourceId: "check", institution: "hncb", products: ["credit_card"] },
  },
} as unknown as VerifiedSource;

const credentials = { check_user_id: "  user  ", check_password: "  pass  " };

test("each credential is required, trimmed unless its field keeps whitespace", () => {
  const verified = verifiedRunInput(SOURCE, { credentials, statementTypes: ["deposit"] });
  assert.deepEqual(verified.credentials, { check_user_id: "user", check_password: "  pass  " });
  assert.deepEqual(verified.attachedPreviewProducts, []);
  for (const missing of [
    { ...credentials, check_user_id: "   " },
    { check_password: "pass" },
    { ...credentials, check_password: "" },
    { ...credentials, check_user_id: 7 },
  ]) {
    assert.throws(
      () => verifiedRunInput(SOURCE, { credentials: missing, statementTypes: ["deposit"] }),
      /^Error: Check bank sign-in detail is missing: (User ID|Password)\.$/u,
    );
  }
});

test("a missing credential's message names the field and never its value", () => {
  assert.throws(
    () => verifiedRunInput(SOURCE, { credentials: { check_user_id: "secret-user", check_password: "" }, statementTypes: ["deposit"] }),
    (error: unknown) => error instanceof Error && !error.message.includes("secret-user") && error.message.includes("Password"),
  );
});

test("a source without credential input checks no credentials", () => {
  const tdccLike = { ...SOURCE, workflow: { input: { statementTypes: true } } } as unknown as VerifiedSource;
  assert.deepEqual(verifiedRunInput(tdccLike, { statementTypes: ["deposit"] }).credentials, {});
});

test("an empty selection is a scope change, while an attached-only selection runs", () => {
  assert.throws(
    () => verifiedRunInput(SOURCE, { credentials, statementTypes: [], attachedPreviewProducts: [] }),
    (error: unknown) => error instanceof FailureCodeError && error.errorCode === "collection-scope-changed",
  );
  assert.deepEqual(
    verifiedRunInput(SOURCE, { credentials, statementTypes: [], attachedPreviewProducts: ["credit_card"] }).attachedPreviewProducts,
    ["credit_card"],
  );
  assert.throws(
    () => verifiedRunInput(SOURCE, { credentials, statementTypes: ["loan"] }),
    /selects a product it does not offer/u,
  );
  for (const unoffered of ["loan", "nonsense"]) {
    assert.throws(
      () => verifiedRunInput(SOURCE, { credentials, statementTypes: ["deposit"], attachedPreviewProducts: [unoffered] }),
      /attached preview product it does not offer/u,
    );
  }
});

function entryContext(signal = new AbortController().signal) {
  const events: string[] = [];
  const context = {
    signal,
    event: async (_stage: string, _outcome: string, code: string) => { events.push(code); },
  } as unknown as WorkflowContextWith<"products">;
  return { context, events };
}

test("the entry parses after the shared checks, reports input-validated, then runs", async () => {
  const steps: string[] = [];
  const { context, events } = entryContext();
  const entry: VerifiedWorkflowEntry<"products", { filters: string[] }, void> = {
    parseInput(verified, raw) {
      steps.push(`parse ${verified.credentials.check_user_id} ${events.length}`);
      return { filters: raw.filters as string[] };
    },
    async run(_context, input) {
      steps.push(`run ${input.filters.join(",")} ${events.join(",")}`);
    },
  };
  await runVerifiedEntry(SOURCE, entry, context, { credentials, statementTypes: ["deposit"], filters: ["a"] });
  assert.deepEqual(steps, ["parse user 0", "run a input-validated"]);
});

test("a rejected parse, missing credential, or cancellation never reports input-validated or runs", async () => {
  let ran = false;
  const entry: VerifiedWorkflowEntry<"products", null, void> = {
    parseInput: () => { throw new Error("bad filters"); },
    async run() { ran = true; },
  };
  const rejected = entryContext();
  await assert.rejects(runVerifiedEntry(SOURCE, entry, rejected.context, { credentials, statementTypes: ["deposit"] }), /bad filters/u);
  const missing = entryContext();
  await assert.rejects(runVerifiedEntry(SOURCE, { ...entry, parseInput: () => null }, missing.context, { statementTypes: ["deposit"] }), /sign-in detail is missing/u);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const cancelled = entryContext(controller.signal);
  await assert.rejects(runVerifiedEntry(SOURCE, { ...entry, parseInput: () => null }, cancelled.context, { credentials, statementTypes: ["deposit"] }), /cancelled/u);
  assert.equal(ran, false);
  assert.deepEqual([...rejected.events, ...missing.events, ...cancelled.events], []);
});
