import assert from "node:assert/strict";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import test from "node:test";
import type { PreviewHttpRequest } from "./browser-http.ts";
import {
  createNewnewbankSource,
  encryptNewnewbankRequest,
  NEWNEWBANK_APP,
  NEWNEWBANK_KEY,
  newnewbankDate,
  newnewbankLoginVerdict,
  newnewbankSid,
  type NewnewbankEnvelope,
} from "./newnewbank-source.ts";
import { depositCollection, fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";
import { withPreviewDeviceIdentities } from "./registry.ts";

// Synthetic App responses shaped like all-set-tw's ubot fixtures; no live sample exists.
const DEVICE = "ab".repeat(32);
const credentials = {
  [NEWNEWBANK_KEY.idNumber]: "ａ000000001",
  [NEWNEWBANK_KEY.userCode]: "user01",
  [NEWNEWBANK_KEY.password]: "Secret01",
  [NEWNEWBANK_KEY.deviceId]: DEVICE,
};

const passwordPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const requestPair = generateKeyPairSync("rsa", { modulusLength: 1024 });
const PUBLIC_KEY = passwordPair.publicKey.export({ type: "pkcs1", format: "der" }).toString("base64");
const K1 = requestPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const K2 = randomBytes(16).toString("base64");

const rsaOpen = (privateKey: typeof passwordPair.privateKey, sealed: string) =>
  privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sealed, "base64")).toString("utf8");

function openRequest(body: Readonly<{ p1: string; p2: string }>): Record<string, unknown> {
  const iv = rsaOpen(requestPair.privateKey, body.p2);
  const decipher = createDecipheriv("aes-128-ofb", Buffer.from(K2, "base64"), Buffer.from(iv, "utf8")).setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(Buffer.from(body.p1, "base64")), decipher.final()]);
  const padding = padded.at(-1)!;
  assert.ok(padding >= 1 && padding <= 16 && padded.subarray(-padding).every((byte) => byte === padding), "PKCS#7 padding");
  return JSON.parse(padded.subarray(0, -padding).toString("utf8")) as Record<string, unknown>;
}

const reply = (code: string, body: unknown = {}, headers: Record<string, string> = {}, message = code === "0000" ? "交易成功" : "") =>
  jsonResponse(`{"ResCode":{"RtnCode":"${code}","RtnDesc":"${message}"},"ResBody":${typeof body === "string" ? body : JSON.stringify(body)}}`, headers);

const row = (fields: Readonly<Record<string, string | number>>) => JSON.stringify(fields);

const DETAILS = `{"WarnCode":"0000","Details":[
  ${row({ TraDate: "2026-10-16", TraDateTime: "2026-10-16 01:13:06", TraType: "1", Expenditure: 1320, Income: 0, Balance: 48680, TraSum: "行動跨轉", Summary: "(0001234)", PS: "房租分攤" })},
  ${row({ TraDate: "115/10/15", TraDateTime: "115/10/15 19:27:47", TraType: "2", Expenditure: 0, Income: 2500.5, Balance: 50000.5, TraSum: "轉帳存入", PS: "" })},
  ${row({ TraDate: "1151001", TraType: "2", Expenditure: 0, Income: 1, Balance: 1, TraSum: "利息" })},
  ${row({ TraDate: "1151001", TraType: "2", Expenditure: 0, Income: 1, Balance: 1, TraSum: "利息" })}]}`;

type Routes = Partial<Record<string, FakeRoute>>;

const ROUTES: Readonly<Record<string, FakeRoute>> = {
  NNBCM000007: () => reply("0000", { PublicKey: PUBLIC_KEY }),
  NNBCM000011: () => reply("0000", { k1: K1, k2: K2 }),
  NNBI010101: () => reply("NS161", { FlagList: { MissingUserFlag: "0", KycFlag: "N" } }, { ssid: "synthetic-ssid" }, "未綁定裝置"),
  NNBN020101: () => reply("0000", '{"Account":"0000-5678","AccountBal":50000.50,"AvailableBal":49500}', { date: "Thu, 15 Oct 2026 01:59:00 GMT" }),
  NNBN010201: () => reply("0000", DETAILS),
  NNBI010103: () => reply("0000"),
};

function opener(routes: Routes = {}) {
  const merged = { ...ROUTES, ...routes };
  return fakeHttpOpener(Object.fromEntries(Object.entries(merged).map(([api, route]) => [`POST /NNBank/svc/${api}`, route!])));
}

const api = (request: PreviewHttpRequest) => new URL(request.url).pathname.replace("/NNBank/svc/", "");

async function run(routes: Routes = {}, input: Readonly<Record<string, string>> = credentials) {
  const http = opener(routes);
  const result = await runPreviewSource(createNewnewbankSource({ http }), input);
  return { ...result, requests: http.requests, apis: http.requests.map(api) };
}

