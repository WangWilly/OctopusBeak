import assert from "node:assert/strict";
import test from "node:test";
import {
  TDCC_APP_INFO,
  TDCC_BASE_URL,
  TDCC_MAX_PAGES,
  TdccClient,
  TdccError,
  createTdccDeviceIdentity,
  deriveTdccEncryptionKey,
  encryptTdccField,
  tdccTimestamp,
  type TdccFailure,
} from "./tdcc-epassbook-client.ts";

// Vectors computed by running the all-set-tw reference helpers (WebCrypto) on these inputs.
const FIXED_NOW = new Date("2026-03-04T05:06:07.089Z");
const VECTOR = {
  timestamp: "20260304T050607089Z",
  derived: "M=jQATyMN6jQAWzaMvDJRHUZMuDFUEwO",
  sequence: "MjAyNjAzMDRUMDUwNjA3MDg5Wg==",
  loginCodeCipher: "LSAQErIC03uTpyE7ZQOBTg==",
  userIdCipher: "w2dg4HYEAwsvleawBjn8nw==",
  loginSignature: "bpi6QPzlXu9Kmh4lP3I2T5GpN9yeLNR1vClCkTbz9UU=",
  emptyBodySignature: "ucQ0t1SdMdPORIppCHeqLlatISAt58YLjDU0ydB81iw=",
};
const IDENTITY = { deviceId: "0123456789abcdef", devType: "Android:14", devModel: "SM-G991B" };
const DETAILS = { userId: "TESTUSER01", password: "pass-word-1" };

type Sent = { url: string; method: string; headers: Record<string, string>; body: any };
type Reply = { header?: Record<string, unknown>; body?: unknown; status?: number };

function fakeTdcc(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    assert.ok(reply, `unexpected request to ${url}`);
    return new Response(
      JSON.stringify({ responseHeader: reply.header ?? { returnCode: "0000" }, responseBody: reply.body ?? {} }),
      { status: reply.status ?? 200 },
    );
  };
  return { sent, fetch };
}

function client(replies: Reply[], session?: { tokenId: string | null; richUrl: string | null }) {
  const fake = fakeTdcc(replies);
  return { ...fake, client: new TdccClient({ identity: IDENTITY, session, fetch: fake.fetch, now: () => FIXED_NOW }) };
}

async function failureOf(promise: Promise<unknown>): Promise<TdccFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TdccError, `expected TdccError, got ${String(error)}`);
    return error.failure;
  }
  assert.fail("expected the call to fail");
}

test("timestamp, key derivation, and AES field encryption match the reference App vectors", () => {
  assert.equal(tdccTimestamp(FIXED_NOW), VECTOR.timestamp);
  assert.equal(deriveTdccEncryptionKey(VECTOR.timestamp, "Android:14"), VECTOR.derived);
  assert.equal(encryptTdccField(VECTOR.derived, DETAILS.password), VECTOR.loginCodeCipher);
  assert.equal(encryptTdccField(VECTOR.derived, DETAILS.userId), VECTOR.userIdCipher);
});

test("login sends the App envelope with encrypted sign-in fields and a body signature", async () => {
  const { sent, client: tdcc } = client([{ body: { tokenID: "token-after-login", richUrl: "https://x/rich?a=1" } }], {
    tokenId: "token-before",
    richUrl: null,
  });
  assert.deepEqual(await tdcc.login(DETAILS), { kind: "trusted" });

  const [request] = sent;
  assert.equal(request.url, `${TDCC_BASE_URL}AU001`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["User-Agent"], "okhttp/4.9.3");
  assert.deepEqual(request.body.requestHeader, {
    appInfo: TDCC_APP_INFO,
    devID: IDENTITY.deviceId,
    devType: IDENTITY.devType,
    sequence: VECTOR.sequence,
    signature: VECTOR.loginSignature,
    tokenID: "token-before",
  });
  assert.deepEqual(request.body.requestBody, {
    apiVer: "20250220",
    devModel: "SM-G991B",
    loginCode: VECTOR.loginCodeCipher,
    loginType: "M",
    networkType: "WIFI",
    userID: VECTOR.userIdCipher,
  });
  assert.equal(JSON.stringify(request.body).includes(DETAILS.password), false, "password never sent in clear");
  assert.deepEqual(tdcc.exportSession(), { tokenId: "token-after-login", richUrl: "https://x/rich?a=1" });
});

