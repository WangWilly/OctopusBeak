import assert from "node:assert/strict";
import test from "node:test";
import type { CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import {
  createCathayGmailOtpPort,
  type CathayGmailOtpHostOperations,
} from "./cathay-otp-port.ts";

function operations(overrides: Partial<CathayGmailOtpHostOperations> = {}): CathayGmailOtpHostOperations {
  return {
    async ensureAccess() { return { status: "ready" }; },
    async prepareRetrieval() { return { status: "prepared", boundaryId: "7d3e1a6b-abc1-4c34-8def-0987654321ab" }; },
    async retrieve() { return { status: "found", otp: "ABCD-123456" }; },
    ...overrides,
  };
}

test("App OTP adapter preserves ready, prepared and found operations", async () => {
  const calls: string[] = [];
  const otp: CathayGmailOtpPort = createCathayGmailOtpPort(operations({
    async ensureAccess() { calls.push("ensure"); return { status: "ready" }; },
    async prepareRetrieval() { calls.push("prepare"); return { status: "prepared", boundaryId: "7d3e1a6b-abc1-4c34-8def-0987654321ab" }; },
    async retrieve(id) { calls.push(`retrieve:${id}`); return { status: "found", otp: "ABCD-123456" }; },
  }));

  assert.deepEqual(await otp.ensureAccess(), { status: "ready" });
  const boundary = await otp.prepareRetrieval();
  assert.deepEqual(boundary, { status: "prepared", boundaryId: "7d3e1a6b-abc1-4c34-8def-0987654321ab" });
  if (boundary.status !== "prepared") assert.fail("expected prepared boundary");
  assert.deepEqual(await otp.retrieve(boundary.boundaryId), { status: "found", otp: "ABCD-123456" });
  assert.deepEqual(calls, ["ensure", "prepare", `retrieve:${boundary.boundaryId}`]);
});

test("App OTP adapter preserves only bounded service fallback reasons", async () => {
  const otp = createCathayGmailOtpPort(operations({
    async ensureAccess() {
      return {
        status: "fallback",
        reason: "authorization-cancelled",
        refreshToken: "must-not-cross-the-adapter",
        credentialsPath: "/private/credentials.json",
      } as never;
    },
    async prepareRetrieval() { return { status: "fallback", reason: "ambiguous-candidate" }; },
  }));
  assert.deepEqual(await otp.ensureAccess(), { status: "fallback", reason: "authorization-cancelled" });
  assert.deepEqual(await otp.prepareRetrieval(), { status: "fallback", reason: "ambiguous-candidate" });
  assert.doesNotMatch(JSON.stringify(await otp.ensureAccess()), /must-not-cross|credentials\.json/);
});

test("App OTP adapter sanitizes thrown errors and malformed host outcomes", async () => {
  const leakedSecret = "refresh-token-private-value at /private/credentials.json";
  const otp = createCathayGmailOtpPort(operations({
    async ensureAccess() { throw new Error(`failed with ${leakedSecret}`); },
    async prepareRetrieval() { return { status: "fallback", reason: leakedSecret } as never; },
  }));
  const access = await otp.ensureAccess();
  const preparation = await otp.prepareRetrieval();
  assert.deepEqual(access, { status: "fallback", reason: "authorization-failed" });
  assert.deepEqual(preparation, { status: "fallback", reason: "protocol-error" });
  assert.doesNotMatch(JSON.stringify([access, preparation]), /refresh-token-private-value|credentials\.json/);
});

test("App OTP adapter consumes a prepared boundary once", async () => {
  let retrievalCount = 0;
  const otp = createCathayGmailOtpPort(operations({
    async retrieve() {
      retrievalCount += 1;
      return { status: "found", otp: "ABCD-123456" };
    },
  }));
  const boundary = await otp.prepareRetrieval();
  if (boundary.status !== "prepared") assert.fail("expected prepared boundary");
  assert.deepEqual(await otp.retrieve(boundary.boundaryId), { status: "found", otp: "ABCD-123456" });
  assert.deepEqual(await otp.retrieve(boundary.boundaryId), { status: "fallback", reason: "protocol-error" });
  assert.equal(retrievalCount, 1);
});

test("App OTP adapter rejects invalid boundary identifiers and malformed OTP values", async () => {
  const otp = createCathayGmailOtpPort(operations({
    async prepareRetrieval() { return { status: "prepared", boundaryId: "not-a-boundary" }; },
    async retrieve() { return { status: "found", otp: "private mailbox text" }; },
  }));
  assert.deepEqual(await otp.prepareRetrieval(), { status: "fallback", reason: "protocol-error" });
  assert.deepEqual(await otp.retrieve("not-a-boundary"), { status: "fallback", reason: "protocol-error" });
  assert.equal(JSON.stringify(await otp.retrieve("not-a-boundary")).includes("private mailbox text"), false);
});
