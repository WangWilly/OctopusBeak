import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATHAY_GMAIL_CONNECTED_EMAIL_KEY,
  CATHAY_GMAIL_OTP_ENABLED_KEY,
  CATHAY_GMAIL_REFRESH_TOKEN_KEY,
  automationConfigEnv,
  readAutomationCredentialsFile,
  setAutomationCredentialCodec,
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";
import {
  CATHAY_GMAIL_OTP_SUBJECT,
  CATHAY_GMAIL_SENDER_DOMAIN,
  GMAIL_READONLY_SCOPE,
  buildGoogleAuthorizationUrl,
  createCathayGmailOtpService,
  createOAuthState,
  createPkceVerifier,
  inspectCathayGmailOtpMessage,
  parseGoogleOAuthClientConfig,
  parseGmailRawMessage,
  pkceChallengeForVerifier,
  pollCathayGmailOtp,
  resetCathayGmailOtpServiceForTests,
  validateOAuthCallbackUrl,
} from "./gmail-otp-service.ts";

const directHeaders = [
  `Authentication-Results: mx.google.com; dkim=pass header.d=${CATHAY_GMAIL_SENDER_DOMAIN}; dmarc=pass header.from=cathaybk.com.tw`,
  "From: alerts@cathaybk.com.tw",
].join("\n");

function plainMessage({
  body = "親愛的客戶您好：請在 5 分鐘內於 CUBE 網銀輸入 ABCD-123456 完成登入兩步驟驗證。若非您本人操作，請儘速與本行聯繫，並請立即重設網銀密碼。",
  internalDate = "1001",
  headers = directHeaders,
} = {}) {
  return {
    id: `message-${internalDate}`,
    internalDate,
    raw: `${headers}\nSubject: ${CATHAY_GMAIL_OTP_SUBJECT}\nContent-Type: text/plain; charset=utf-8\n\n${body}`,
  };
}

const hmeHeaders = [
  "Authentication-Results: mx.google.com; dkim=pass header.i=@icloud.com; dmarc=pass header.from=icloud.com",
  "DKIM-Signature: v=1; a=rsa-sha256; d=icloud.com; h=from:to:subject:x-icloud-hme; b=signature",
  `X-ICLOUD-HME: p=alias@icloud.com; d=; f=destination@gmail.com; r=to; s=relay@${CATHAY_GMAIL_SENDER_DOMAIN}`,
  "From: relay@icloud.com",
].join("\n");

function rejectionReason(value: ReturnType<typeof inspectCathayGmailOtpMessage>) {
  return value.status === "rejected" ? value.reason : null;
}

const fakeCredentialCodec = {
  encrypt(text: string) { return Buffer.from(`safe:${text}`).toString("base64"); },
  decrypt(payload: string) { return Buffer.from(payload, "base64").toString().slice(5); },
};

test("PKCE, state, client config, and callback validation are strict", () => {
  const verifier = createPkceVerifier(() => new Uint8Array(32).fill(65));
  const challenge = pkceChallengeForVerifier(verifier);
  assert.equal(verifier.length, 43);
  assert.equal(challenge.length, 43);
  const state = createOAuthState(() => new Uint8Array(24).fill(66));
  const client = parseGoogleOAuthClientConfig({ installed: { client_id: "client-id" } });
  assert.ok(client);
  const redirectUri = "http://127.0.0.1:43210/oauth2callback";
  const url = buildGoogleAuthorizationUrl({ client, state, codeChallenge: challenge, redirectUri });
  assert.equal(new URL(url).searchParams.get("scope"), GMAIL_READONLY_SCOPE);
  assert.equal(validateOAuthCallbackUrl(`${redirectUri}?code=abc&state=${state}`, { state, redirectUri }).status, "accepted");
  assert.equal(validateOAuthCallbackUrl(`${redirectUri}?code=abc&state=wrong`, { state, redirectUri }).status, "invalid");
  assert.equal(validateOAuthCallbackUrl(`http://localhost:43210/oauth2callback?code=abc&state=${state}`, { state, redirectUri }).status, "invalid");
  assert.deepEqual(validateOAuthCallbackUrl(`${redirectUri}?error=access_denied&state=${state}`, { state, redirectUri }), { status: "cancelled", reason: "access_denied" });
  assert.equal(parseGoogleOAuthClientConfig({ installed: { client_id: "", auth_uri: "http://bad" } }), null);
  assert.equal(parseGoogleOAuthClientConfig({ web: { client_id: "web-client-id" } }), null);
  assert.equal(parseGoogleOAuthClientConfig({ client_id: "legacy-client-id" }), null);
});