test("an empty body is signed over the timestamp and a rotated response tokenID is used next", async () => {
  const { sent, client: tdcc } = client([
    { header: { returnCode: "0000", tokenID: "rotated-1" }, body: { tokenID: "initial" } },
    { header: { returnCode: "0000", tokenID: "rotated-2" }, body: {} },
    { body: {} },
  ]);
  await tdcc.getInitialToken();
  assert.equal(sent[0].body.requestHeader.signature, VECTOR.emptyBodySignature);
  assert.equal(sent[0].body.requestHeader.tokenID, null);
  assert.deepEqual(sent[0].body.requestBody, {});
  await tdcc.bankBalances();
  assert.equal(sent[1].body.requestHeader.tokenID, "initial");
  await tdcc.positions();
  assert.equal(sent[2].body.requestHeader.tokenID, "rotated-2");
});

test("every token or richUrl change is reported once, even when the request then fails", async () => {
  const fake = fakeTdcc([
    { header: { returnCode: "0000", tokenID: "rotated-1" }, body: { tokenID: "after-login", richUrl: "https://rich.example/p?sid=1", isDiffDevice: "N" } },
    { header: { returnCode: "0000", tokenID: "after-login" }, body: {} },
    { header: { returnCode: "E1234", tokenID: "rotated-2", returnMsg: "rejected" } },
  ]);
  const changes: unknown[] = [];
  const tdcc = new TdccClient({ identity: IDENTITY, fetch: fake.fetch, now: () => FIXED_NOW, onSessionChange: (session) => changes.push(session) });
  await tdcc.login(DETAILS);
  await tdcc.positions();
  await assert.rejects(tdcc.bankBalances(), TdccError);
  assert.deepEqual(changes, [
    { tokenId: "rotated-1", richUrl: null },
    { tokenId: "after-login", richUrl: "https://rich.example/p?sid=1" },
    { tokenId: "rotated-2", richUrl: "https://rich.example/p?sid=1" },
  ]);
});

test("login reports device verification from response flags and from device codes", async () => {
  for (const reply of [
    { body: { isDiffDevice: "Y" } },
    { body: { isEmailValid: "N" } },
    { header: { returnCode: "C9999", returnMsg: "x" } },
    { header: { returnCode: "D0005", returnMsg: "x" } },
  ]) {
    assert.deepEqual(await client([reply]).client.login(DETAILS), { kind: "device-verification-required" });
  }
  assert.deepEqual(await client([{ body: { isDiffDevice: "N", isEmailValid: "Y" } }]).client.login(DETAILS), {
    kind: "trusted",
  });
});

test("device codes outside sign-in are not read as an untrusted device", async () => {
  assert.deepEqual(await failureOf(client([{ header: { returnCode: "C9999" } }]).client.positions()), {
    reason: "rejected",
    code: "C9999",
  });
});

test("OTP verification classifies the SMS follow-up and an expired code", async () => {
  const email = client([{ body: { isMobileValid: "N" } }]);
  assert.deepEqual(await email.client.verifyOtp(DETAILS.userId, "123456", "email"), {
    kind: "sms-verification-required",
  });
  assert.equal(email.sent[0].body.requestBody.sendType, "EMAIL");
  assert.notEqual(email.sent[0].body.requestBody.otp, "123456");

  const sms = client([{ body: { isMobileValid: "N" } }]);
  assert.deepEqual(await sms.client.verifyOtp(DETAILS.userId, "654321", "sms"), { kind: "registered" });
  assert.equal(sms.sent[0].body.requestBody.sendType, "MOBILE");

  assert.deepEqual(await client([{ body: { isMobileValid: "Y" } }]).client.verifyOtp(DETAILS.userId, "1", "email"), {
    kind: "registered",
  });
  assert.deepEqual(
    await failureOf(client([{ header: { returnCode: "V0017" } }]).client.verifyOtp(DETAILS.userId, "1", "email")),
    { reason: "otp-expired", code: "V0017" },
  );
});

test("failures carry a typed reason", async () => {
  assert.deepEqual(await failureOf(client([{ header: { returnCode: "D0007" } }]).client.positions()), {
    reason: "session-expired",
    code: "D0007",
  });
  assert.deepEqual(
    await failureOf(client([{ header: { returnCode: "E1234", returnMsg: "請更新至最新版本" } }]).client.positions()),
    { reason: "protocol-outdated", code: "E1234" },
  );
  assert.deepEqual(await failureOf(client([{ header: { returnCode: "E1234", returnMsg: "密碼錯誤" } }]).client.login(DETAILS)), {
    reason: "rejected",
    code: "E1234",
  });
  assert.deepEqual(await failureOf(client([{ status: 503 }]).client.fundPositions()), { reason: "http", status: 503 });
});

