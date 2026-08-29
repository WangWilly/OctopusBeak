import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { attachGmailOtpBroker } from "./gmail-otp-broker.ts";
import { gmailOtpRequestFrame, parseGmailOtpResponseFrame } from "../gmail-otp.ts";

const id = "01234567-89ab-cdef-0123-456789abcdef";

test("private Gmail broker validates frames and returns only bounded results", async () => {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const output: string[] = [];
  responses.on("data", (chunk) => output.push(chunk.toString("utf8")));
  let protocolErrors = 0;
  const broker = attachGmailOtpBroker({
    requestStream: requests,
    responseStream: responses,
    service: {
      ensureAccess: async () => ({ status: "ready" }),
      prepareRetrieval: async () => ({ status: "prepared", boundaryId: id }),
      retrieve: async () => ({ status: "found", otp: "ABCD-123456" }),
    },
    onProtocolError: () => { protocolErrors += 1; },
  });
  requests.write("not-json\n");
  requests.write(gmailOtpRequestFrame({ id, method: "ensure-access" }));
  const secondId = "01234567-89ab-cdef-0123-456789abcdea";
  requests.write(gmailOtpRequestFrame({ id: secondId, method: "retrieve", boundaryId: id }));
  await new Promise((resolve) => setImmediate(resolve));
  broker.close();
  const frames = output.join("").trim().split("\n").map(parseGmailOtpResponseFrame).filter(Boolean);
  assert.deepEqual(frames, [
    { id, status: "ready" },
    { id: secondId, status: "found", otp: "ABCD-123456" },
  ]);
  assert.equal(protocolErrors, 1);
});