test("the reqec body round-trips: p2 unwraps the IV and p1 decrypts to the padded JSON", () => {
  for (const payload of [{ sid: "A000000001A", serial: "" }, { text: "x".repeat(16) }, { text: "使用者" }]) {
    const sealed = encryptNewnewbankRequest(payload, K1, K2);
    assert.deepEqual(openRequest(sealed), payload);
  }
  const fixed = encryptNewnewbankRequest({ a: 1 }, K1, K2, "1234567890123456");
  assert.equal(rsaOpen(requestPair.privateKey, fixed.p2), "1234567890123456");
  assert.throws(() => encryptNewnewbankRequest({}, K1, randomBytes(32).toString("base64")), /not an AES-128 key/u);
});

test("New New Bank signs in with the stored device and the App constant, then collects the TWD account", async () => {
  const result = await run();
  assert.equal(result.errorCode, null, String(result.error));
  assert.deepEqual(result.apis, ["NNBCM000007", "NNBCM000011", "NNBI010101", "NNBN020101", "NNBN010201", "NNBI010103"]);
  const login = openRequest(JSON.parse(result.requests[2]!.body!) as { p1: string; p2: string });
  assert.equal(rsaOpen(passwordPair.privateKey, login.miMa as string), "Secret01");
  assert.deepEqual({ ...login, miMa: "sealed" }, {
    sid: "A000000001A",
    nickName: "user01",
    miMa: "sealed",
    serial: "",
    deviceUuid: DEVICE,
    appVer: NEWNEWBANK_APP.appVer,
    deviceModel: NEWNEWBANK_APP.deviceModel,
    deviceOSVer: NEWNEWBANK_APP.deviceOSVer,
  });
  assert.ok(!result.requests.some((request) => request.body?.includes("Secret01")), "the password is never sent in the clear");
  assert.equal(result.requests[0]!.headers?.Authorization, undefined);
  assert.ok(result.requests.slice(3).every((request) => request.headers?.Authorization === "synthetic-ssid"));
  assert.deepEqual(JSON.parse(result.requests[4]!.body!), { beginDate: "20260801", endDate: "20261015" });

  const [account] = depositCollection(result.writes[0]!).accounts;
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  assert.equal(account!.sourceAccountKey, "00005678:TWD");
  assert.equal(account!.displayLabel, "New New Bank 數位帳戶 5678");
  assert.deepEqual(account!.balances, [
    { kind: "current", amount: "50000.50", currency: "TWD", observedAt: asOf },
    { kind: "available", amount: "49500", currency: "TWD", observedAt: asOf },
  ]);
  assert.deepEqual(account!.transactions.map(({ amount, direction, postedAt, description }) => ({ amount, direction, postedAt, description })), [
    { amount: "1320", direction: "outflow", postedAt: { precision: "day", value: "2026-10-16" }, description: "行動跨轉 · 房租分攤" },
    { amount: "2500.5", direction: "inflow", postedAt: { precision: "day", value: "2026-10-15" }, description: "轉帳存入" },
    { amount: "1", direction: "inflow", postedAt: { precision: "day", value: "2026-10-01" }, description: "利息" },
    { amount: "1", direction: "inflow", postedAt: { precision: "day", value: "2026-10-01" }, description: "利息" },
  ], "TraType 1 is an outflow and 2 an inflow; ROC dates are Gregorian");
  assert.equal(account!.transactions[3]!.sourceRowKey, account!.transactions[2]!.sourceRowKey.replace(/:1$/u, ":2"));
  assert.ok(!JSON.stringify(account).includes("1234"), "the counterparty account in Summary is not kept");
  assert.equal(result.observations.length, 6);
});

test("MFOB halves the range until each answer is whole, and a range that cannot be halved fails", async () => {
  const ranges: string[] = [];
  const split = await run({
    NNBN010201: (request) => {
      const { beginDate, endDate } = JSON.parse(request.body!) as { beginDate: string; endDate: string };
      ranges.push(`${beginDate}-${endDate}`);
      return beginDate === "20260801" && endDate === "20261015" ? reply("0000", { WarnCode: "MFOB", Details: [] }) : reply("0000", DETAILS);
    },
  });
  assert.equal(split.errorCode, null, String(split.error));
  assert.deepEqual(ranges, ["20260801-20261015", "20260801-20260907", "20260908-20261015"]);
  assert.equal(depositCollection(split.writes[0]!).accounts[0]!.transactions.length, 8);

  const endless = await run({ NNBN010201: () => reply("0000", { WarnCode: "MFOB", Details: [] }) });
  assert.equal(endless.errorCode, "source-collection-failed");
  assert.equal(endless.writes.length, 0);
  assert.equal(endless.apis.at(-1), "NNBI010103", "logout still runs");

  const empty = await run({ NNBN010201: () => reply("NS101", {}, {}, "查無交易資料") });
  assert.equal(empty.errorCode, null);
  assert.equal(depositCollection(empty.writes[0]!).accounts[0]!.transactions.length, 0);
});

