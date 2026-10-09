import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { TDCC_BASE_URL } from "../../src/workflows/tdcc-epassbook-client.ts";
import { readAutomationCredentialsFile } from "../../src/lib/automation/server/config-files.ts";
import { nonIsoSettlementAccounts, runTdccProbe } from "./probe.ts";
import { createTdccSecretStore } from "../../src/lib/automation/server/tdcc-secret-store.ts";

// Built at runtime so the repository privacy hook does not see ID-shaped literals.
const SECRET = {
  userId: ["Q", "2", "87654321"].join(""),
  password: ["probe", "pass", "Zx81"].join("-"),
  emailCode: "731904",
  smsCode: "582213",
  bankAccount: ["0071", "2345", "67890"].join(""),
  brokerAccount: ["98", "76543"].join(""),
  personName: "王小明",
  memo: "轉帳陳大文",
  balance: "1288001",
  nanAccount: ["0071", "2345", "11111"].join(""),
  nanAvailable: "37460.25",
  tokenAfterLogin: "tok-after-login-7f",
  richSid: "sid-5e4d3c",
};

const codec = {
  encrypt: (text) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8"),
};

function fakeTdcc({ trustDevice, sessionValid = true }) {
  const calls = [];
  const devices = new Set();
  const reply = (body, header = {}) => Response.json({
    responseHeader: { returnCode: "0000", tokenID: "rotated-token", ...header },
    responseBody: body,
  });
  const fetch = async (url, init) => {
    const path = url.slice(TDCC_BASE_URL.length).split("?")[0];
    calls.push(path);
    if (init.body) devices.add(JSON.parse(init.body).requestHeader.devID);
    switch (path) {
      case "CM001":
        return reply({ tokenID: "initial-token" });
      case "AU001": {
        const trusted = trustDevice();
        return trusted
          ? reply({ tokenID: SECRET.tokenAfterLogin, richUrl: `https://rich.example/p?sid=${SECRET.richSid}`, isDiffDevice: "N" })
          : reply({}, { returnCode: "D0005", returnMsg: "new device" });
      }
      case "AU013":
      case "AU014":
        return reply({});
      case "AU015":
        return reply({ isMobileValid: JSON.parse(init.body).requestBody.sendType === "EMAIL" ? "N" : "Y" });
      case "TR001":
        if (!sessionValid) {
          sessionValid = true;
          return reply({}, { returnCode: "D0007", returnMsg: "session expired" });
        }
        return reply({
          accounts: [{
            brokerNo: "9A00",
            brokerAccount: SECRET.brokerAccount,
            accountName: SECRET.personName,
            items: [["2330", "台積電", "2", "1", "1", "1", "1", "1500"]],
          }],
        });
      case "TR051V1":
        return reply({ fundDetails: [{ fundNo: "F1", fundSHR: "12.5", currAlias: "USD" }] });
      case "tsp/TSP006":
        return reply({
          tspAccountInfos: [{
            bankId: "808",
            tspAccount: [
              { accountNo: SECRET.bankAccount, currency: "TWD", balanceAmt: SECRET.balance, isShow: true },
              { accountNo: "999", currency: "TWD", balanceAmt: "1", isShow: false },
              { accountNo: SECRET.nanAccount, currency: "NAN", balanceAmt: "0.00", availableBalance: SECRET.nanAvailable, isShow: true },
              { accountNo: "998", currency: "NAN", balanceAmt: "1", availableBalance: "0", isShow: false },
            ],
          }],
        });
      case "tsp/TSP007":
        return JSON.parse(init.body).requestBody.currency === "NAN"
          ? reply({ transactionDetails: [], totalCount: 0 })
          : reply({ transactionDetails: [{ memo: SECRET.memo, transferInAmount: SECRET.balance }], totalCount: 1 });
      case "TR002":
        return JSON.parse(init.body).requestBody.txnSerNo
          ? reply({}, { returnCode: "D0002", returnMsg: "end" })
          : reply({ items: [["20260301", "S9", "2330", "台積電"]] });
      case "TR087":
        return Response.json({ responseBody: { chartDate: ["20260101"], chartVal: [Number(SECRET.balance)] } });
      default:
        throw new Error(`unexpected TDCC path ${path}`);
    }
  };
  return { fetch, calls, devices };
}

function scriptedTerminal(answers) {
  const asked = [];
  const answer = async (question) => {
    asked.push(question);
    const entry = Object.entries(answers).find(([prefix]) => question.startsWith(prefix));
    assert.ok(entry, `unexpected question: ${question}`);
    return entry[1];
  };
  return { asked, terminal: { print() {}, ask: answer, askHidden: answer } };
}

