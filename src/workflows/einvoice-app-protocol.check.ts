import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptLoginData,
  encryptLoginData,
  parseLoginSession,
  serverTimeOffset,
  signInvoiceJwt,
  type EInvoiceAppSession,
  type EInvoiceJwtSession,
} from "./einvoice-app-protocol.ts";

test("encryptLoginData round-trips through decryptLoginData", () => {
  const data = { type: 0, mobile: "0900000000", password: "secret" };
  const { ldata } = encryptLoginData(data);
  assert.match(ldata, /^[A-Za-z0-9]{16}\|[A-Za-z0-9+/=]+\|[A-Za-z0-9]{16}$/u);
  assert.deepEqual(decryptLoginData(ldata), data);
});

test("decryptLoginData rejects malformed ldata", () => {
  assert.throws(() => decryptLoginData("not-a-valid-ldata"), /ldata 格式無效/u);
  assert.throws(() => decryptLoginData("a|b|c"), /ldata 格式無效/u);
});

test("encryptLoginData produces distinct ldata per call", () => {
  const data = { x: 1 };
  const first = encryptLoginData(data).ldata;
  const second = encryptLoginData(data).ldata;
  assert.notEqual(first, second);
});

test("signInvoiceJwt produces a three-part HS256 JWT", () => {
  const session = {
    appid: "app",
    liat: 1700000000,
    ssme: "session-secret",
    carrierCode: "/AB+123",
  } satisfies EInvoiceJwtSession;
  const now = 1700000000;
  const jwt = signInvoiceJwt({ version: "1.0", action: "carrierInvChk" }, session, now);

  const [headerPart, claimsPart, signaturePart] = jwt.split(".");
  assert.ok(headerPart && claimsPart && signaturePart, "JWT has three parts");

  const header = JSON.parse(Buffer.from(headerPart!, "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "HS256", typ: "JWT", ver: "1.0" });

  const claims = JSON.parse(Buffer.from(claimsPart!, "base64url").toString("utf8"));
  assert.equal(claims.comms.iat, now);
  assert.equal(claims.comms.exp, now + 40);
  assert.equal(claims.comms.liat, session.liat);
  assert.equal(claims.comms.appid, session.appid);
  assert.equal(claims.comms.barcode, session.carrierCode);
  assert.equal(claims.comms.keyType, "2");
  assert.deepEqual(claims.reqdata, { version: "1.0", action: "carrierInvChk" });

  assert.equal(signaturePart!.length, 43);
});

test("parseLoginSession extracts fields and requires the essential ones", () => {
  const session = parseLoginSession({
    sid: "S" + "x".repeat(17),
    token: "t",
    appid: "a",
    ssme: "s",
    liat: 123,
    carrier_code: "/AB+123",
    skey: "k",
    now: 1700000000,
  });
  assert.equal(session.sid.startsWith("S"), true);
  assert.equal(session.token, "t");
  assert.equal(session.appid, "a");
  assert.equal(session.ssme, "s");
  assert.equal(session.liat, 123);
  assert.equal(session.carrierCode, "/AB+123");
  assert.equal(session.skey, "k");
  assert.equal(session.now, 1700000000);
});

test("parseLoginSession throws when a required field is missing", () => {
  assert.throws(() => parseLoginSession({ sid: "s", token: "t", appid: "a", liat: 1 }), /缺少必要 session 欄位/u);
});

test("serverTimeOffset is zero without now and truncated otherwise", () => {
  const base = {
    sid: "s",
    token: "t",
    appid: "a",
    ssme: "s",
    liat: 1,
  } satisfies EInvoiceAppSession;
  assert.equal(serverTimeOffset(base), 0);
  assert.equal(serverTimeOffset({ ...base, now: 100 }, 95_000), 5);
});