test("initial Desktop OAuth exchange sends the provided client secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-initial-oauth-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const oauthDir = join(dir, "data", "google-oauth");
  mkdirSync(oauthDir, { recursive: true });
  writeFileSync(join(oauthDir, "google-oauth-desktop-client.json"), JSON.stringify({
    installed: {
      client_id: "desktop-client",
      client_secret: "desktop-secret",
      auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    },
  }));
  setAutomationCredentialCodec(fakeCredentialCodec);
  writeAutomationSettingsFile(settingsPath, {});
  writeAutomationCredentialsFile(credentialsPath, {});
  let tokenBodyText = "";
  let callbackPage = "";
  let callbackFinished = Promise.resolve();
  try {
    const service = createCathayGmailOtpService({
      appRoot: dir,
      settingsPath,
      credentialsPath,
      openExternal: (url) => {
        const authorization = new URL(url);
        callbackFinished = fetch(
          `${authorization.searchParams.get("redirect_uri")}?code=test-code&state=${authorization.searchParams.get("state")}`,
        ).then(async (response) => {
          callbackPage = await response.text();
        });
      },
      fetch: async (_url, init) => {
        tokenBodyText = String(init?.body ?? "");
        return new Response(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      api: { profile: async () => ({ emailAddress: "test@gmail.com" }) },
    });
    assert.deepEqual(await service.enable(), {
      enabled: true,
      connectedEmail: "test@gmail.com",
      needsAuthorization: false,
    });
    await callbackFinished;
    assert.equal(new URLSearchParams(tokenBodyText).get("client_secret"), "desktop-secret");
    assert.equal(callbackPage, "Google authorization received. Return to OctopusBeak to confirm the connection result.");
  } finally {
    setAutomationCredentialCodec(null);
    resetCathayGmailOtpServiceForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token exchange failure returns a sanitized connection error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-token-error-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const oauthDir = join(dir, "data", "google-oauth");
  mkdirSync(oauthDir, { recursive: true });
  writeFileSync(join(oauthDir, "google-oauth-desktop-client.json"), JSON.stringify({
    installed: {
      client_id: "desktop-client",
      client_secret: "desktop-secret",
    },
  }));
  setAutomationCredentialCodec(fakeCredentialCodec);
  writeAutomationSettingsFile(settingsPath, {});
  writeAutomationCredentialsFile(credentialsPath, {});
  try {
    const service = createCathayGmailOtpService({
      appRoot: dir,
      settingsPath,
      credentialsPath,
      openExternal: (url) => {
        const authorization = new URL(url);
        void fetch(
          `${authorization.searchParams.get("redirect_uri")}?code=test-code&state=${authorization.searchParams.get("state")}`,
        );
      },
      fetch: async () => new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.deepEqual(await service.enable(), {
      enabled: false,
      connectedEmail: null,
      needsAuthorization: false,
      connectionError: "token-exchange-failed",
    });
  } finally {
    setAutomationCredentialCodec(null);
    resetCathayGmailOtpServiceForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested MIME and direct/HME Google sender paths yield one OTP", () => {
  const nestedBody = [
    "Content-Type: multipart/signed; boundary=outer",
    "",
    "--outer",
    "Content-Type: multipart/alternative; boundary=inner",
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "=E8=AB=8B=E5=9C=A85=E5=88=86=E9=90=98=E5=85=A7=E6=96=BCCUBE=20=E7=B6=B2=E9=8A=80=E8=BC=B8=E5=85=A5=20ABCD-123456=20=E5=AE=8C=E6=88=90=E7=99=BB=E5=85=A5=E5=85=A9=E6=AD=A5=E9=A9=97=E8=AD=89=E3=80=82=E8=8B=A5=E9=9D=9E=E6=82=A8=E6=9C=AC=E4=BA=BA=E6=93=8D=E4=BD=9C=EF=BC=8C=E8=AB=8B=E5=84=98=E9=80=9F=E8=88=87=E6=9C=AC=E8=A1=8C=E8=81=AF=E7=B9=AB=EF=BC=8C=E4=B8=A6=E8=AB=8B=E7=AB=8B=E5=8D=B3=E9=87=8D=E8=A8=AD=E7=B6=B2=E9=8A=80=E5=AF=86=E7=A2=BC=E3=80=82",
    "--inner--",
    "--outer",
    "Content-Type: application/pkcs7-signature",
    "",
    "ignored",
    "--outer--",
  ].join("\n");
  const nested = {
    id: "nested",
    internalDate: "1001",
    raw: `${directHeaders}\nSubject: =?utf-8?B?Q1VCRSDntrLot6/pioDooYznmbvlhaXlhanmraXpqZ/pqZforYk=?=\n${nestedBody}`,
  };
  const parsed = parseGmailRawMessage(nested.raw);
  assert.equal(parsed.subject, CATHAY_GMAIL_OTP_SUBJECT);
  assert.match(parsed.body, /ABCD-123456/);
  assert.deepEqual(inspectCathayGmailOtpMessage(nested, 1000), { status: "eligible", otp: "ABCD-123456" });
  assert.deepEqual(inspectCathayGmailOtpMessage({ ...plainMessage({ headers: hmeHeaders }), id: "hme" }, 1000), { status: "eligible", otp: "ABCD-123456" });
  const splitDirectHeaders = [
    `Authentication-Results: mx.google.com; dkim=pass header.d=${CATHAY_GMAIL_SENDER_DOMAIN}; dmarc=fail header.from=forged.example`,
    "Authentication-Results: mx.google.com; dkim=fail header.d=forged.example; dmarc=pass header.from=cathaybk.com.tw",
    "From: alerts@cathaybk.com.tw",
  ].join("\n");
  assert.equal(
    rejectionReason(inspectCathayGmailOtpMessage({ ...plainMessage({ headers: splitDirectHeaders }), id: "split-direct" }, 1000)),
    "unauthenticated-cathay-alignment",
  );
  const splitHmeHeaders = hmeHeaders.replace(
    `Authentication-Results: mx.google.com; dkim=pass header.i=@icloud.com; dmarc=pass header.from=icloud.com`,
    [
      "Authentication-Results: mx.google.com; dkim=pass header.i=@icloud.com; dmarc=fail header.from=forged.example",
      "Authentication-Results: mx.google.com; dkim=fail header.i=@forged.example; dmarc=pass header.from=icloud.com",
    ].join("\n"),
  );
  assert.equal(
    rejectionReason(inspectCathayGmailOtpMessage({ ...plainMessage({ headers: splitHmeHeaders }), id: "split-hme" }, 1000)),
    "unauthenticated-hme-relay-auth",
  );
  assert.equal(
    rejectionReason(inspectCathayGmailOtpMessage({
      ...plainMessage({ headers: hmeHeaders.replace(CATHAY_GMAIL_SENDER_DOMAIN, `evil${CATHAY_GMAIL_SENDER_DOMAIN}`) }),
      id: "hme-prefix-forgery",
    }, 1000)),
    "unauthenticated-hme-original-sender",
  );
  assert.equal(
    rejectionReason(inspectCathayGmailOtpMessage({
      ...plainMessage({ headers: hmeHeaders.replace(CATHAY_GMAIL_SENDER_DOMAIN, `${CATHAY_GMAIL_SENDER_DOMAIN}.evil`) }),
      id: "hme-suffix-forgery",
    }, 1000)),
    "unauthenticated-hme-original-sender",
  );
  assert.equal(
    rejectionReason(inspectCathayGmailOtpMessage({
      ...plainMessage({
        headers: hmeHeaders.replace(
          `f=destination@gmail.com; r=to; s=relay@${CATHAY_GMAIL_SENDER_DOMAIN}`,
          `f=relay@${CATHAY_GMAIL_SENDER_DOMAIN}; r=to; s=relay@evil.example`,
        ),
      }),
      id: "hme-destination-confused-for-original",
    }, 1000)),
    "unauthenticated-hme-original-sender",
  );
  assert.equal(
    rejectionReason(inspectCathayGmailOtpMessage({
      ...plainMessage({ headers: hmeHeaders.replace("h=from:to:subject:x-icloud-hme", "h=from:to:subject") }),
      id: "hme-unsigned-relay-header",
    }, 1000)),
    "unauthenticated-hme-relay-signature",
  );
  assert.equal(rejectionReason(inspectCathayGmailOtpMessage(plainMessage({ internalDate: "1000" }), 1000)), "stale-candidate");
  assert.equal(rejectionReason(inspectCathayGmailOtpMessage(plainMessage({ body: "CUBE 5 分鐘 ABCD-123456 EFGH-654321 登入兩步驟驗證 若非您本人操作 重設網銀密碼" }), 1000)), "malformed-candidate");
  assert.equal(rejectionReason(inspectCathayGmailOtpMessage(plainMessage({ headers: "From: forged@example.com" }), 1000)), "unauthenticated-google-results");
});

test("polling accepts only one post-boundary candidate and times out safely", async () => {
  let now = 0;
  let attempts = 0;
  const found = await pollCathayGmailOtp({
    requestedAfterMs: 0,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    listMessages: async () => {
      attempts += 1;
      return attempts === 1 ? { messages: [] } : { messages: [{ id: "message-1001" }] };
    },
    getMessage: async () => plainMessage(),
    timeoutMs: 10_000,
    intervalMs: 5_000,
  });
  assert.deepEqual(found, { status: "found", otp: "ABCD-123456" });
  now = 0;
  const timeout = await pollCathayGmailOtp({
    requestedAfterMs: 0,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    listMessages: async () => ({ messages: [] }),
    getMessage: async () => plainMessage(),
    timeoutMs: 10_000,
    intervalMs: 5_000,
  });
  assert.deepEqual(timeout, { status: "fallback", reason: "timeout" });
  const ambiguous = await pollCathayGmailOtp({
    requestedAfterMs: 0,
    now: () => 1,
    listMessages: async () => ({ messages: [{ id: "a" }, { id: "b" }] }),
    getMessage: async (id) => plainMessage({ internalDate: id === "a" ? "1001" : "1002" }),
    timeoutMs: 0,
  });
  assert.deepEqual(ambiguous, { status: "fallback", reason: "ambiguous-candidate" });

  const clockSkewedNewMessage = await pollCathayGmailOtp({
    requestedAfterMs: 1_000,
    knownMessageIds: new Set(["old"]),
    now: () => 2_000,
    listMessages: async () => ({ messages: [{ id: "new" }, { id: "old" }] }),
    getMessage: async (id) => ({
      ...plainMessage({ internalDate: id === "new" ? "999" : "500" }),
      id,
    }),
    timeoutMs: 0,
  });
  assert.deepEqual(clockSkewedNewMessage, { status: "found", otp: "ABCD-123456" });
});

test("host token persistence is encrypted and never copied to workflow env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-service-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const codec = {
    encrypt(text: string) { return Buffer.from(`safe:${text}`).toString("base64"); },
    decrypt(payload: string) { return Buffer.from(payload, "base64").toString().slice(5); },
  };
  setAutomationCredentialCodec(codec);
  try {
    writeAutomationSettingsFile(settingsPath, { [CATHAY_GMAIL_OTP_ENABLED_KEY]: true });
    writeAutomationCredentialsFile(credentialsPath, {});
    const service = createCathayGmailOtpService({
      settingsPath,
      credentialsPath,
      oauthAuthorize: async () => ({ refreshToken: "refresh-secret", connectedEmail: "test@gmail.com" }),
    });
    assert.deepEqual(await service.enable(), { enabled: true, connectedEmail: "test@gmail.com", needsAuthorization: false });
    const encrypted = readFileSync(credentialsPath, "utf8");
    assert.equal(encrypted.includes("refresh-secret"), false);
    const values = readAutomationCredentialsFile(credentialsPath);
    assert.equal(values[CATHAY_GMAIL_REFRESH_TOKEN_KEY], "refresh-secret");
    assert.equal(values[CATHAY_GMAIL_CONNECTED_EMAIL_KEY], "test@gmail.com");
    assert.equal(automationConfigEnv({ baseEnv: {}, settings: {}, credentials: values })[CATHAY_GMAIL_REFRESH_TOKEN_KEY], undefined);
    assert.equal(automationConfigEnv({ baseEnv: {}, settings: {}, credentials: values })[CATHAY_GMAIL_CONNECTED_EMAIL_KEY], undefined);
    const revoked: string[] = [];
    const disconnecting = createCathayGmailOtpService({
      settingsPath,
      credentialsPath,
      fetch: async (url) => { revoked.push(String(url)); return new Response(null, { status: 200 }); },
    });
    assert.deepEqual(await disconnecting.disconnect(), { enabled: false, connectedEmail: null, needsAuthorization: false });
    assert.equal(revoked.length, 1);
    assert.match(revoked[0]!, /oauth2\.googleapis\.com\/revoke/);
    assert.equal(readAutomationCredentialsFile(credentialsPath)[CATHAY_GMAIL_REFRESH_TOKEN_KEY], undefined);
  } finally {
    setAutomationCredentialCodec(null);
    resetCathayGmailOtpServiceForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail authorization fails closed when safe credential storage is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-no-codec-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  setAutomationCredentialCodec(null);
  let oauthCalls = 0;
  try {
    writeAutomationSettingsFile(settingsPath, { [CATHAY_GMAIL_OTP_ENABLED_KEY]: true });
    writeAutomationCredentialsFile(credentialsPath, {});
    const service = createCathayGmailOtpService({
      settingsPath,
      credentialsPath,
      oauthAuthorize: async () => {
        oauthCalls += 1;
        return { refreshToken: "must-not-persist", connectedEmail: "test@gmail.com" };
      },
    });
    assert.deepEqual(await service.ensureAccess(), { status: "fallback", reason: "not-configured" });
    assert.deepEqual(await service.enable(), {
      enabled: false,
      connectedEmail: null,
      needsAuthorization: false,
      connectionError: "credential-storage-failed",
    });
    assert.equal(oauthCalls, 0);
    assert.equal(readAutomationCredentialsFile(credentialsPath)[CATHAY_GMAIL_REFRESH_TOKEN_KEY], undefined);
    assert.equal(readFileSync(credentialsPath, "utf8").includes("must-not-persist"), false);
  } finally {
    setAutomationCredentialCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabling keeps the grant and re-enabling refreshes it without OAuth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-reenable-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  writeAutomationSettingsFile(settingsPath, { [CATHAY_GMAIL_OTP_ENABLED_KEY]: true });
  writeAutomationCredentialsFile(credentialsPath, {
    [CATHAY_GMAIL_REFRESH_TOKEN_KEY]: "refresh-grant",
    [CATHAY_GMAIL_CONNECTED_EMAIL_KEY]: "test@gmail.com",
  });
  let oauthCalls = 0;
  let refreshCalls = 0;
  setAutomationCredentialCodec(fakeCredentialCodec);
  const service = createCathayGmailOtpService({
    settingsPath,
    credentialsPath,
    fetch: async () => {
      refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    },
    oauthAuthorize: async () => {
      oauthCalls += 1;
      return { refreshToken: "unexpected-oauth", connectedEmail: "test@gmail.com" };
    },
    now: () => 1000,
  });
  try {
    assert.deepEqual(await service.setEnabled(false), { enabled: false, connectedEmail: "test@gmail.com", needsAuthorization: false });
    assert.equal(readAutomationCredentialsFile(credentialsPath)[CATHAY_GMAIL_REFRESH_TOKEN_KEY], "refresh-grant");
    assert.deepEqual(await service.enable(), { enabled: true, connectedEmail: "test@gmail.com", needsAuthorization: false });
    assert.equal(refreshCalls, 1);
    assert.equal(oauthCalls, 0);
  } finally {
    setAutomationCredentialCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid_grant opens the browser path again through single-flight authorization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-refresh-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const oldClientId = process.env.OCTOPUSBEAK_GOOGLE_OAUTH_CLIENT_ID;
  process.env.OCTOPUSBEAK_GOOGLE_OAUTH_CLIENT_ID = "test-client";
  setAutomationCredentialCodec(fakeCredentialCodec);
  try {
    writeAutomationSettingsFile(settingsPath, { [CATHAY_GMAIL_OTP_ENABLED_KEY]: true });
    writeAutomationCredentialsFile(credentialsPath, {
      [CATHAY_GMAIL_REFRESH_TOKEN_KEY]: "expired",
      [CATHAY_GMAIL_CONNECTED_EMAIL_KEY]: "test@gmail.com",
    });
    let refreshes = 0;
    const service = createCathayGmailOtpService({
      settingsPath,
      credentialsPath,
      fetch: async () => {
        refreshes += 1;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      },
      oauthAuthorize: async () => ({ refreshToken: "new-refresh", connectedEmail: "test@gmail.com" }),
    });
    assert.deepEqual(await service.ensureAccess(), { status: "ready" });
    assert.equal(refreshes, 1);
    assert.equal(readAutomationCredentialsFile(credentialsPath)[CATHAY_GMAIL_REFRESH_TOKEN_KEY], "new-refresh");
  } finally {
    if (oldClientId === undefined) delete process.env.OCTOPUSBEAK_GOOGLE_OAUTH_CLIENT_ID;
    else process.env.OCTOPUSBEAK_GOOGLE_OAUTH_CLIENT_ID = oldClientId;
    setAutomationCredentialCodec(null);
    resetCathayGmailOtpServiceForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful OTP is never written to a log by the host service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cathay-gmail-no-log-"));
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  setAutomationCredentialCodec(fakeCredentialCodec);
  writeAutomationSettingsFile(settingsPath, { [CATHAY_GMAIL_OTP_ENABLED_KEY]: true });
  writeAutomationCredentialsFile(credentialsPath, {
    [CATHAY_GMAIL_REFRESH_TOKEN_KEY]: "refresh",
    [CATHAY_GMAIL_CONNECTED_EMAIL_KEY]: "test@gmail.com",
  });
  let listCalls = 0;
  const service = createCathayGmailOtpService({
    settingsPath,
    credentialsPath,
    oauthAuthorize: async () => ({ refreshToken: "refresh", connectedEmail: "test@gmail.com" }),
    fetch: async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }),
    api: {
      listMessages: async () => ({ messages: listCalls++ === 0 ? [] : [{ id: "one" }] }),
      getMessage: async () => plainMessage({ internalDate: "999" }),
    },
    now: () => 1000,
  });
  const oldLog = console.log;
  const oldError = console.error;
  const output: string[] = [];
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => output.push(args.join(" "));
  try {
    const boundary = await service.prepareRetrieval();
    assert.equal(boundary.status, "prepared");
    assert.deepEqual(
      await service.retrieve(boundary.status === "prepared" ? boundary.boundaryId : "invalid"),
      { status: "found", otp: "ABCD-123456" },
    );
    assert.equal(output.some((line) => line.includes("ABCD-123456")), false);
  } finally {
    console.log = oldLog;
    console.error = oldError;
    setAutomationCredentialCodec(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