test("New New Bank login answers map to one outcome each and are never retried", async () => {
  const cases: readonly (readonly [FakeRoute, string])[] = [
    [() => reply("NS169", {}, {}, "使用者密碼錯誤"), "authentication-failed"],
    [() => reply("NM92"), "authentication-failed"],
    [() => ({ ...reply("E401", {}, {}, "登入失敗"), status: 401 }), "authentication-failed"],
    [() => reply("NS090", {}, {}, "請於官方App完成身分核驗"), "device-registration-required"],
    [() => reply("0000", { FlagList: { KycFlag: "Y" } }, { ssid: "s" }), "device-registration-required"],
    [() => reply("0000", { FlagList: { MissingUserFlag: "2" } }, { ssid: "s" }), "device-registration-required"],
    [() => reply("NS777", {}, {}, "您的App版本過舊，請更新至最新版本"), "provider-protocol-outdated"],
    [() => reply("NS999", {}, {}, "系統忙線"), "source-validation-failed"],
    [() => reply("0000"), "source-validation-failed"],
  ];
  for (const [login, code] of cases) {
    const result = await run({ NNBI010101: login });
    assert.equal(result.errorCode, code, String(result.error));
    assert.equal(result.apis.filter((name) => name === "NNBI010101").length, 1);
    assert.ok(!result.apis.includes("NNBN020101"));
    assert.equal(result.writes.length, 0);
  }
});

test("a lost session, a missing summary field, or an unknown TraType fails before the write", async () => {
  const failures: readonly (readonly [Routes, string])[] = [
    [{ NNBN020101: () => reply("NS888", {}, {}, "連線逾時") }, "authentication-failed"],
    [{ NNBN020101: () => reply("0000", { Account: "0000-5678" }) }, "source-validation-failed"],
    [{ NNBN010201: () => reply("0000", `{"Details":[${row({ TraDate: "2026-10-16", TraType: "3", Income: 1 })}]}`) }, "source-validation-failed"],
    [{ NNBN010201: () => reply("0000", `{"Details":[${row({ TraDate: "2026-10-16", TraType: "2", Income: "1.0.0" })}]}`) }, "source-validation-failed"],
    [{ NNBN010201: () => reply("0000", { WarnCode: "0000" }) }, "source-validation-failed"],
  ];
  for (const [routes, code] of failures) {
    const result = await run(routes);
    assert.equal(result.errorCode, code, String(result.error));
    assert.equal(result.writes.length, 0);
  }
});

test("without a stored device identity the source sends nothing", async () => {
  const result = await run({}, { ...credentials, [NEWNEWBANK_KEY.deviceId]: "" });
  assert.equal(result.errorCode, "authentication-failed");
  assert.deepEqual(result.apis, []);
});

test("the device identity is created once, when the sign-in details are first saved", () => {
  let made = 0;
  const generate = () => `${String(++made).repeat(64)}`.slice(0, 64);
  const first = withPreviewDeviceIdentities({}, { [NEWNEWBANK_KEY.userCode]: "user01" }, undefined, generate);
  assert.equal(first[NEWNEWBANK_KEY.deviceId], "1".repeat(64));
  const again = withPreviewDeviceIdentities(first, { [NEWNEWBANK_KEY.password]: "changed" }, undefined, generate);
  assert.equal(again[NEWNEWBANK_KEY.deviceId], "1".repeat(64), "a stored identity is kept");
  assert.equal(withPreviewDeviceIdentities({}, { PREVIEW_FEIB_DEPOSIT_PASSWORD: "x" }, undefined, generate)[NEWNEWBANK_KEY.deviceId], undefined,
    "another source's save creates nothing");
  assert.match(withPreviewDeviceIdentities({}, { [NEWNEWBANK_KEY.idNumber]: "x" })[NEWNEWBANK_KEY.deviceId]!, /^[0-9a-f]{64}$/u);
});

test("New New Bank dates accept Gregorian and ROC forms", () => {
  assert.deepEqual(newnewbankDate("115/10/03", "d"), { precision: "day", value: "2026-10-03" });
  assert.deepEqual(newnewbankDate("01151003", "d"), { precision: "day", value: "2026-10-03" });
  assert.deepEqual(newnewbankDate("20261003", "d"), { precision: "day", value: "2026-10-03" });
  assert.deepEqual(newnewbankDate("2026/10/03 9:05", "d"), { precision: "minute", value: "2026-10-03T09:05" });
  assert.throws(() => newnewbankDate("115/02/30", "d"), /not a calendar date/u);
  assert.equal(newnewbankSid("ａ000000009"), "A000000009A");
  const envelope = (code: string, message = ""): NewnewbankEnvelope => ({ status: 200, code, message, body: {}, date: null });
  assert.equal(newnewbankLoginVerdict(envelope("NS164")), "signed-in");
  assert.equal(newnewbankLoginVerdict(envelope("NS300", "使用者代號不存在")), "credentials-rejected");
});
