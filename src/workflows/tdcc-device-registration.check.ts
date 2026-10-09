import assert from "node:assert/strict";
import test from "node:test";
import { registerTdccDevice } from "./tdcc-device-registration.ts";
import { TDCC_BASE_URL, TdccClient, TdccError, type TdccOtpChannel } from "./tdcc-epassbook-client.ts";

const DETAILS = { userId: "TESTUSER01", password: "pw" };

function scenario(replies: Array<{ code?: string; body?: Record<string, unknown> }>) {
  const endpoints: string[] = [];
  const prompts: TdccOtpChannel[] = [];
  const fetch = async (url: string) => {
    endpoints.push(url.slice(TDCC_BASE_URL.length));
    const reply = replies.shift();
    assert.ok(reply, `unexpected request to ${url}`);
    return Response.json({
      responseHeader: { returnCode: reply.code ?? "0000" },
      responseBody: reply.body ?? {},
    });
  };
  const run = () => registerTdccDevice({
    client: new TdccClient({ identity: { deviceId: "0", devType: "Android:14", devModel: "SM-G991B" }, fetch }),
    details: DETAILS,
    readOtp: async (channel) => {
      prompts.push(channel);
      return channel === "email" ? "111111" : "222222";
    },
  });
  return { endpoints, prompts, run, remaining: replies };
}

test("a trusted device signs in without asking for a code", async () => {
  const flow = scenario([{ body: { tokenID: "t" } }, { body: { isDiffDevice: "N" } }]);
  assert.deepEqual(await flow.run(), { kind: "already-trusted" });
  assert.deepEqual(flow.endpoints, ["CM001", "AU001"]);
  assert.deepEqual(flow.prompts, []);
});

test("an untrusted device registers with the Email OTP alone", async () => {
  const flow = scenario([{}, { body: { isDiffDevice: "Y" } }, {}, { body: { isMobileValid: "Y" } }]);
  assert.deepEqual(await flow.run(), { kind: "registered", channels: ["email"] });
  assert.deepEqual(flow.endpoints, ["CM001", "AU001", "AU013", "AU015"]);
  assert.deepEqual(flow.prompts, ["email"]);
});

test("an unverified mobile number continues to the SMS OTP after the Email OTP", async () => {
  const flow = scenario([
    {},
    { code: "D0005" },
    {},
    { body: { isMobileValid: "N" } },
    {},
    { body: {} },
  ]);
  assert.deepEqual(await flow.run(), { kind: "registered", channels: ["email", "sms"] });
  assert.deepEqual(flow.endpoints, ["CM001", "AU001", "AU013", "AU015", "AU014", "AU015"]);
  assert.deepEqual(flow.prompts, ["email", "sms"]);
  assert.equal(flow.remaining.length, 0);
});

test("an expired code stops registration with the otp-expired reason", async () => {
  const flow = scenario([{}, { body: { isEmailValid: "N" } }, {}, { code: "V0017" }]);
  await assert.rejects(flow.run(), (error) =>
    error instanceof TdccError && error.failure.reason === "otp-expired");
  assert.deepEqual(flow.endpoints, ["CM001", "AU001", "AU013", "AU015"]);
});
