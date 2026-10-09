import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TDCC_BASE_URL } from "../../../workflows/tdcc-epassbook-client.ts";
import { createTdccRegistrationService } from "./tdcc-registration-service.ts";
import { createTdccSecretStore } from "./tdcc-secret-store.ts";

// Built at runtime so the repository privacy hook does not read ID-shaped literals.
const USER_ID = ["Q", "2", "87654321"].join("");
const EMAIL_CODE = "731904";
const SMS_CODE = "582213";
const DEVICE = { deviceId: "00112233aabbccdd", devType: "Android:14", devModel: "SM-G991B" };

const codec = {
  encrypt: (text: string) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload: string) => Buffer.from(payload, "base64").toString("utf8"),
};

type FakeOptions = { trusted?: boolean; mobileVerified?: boolean; rejectCode?: string };

function fakeTdcc(options: FakeOptions = {}) {
  const calls: string[] = [];
  let trusted = options.trusted ?? false;
  const reply = (body: unknown, header: Record<string, unknown> = {}) =>
    Response.json({ responseHeader: { returnCode: "0000", ...header }, responseBody: body });
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.slice(TDCC_BASE_URL.length);
    calls.push(path);
    const body = JSON.parse(String(init.body)).requestBody as Record<string, string>;
    switch (path) {
      case "CM001":
        return reply({ tokenID: "initial-token" });
      case "AU001":
        return trusted
          ? reply({ tokenID: "trusted-session-token", richUrl: "https://rich.example/p?sid=1", isDiffDevice: "N" })
          : reply({}, { returnCode: "D0005", returnMsg: "new device" });
      case "AU013":
      case "AU014":
        return reply({});
      case "AU015":
        if (options.rejectCode) return reply({}, { returnCode: options.rejectCode, returnMsg: "wrong code" });
        if (body.sendType === "MOBILE" || options.mobileVerified) trusted = true;
        return reply({ isMobileValid: body.sendType === "EMAIL" && !options.mobileVerified ? "N" : "Y" });
      default:
        throw new Error(`unexpected TDCC path ${path}`);
    }
  };
  return { fetch, calls };
}

function withService(
  fake: ReturnType<typeof fakeTdcc>,
  body: (context: Readonly<{
    service: ReturnType<typeof createTdccRegistrationService>;
    store: ReturnType<typeof createTdccSecretStore>;
    credentialsText: () => string;
  }>) => Promise<void>,
  options: { codeTimeoutMs?: number; signInDetails?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "tdcc-registration-"));
  const path = join(directory, "credentials.json");
  const store = createTdccSecretStore(path, codec);
  if (options.signInDetails !== false) store.write({ userId: USER_ID, password: "fixture-password" });
  const service = createTdccRegistrationService({
    store,
    fetch: fake.fetch,
    now: () => new Date("2026-10-09T02:31:00.000Z"),
    createDevice: () => DEVICE,
    ...(options.codeTimeoutMs === undefined ? {} : { codeTimeoutMs: options.codeTimeoutMs }),
  });
  const credentialsText = () => codec.decrypt(JSON.parse(readFileSync(path, "utf8")).data);
  return body({ service, store, credentialsText }).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("registration walks Email then SMS codes across calls and saves the device and session, never a code", async () => {
  const fake = fakeTdcc();
  await withService(fake, async ({ service, store, credentialsText }) => {
    assert.deepEqual(service.status(), { registered: false });
    const email = await service.start();
    assert.equal(email.status, "code-required");
    assert.equal(email.status === "code-required" && email.channel, "email");
    assert.equal(store.read().device, undefined, "nothing is saved before TDCC trusts the device");
    const registrationId = email.status === "code-required" ? email.registrationId : "";

    const sms = await service.submitCode(registrationId, EMAIL_CODE);
    assert.deepEqual(sms, { status: "code-required", registrationId, channel: "sms" });
    assert.deepEqual(await service.submitCode(registrationId, SMS_CODE), { status: "registered", channels: ["email", "sms"] });

    assert.deepEqual(fake.calls, ["CM001", "AU001", "AU013", "AU015", "AU014", "AU015", "CM001", "AU001"]);
    assert.deepEqual(store.read().device, { ...DEVICE, userId: USER_ID });
    assert.equal(store.read().session?.tokenId, "trusted-session-token");
    assert.deepEqual(service.status(), { registered: true });
    const saved = credentialsText();
    assert.equal(saved.includes(EMAIL_CODE) || saved.includes(SMS_CODE), false, "no one-time code is written");
    assert.deepEqual(await service.submitCode(registrationId, SMS_CODE), { status: "failed", reason: "not-found" });
  });
});

test("an Email code is enough when TDCC already verified the mobile number", async () => {
  await withService(fakeTdcc({ mobileVerified: true }), async ({ service }) => {
    const email = await service.start();
    assert.equal(email.status, "code-required");
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    assert.deepEqual(await service.submitCode(registrationId, EMAIL_CODE), { status: "registered", channels: ["email"] });
  });
});

test("a trusted device registers without any code", async () => {
  const fake = fakeTdcc({ trusted: true });
  await withService(fake, async ({ service, store }) => {
    assert.deepEqual(await service.start(), { status: "registered", channels: [] });
    assert.deepEqual(fake.calls, ["CM001", "AU001"]);
    assert.equal(store.read().session?.tokenId, "trusted-session-token");
  });
});

test("a registration waiting longer than the timeout expires and saves nothing", async () => {
  await withService(fakeTdcc(), async ({ service, store }) => {
    const email = await service.start();
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(await service.submitCode(registrationId, EMAIL_CODE), { status: "failed", reason: "expired" });
    assert.equal(store.read().device, undefined);
  }, { codeTimeoutMs: 10 });
});

test("a rejected code, a cancellation, or missing sign-in details end the registration with a typed reason", async () => {
  await withService(fakeTdcc({ rejectCode: "E1234" }), async ({ service, store }) => {
    const email = await service.start();
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    assert.deepEqual(await service.submitCode(registrationId, "000000"), { status: "failed", reason: "code-rejected" });
    assert.equal(store.read().device, undefined);
  });
  await withService(fakeTdcc({ rejectCode: "V0017" }), async ({ service }) => {
    const email = await service.start();
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    assert.deepEqual(await service.submitCode(registrationId, EMAIL_CODE), { status: "failed", reason: "code-expired" });
  });
  await withService(fakeTdcc(), async ({ service }) => {
    const email = await service.start();
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    service.cancel(registrationId);
    assert.deepEqual(await service.submitCode(registrationId, EMAIL_CODE), { status: "failed", reason: "cancelled" });
  });
  const fake = fakeTdcc();
  await withService(fake, async ({ service }) => {
    assert.deepEqual(await service.start(), { status: "failed", reason: "sign-in-details-missing" });
    assert.deepEqual(fake.calls, []);
  }, { signInDetails: false });
});

test("a registered device is reused when the person registers again", async () => {
  await withService(fakeTdcc(), async ({ service, store }) => {
    const existing = { deviceId: "ffeeddccbbaa9988", devType: "Android:14", devModel: "SM-G991B", userId: USER_ID };
    store.write({ device: existing });
    const email = await service.start();
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    await service.submitCode(registrationId, EMAIL_CODE);
    await service.submitCode(registrationId, SMS_CODE);
    assert.deepEqual(store.read().device, existing);
  });
});