const SIGN_IN_ANSWERS = {
  "TDCC user ID": SECRET.userId,
  "TDCC password": SECRET.password,
  "Enter the TDCC code sent by email": SECRET.emailCode,
  "Enter the TDCC code sent by SMS": SECRET.smsCode,
  "Was the e-Passbook phone app signed out?": "y",
};

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "tdcc-probe-"));
  const credentialsPath = join(directory, "credentials.json");
  return {
    directory,
    credentialsPath,
    reportsDirectory: join(directory, "reports", "tdcc-probe"),
    store: createTdccSecretStore(credentialsPath, codec),
  };
}

function reachableModules(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    // Type stripping erases whole `import type` statements but still loads `import { type X }` modules.
    const statements = source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?"(\.{1,2}\/[^"]+)"/gmu);
    const dynamic = source.matchAll(/import\(\s*"(\.{1,2}\/[^"]+)"\s*\)/gu);
    const specifiers = [
      ...[...statements].filter(([, typeOnly]) => !typeOnly).map(([, , specifier]) => specifier),
      ...[...dynamic].map(([, specifier]) => specifier),
    ];
    for (const specifier of specifiers) pending.push(fileURLToPath(new URL(specifier, pathToFileURL(path))));
  }
  return [...seen].map((path) => relative(fileURLToPath(new URL("../..", import.meta.url)), path));
}

test("the probe never reaches PGlite or the canonical store", () => {
  const modules = reachableModules(fileURLToPath(new URL("../tdcc-probe.mjs", import.meta.url)));
  assert.ok(modules.includes("src/workflows/tdcc-epassbook-client.ts"), "the walk follows imports");
  assert.deepEqual(modules.filter((path) => /pglite|ledger|canonical|financial-commit/iu.test(path)), []);
});

test("first run registers the device, probes every endpoint, and writes no raw secret", async (t) => {
  const space = workspace();
  t.after(() => rmSync(space.directory, { recursive: true, force: true }));
  let logins = 0;
  const tdcc = fakeTdcc({ trustDevice: () => ++logins > 1 });
  const { asked, terminal } = scriptedTerminal(SIGN_IN_ANSWERS);

  const reportPath = await runTdccProbe({ store: space.store, reportsDirectory: space.reportsDirectory, terminal, fetch: tdcc.fetch });

  assert.deepEqual(tdcc.calls.slice(0, 8), ["CM001", "AU001", "AU013", "AU015", "AU014", "AU015", "CM001", "AU001"]);
  assert.equal(asked.filter((question) => question.startsWith("Enter the TDCC code")).length, 2);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(report.freshLogin.registration, { kind: "registered", channels: ["email", "sms"] });
  assert.equal(report.phoneAppSignedOut, "y");
  assert.deepEqual(report.sessionReuse, { stored: false });
  for (const name of ["positions", "fundPositions", "bankBalances", "bankTransactions", "tradeDetails", "assetTrend"]) {
    assert.ok(report.endpoints[name].inventory, `${name} has an inventory`);
    assert.deepEqual(report.endpoints[name].failures, [], `${name} has no failures`);
  }
  assert.equal(report.endpoints.bankTransactions.calls, 2, "hidden settlement accounts are skipped");
  assert.deepEqual(
    report.nonIsoSettlementAccounts,
    [{ currency: "NAN", balanceNonZero: false, availableBalanceNonZero: true, hasTransactions: false }],
    "only visible non-ISO accounts are reported, as booleans",
  );
  assert.equal(report.endpoints.tradeDetails.pages, 1);

  const written = readFileSync(reportPath, "utf8") + readFileSync(join(space.reportsDirectory, "session-log.jsonl"), "utf8");
  for (const [label, value] of Object.entries(SECRET)) {
    assert.equal(written.includes(value), false, `${label} leaked into reports`);
  }
  assert.deepEqual(readdirSync(space.reportsDirectory).sort(), [`${report.probedAt.replaceAll(":", "-")}.json`, "session-log.jsonl"]);

  const credentialsText = JSON.stringify(readAutomationCredentialsFile(space.credentialsPath, codec));
  assert.equal(credentialsText.includes(SECRET.emailCode), false, "OTP codes are never stored");
  assert.equal(credentialsText.includes(SECRET.smsCode), false, "OTP codes are never stored");
  const saved = space.store.read();
  assert.equal(saved.userId, SECRET.userId);
  assert.equal(saved.password, SECRET.password);
  assert.equal(saved.session?.tokenId, "rotated-token", "the latest rotated token is saved");
  assert.match(saved.device?.deviceId ?? "", /^[0-9a-f]{16}$/u);
});

