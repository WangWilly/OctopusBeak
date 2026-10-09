import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTdccSecretStore } from "./tdcc-secret-store.ts";
import { createTdccSessionHost } from "./tdcc-session-host.ts";
import { tdccConnection } from "../../../workflows/tdcc-session.ts";

const codec = {
  encrypt: (text: string) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload: string) => Buffer.from(payload, "base64").toString("utf8"),
};

const USER = ["Q", "1", "23456789"].join("");
const device = { userId: USER, deviceId: "00112233aabbccdd", devType: "Android:14", devModel: "SM-G991B" };
const session = { tokenId: "saved-token", richUrl: null, issuedAt: "2026-10-01T00:00:00.000Z" };

function withStore(run: (store: ReturnType<typeof createTdccSecretStore>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "tdcc-session-host-"));
  try {
    run(createTdccSecretStore(join(directory, "credentials.json"), codec));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a run leases the registered device and saved session without the password", () => {
  withStore((store) => {
    store.write({ userId: USER, password: "pw-1", device, session });
    const host = createTdccSessionHost(store);
    const lease = host.open();
    assert.deepEqual(lease, {
      status: "ready",
      connection: tdccConnection(USER),
      device: { deviceId: device.deviceId, devType: device.devType, devModel: device.devModel },
      session,
    });
    assert.equal(JSON.stringify(lease).includes("pw-1"), false);
    assert.deepEqual(host.signInDetails(), { status: "ready", details: { userId: USER, password: "pw-1" } });
  });
});

test("an unregistered device, or one registered for another sign-in identifier, needs registration", () => {
  withStore((store) => {
    store.write({ userId: USER, password: "pw-1" });
    assert.deepEqual(createTdccSessionHost(store).open(), { status: "device-registration-required" });
    store.write({ device: { ...device, userId: "OTHER-USER" } });
    assert.deepEqual(createTdccSessionHost(store).open(), { status: "device-registration-required" });
    assert.deepEqual(createTdccSessionHost(store).signInDetails(), { status: "device-registration-required" });
  });
});

test("a rotated session is saved only while the leased device is still the registered one", () => {
  withStore((store) => {
    store.write({ userId: USER, password: "pw-1", device, session });
    const host = createTdccSessionHost(store);
    host.open();
    const rotated = { tokenId: "rotated-token", richUrl: "https://rich.example/p", issuedAt: "2026-10-09T00:00:00.000Z" };
    host.saveSession(rotated);
    assert.deepEqual(store.read().session, rotated);

    const reRegistered = { ...device, deviceId: "ffeeddccbbaa9988" };
    const newer = { tokenId: "registration-token", richUrl: null, issuedAt: "2026-10-09T01:00:00.000Z" };
    store.write({ device: reRegistered, session: newer });
    host.saveSession({ ...rotated, tokenId: "late-rotation" });
    assert.deepEqual(store.read().session, newer, "a late rotation from the old device does not replace the new registration");
    assert.deepEqual(host.signInDetails(), { status: "device-registration-required" });
  });
});