test("bank transactions follow pageToken until totalCount is reached", async () => {
  const { sent, client: tdcc } = client([
    { body: { transactionDetails: [{}, {}], totalCount: "3", pageToken: "p2" } },
    { body: { transactionDetails: [{}], totalCount: 3, pageToken: "p3" } },
  ]);
  const pages = await tdcc.bankTransactions({ bankId: "808", accountNo: "123", currency: "TWD" });
  assert.equal(pages.length, 2);
  assert.deepEqual(sent.map((request) => request.body.requestBody.pageToken), ["", "p2"]);
  assert.equal(sent[0].url, `${TDCC_BASE_URL}tsp/TSP007`);
  assert.equal(sent[0].body.requestBody.limitsInPage, 100);
});

test("bank transactions reject a repeated page token and a short final page", async () => {
  const loop = client([
    { body: { transactionDetails: [{}], pageToken: "p2" } },
    { body: { transactionDetails: [{}], pageToken: "p2" } },
  ]);
  assert.deepEqual(await failureOf(loop.client.bankTransactions({ bankId: "1", accountNo: "2", currency: "TWD" })), {
    reason: "pagination",
    detail: "repeated-cursor",
  });
  const short = client([{ body: { transactionDetails: [{}], totalCount: 5 } }]);
  assert.deepEqual(await failureOf(short.client.bankTransactions({ bankId: "1", accountNo: "2", currency: "TWD" })), {
    reason: "pagination",
    detail: "incomplete",
  });
});

test("bank transactions stop at the page cap", async () => {
  const replies = Array.from({ length: TDCC_MAX_PAGES }, (_, index) => ({
    body: { transactionDetails: [{}], pageToken: `p${index + 1}` },
  }));
  const { sent, client: tdcc } = client(replies);
  assert.deepEqual(await failureOf(tdcc.bankTransactions({ bankId: "1", accountNo: "2", currency: "TWD" })), {
    reason: "pagination",
    detail: "page-limit",
  });
  assert.equal(sent.length, TDCC_MAX_PAGES);
});

const tradeRow = (postDate: string, txnSerNo: string, txnDate: string) =>
  [postDate, txnSerNo, "2330", "", "", "", "", "", "", txnDate];

test("trade details page backward by the last row's txnDate, postDate and txnSerNo until D0002", async () => {
  const { sent, client: tdcc } = client([
    { body: { items: [tradeRow("20260301", "S9", "20260227"), tradeRow("20260220", "S7", "20260218")] } },
    { body: { items: [tradeRow("20260110", "S3", "20260108")] } },
    { header: { returnCode: "D0002", returnMsg: "no more" }, body: {} },
  ]);
  const pages = await tdcc.tradeDetails({ brokerNo: "9A00", brokerAccount: "1234567" });
  assert.equal(pages.length, 2);
  assert.deepEqual(
    sent.map(({ body }) => [body.requestBody.postDate, body.requestBody.txnSerNo, body.requestBody.updateType]),
    [["", "", "B"], ["", "2026021820260220S7", "B"], ["", "2026010820260110S3", "B"]],
  );
});

test("trade details reject a cursor that does not move", async () => {
  const { client: tdcc } = client([
    { body: { items: [["20260301", "S9"]] } },
    { body: { items: [["20260301", "S9"]] } },
  ]);
  assert.deepEqual(await failureOf(tdcc.tradeDetails({ brokerNo: "1", brokerAccount: "2" })), {
    reason: "pagination",
    detail: "repeated-cursor",
  });
});

test("asset trend reuses the richUrl query and returns null without one", async () => {
  assert.equal(await client([]).client.assetTrend(), null);
  const { sent, client: tdcc } = client([{ body: { chartDate: ["20260101"] } }], {
    tokenId: "t",
    richUrl: "https://rich.example/page?sid=abc",
  });
  const trend = await tdcc.assetTrend("1Y");
  assert.deepEqual(trend, { responseHeader: { returnCode: "0000" }, responseBody: { chartDate: ["20260101"] } });
  assert.equal(sent[0].url, `${TDCC_BASE_URL}TR087?sid=abc&type=1Y`);
  assert.equal(sent[0].method, "GET");
});

test("a new device identity is the fixed common model with a random 16-hex device ID", () => {
  const first = createTdccDeviceIdentity();
  assert.equal(first.devModel, "SM-G991B");
  assert.equal(first.devType, "Android:14");
  assert.match(first.deviceId, /^[0-9a-f]{16}$/u);
  assert.notEqual(createTdccDeviceIdentity().deviceId, first.deviceId);
});