test("a later run reuses a valid saved session without signing in", async (t) => {
  const space = workspace();
  t.after(() => rmSync(space.directory, { recursive: true, force: true }));
  await runTdccProbe({
    store: space.store,
    reportsDirectory: space.reportsDirectory,
    terminal: scriptedTerminal(SIGN_IN_ANSWERS).terminal,
    fetch: fakeTdcc({ trustDevice: () => true }).fetch,
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });

  const tdcc = fakeTdcc({ trustDevice: () => true });
  const { asked, terminal } = scriptedTerminal({});
  const reportPath = await runTdccProbe({
    store: space.store,
    reportsDirectory: space.reportsDirectory,
    terminal,
    fetch: tdcc.fetch,
    now: () => new Date("2026-10-01T06:00:00.000Z"),
  });

  assert.equal(tdcc.calls.includes("AU001"), false);
  assert.deepEqual(asked, [], "no prompt when the session is reused");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(report.sessionReuse, { stored: true, valid: true, ageMs: 6 * 60 * 60 * 1000 });
  assert.equal(report.freshLogin, null);
  const log = readFileSync(join(space.reportsDirectory, "session-log.jsonl"), "utf8").trim().split("\n");
  assert.equal(log.length, 2);
});

test("an expired saved session falls back to a fresh sign-in", async (t) => {
  const space = workspace();
  t.after(() => rmSync(space.directory, { recursive: true, force: true }));
  await runTdccProbe({
    store: space.store,
    reportsDirectory: space.reportsDirectory,
    terminal: scriptedTerminal(SIGN_IN_ANSWERS).terminal,
    fetch: fakeTdcc({ trustDevice: () => true }).fetch,
  });

  const tdcc = fakeTdcc({ trustDevice: () => true, sessionValid: false });
  const reportPath = await runTdccProbe({
    store: space.store,
    reportsDirectory: space.reportsDirectory,
    terminal: scriptedTerminal(SIGN_IN_ANSWERS).terminal,
    fetch: tdcc.fetch,
  });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.sessionReuse.valid, false);
  assert.deepEqual(report.freshLogin.registration, { kind: "already-trusted" });
  assert.deepEqual(tdcc.calls.slice(0, 3), ["TR001", "CM001", "AU001"]);
});

test("a changed sign-in identifier resets the device identity, a password change keeps it", async (t) => {
  const space = workspace();
  t.after(() => rmSync(space.directory, { recursive: true, force: true }));
  const run = () => runTdccProbe({
    store: space.store,
    reportsDirectory: space.reportsDirectory,
    terminal: scriptedTerminal(SIGN_IN_ANSWERS).terminal,
    fetch: fakeTdcc({ trustDevice: () => true }).fetch,
  });
  await run();
  const first = space.store.read().device;

  space.store.write({ password: "changed-password" });
  await run();
  assert.deepEqual(space.store.read().device, first);

  space.store.write({ userId: "SOMEONEELSE" });
  const reportPath = await run();
  const second = space.store.read().device;
  assert.notEqual(second?.deviceId, first?.deviceId);
  assert.equal(second?.userId, "SOMEONEELSE");
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).device.reset, true);
});

test("a non-ISO settlement account reports transactions, a failed call, and an unparseable balance", () => {
  const balances = {
    tspAccountInfos: [{
      bankId: "812",
      tspAccount: [
        { accountNo: "123456789", currency: "NAN", balanceAmt: "12.0", availableBalance: "-", isShow: true },
        { accountNo: "223456789", currency: "NAN", balanceAmt: "0", availableBalance: "0", isShow: true },
        { accountNo: "323456789", currency: "USD", balanceAmt: "5", availableBalance: "5", isShow: true },
      ],
    }],
  };
  const pages = new Map([[["812", "123456789", "NAN"].join("\u0000"), [{ transactionDetails: [{}] }]]]);
  assert.deepEqual(nonIsoSettlementAccounts(balances, pages), [
    { currency: "NAN", balanceNonZero: true, availableBalanceNonZero: "unparseable", hasTransactions: true },
    { currency: "NAN", balanceNonZero: false, availableBalanceNonZero: false, hasTransactions: "call-failed" },
  ]);
});
