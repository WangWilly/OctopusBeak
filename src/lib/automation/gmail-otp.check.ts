import assert from "node:assert/strict";
import test from "node:test";
import {
  GMAIL_OTP_MAX_FRAME_BYTES,
  createGmailOtpFrameParser,
  gmailOtpRequestFrame,
  gmailOtpResponseFrame,
  gmailOtpFallbackReason,
  parseGmailOtpRequestFrame,
  parseGmailOtpResponseFrame,
} from "./gmail-otp.ts";

const id = "01234567-89ab-cdef-0123-456789abcdef";

test("Gmail bridge frames accept bounded requests and responses only", () => {
  const request = { id, method: "retrieve" as const, boundaryId: id };
  assert.deepEqual(parseGmailOtpRequestFrame(gmailOtpRequestFrame(request)), request);
  assert.deepEqual(
    parseGmailOtpRequestFrame(gmailOtpRequestFrame({ id, method: "prepare-retrieval" })),
    { id, method: "prepare-retrieval" },
  );
  const response = { id, status: "found" as const, otp: "ABCD-123456" };
  assert.deepEqual(parseGmailOtpResponseFrame(gmailOtpResponseFrame(response)), response);
  assert.deepEqual(
    parseGmailOtpResponseFrame(gmailOtpResponseFrame({ id, status: "prepared", boundaryId: id })),
    { id, status: "prepared", boundaryId: id },
  );
  assert.equal(parseGmailOtpRequestFrame(JSON.stringify({ id, method: "retrieve", boundaryId: "invalid" })), null);
  assert.equal(parseGmailOtpResponseFrame(JSON.stringify({ id, status: "found", otp: "ABCD-12345" })), null);
  assert.equal(parseGmailOtpResponseFrame("x".repeat(GMAIL_OTP_MAX_FRAME_BYTES + 1)), null);
  assert.throws(
    () => gmailOtpResponseFrame({ id, status: "found", otp: "secret" }),
    /answer is invalid/,
  );
});

test("Gmail bridge parser handles fragmented frames and counts invalid frames", () => {
  const values: unknown[] = [];
  const parser = createGmailOtpFrameParser(
    (value) => values.push(value),
    parseGmailOtpRequestFrame,
  );
  const frame = gmailOtpRequestFrame({ id, method: "ensure-access" });
  parser.push(frame.slice(0, 7));
  parser.push(frame.slice(7));
  parser.push("not-json\n");
  parser.flush();
  assert.deepEqual(values, [{ id, method: "ensure-access" }]);
  assert.equal(parser.invalidFrameCount(), 1);
});

test("Gmail fallback diagnostics expose only allowlisted reason codes", () => {
  assert.equal(gmailOtpFallbackReason({ status: "fallback", reason: "gmail-request-failed" }), "gmail-request-failed");
  assert.equal(gmailOtpFallbackReason({ status: "fallback", reason: "unauthenticated-hme-relay-signature" }), "unauthenticated-hme-relay-signature");
  assert.equal(gmailOtpFallbackReason({ status: "fallback", reason: "secret mailbox response" }), null);
  assert.equal(gmailOtpFallbackReason({ status: "found", reason: "timeout" }), null);
  assert.equal(gmailOtpFallbackReason(new Error("contains a token")), null);
});
