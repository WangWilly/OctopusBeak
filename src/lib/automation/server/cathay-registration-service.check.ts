import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import { signInCathayForApp, type CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import { ProductCollectionFatalError } from "../product-collection.ts";
import { createAppWorkflowBrowserPort } from "./app-browser-host.ts";
import {
  createCathayRegistrationService,
  createCathaySecretStore,
} from "./cathay-registration-service.ts";
import { writeAutomationCredentialsFile } from "./config-files.ts";
import { createSourceDeviceLock, type SourceDeviceLock } from "./source-device-lock.ts";

const USER_ID = ["A", "1", "23456789"].join("");
const SIGN_IN = { cathay_user_id: USER_ID, cathay_account: "synthetic-code", cathay_password: "synthetic-password" };
const CODE = "246810";
const TASK_ID = "cathay-all-statements";

const codec = {
  encrypt: (text: string) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload: string) => Buffer.from(payload, "base64").toString("utf8"),
};

type FixtureOptions = Readonly<{
  view?: "sms" | "email-behind-toggle";
  codeOutcome?: "expired";
}>;

type FixtureLog = {
  logins: number;
  trustedLogins: number;
  sends: string[];
  submits: string[];
  trustedNames: string[];
};

function loginPage(view: NonNullable<FixtureOptions["view"]>) {
  return `<!doctype html><meta charset="utf-8"><title>Synthetic Cathay</title>
<input id="CustID"><input id="UserIdKeyin"><input id="PasswordKeyin" type="password">
<button class="js-login" type="button">登入</button>
<section id="otp" hidden>
  <a href="#" id="email-link">Email驗證</a>
  <div class="js-otp-view" id="sms-view" ${view === "sms" ? "" : "hidden"}>
    <button id="js-otp-send" type="button">發送簡訊驗證碼</button>
    <input id="sms-code" type="text" inputmode="numeric" maxlength="6">
  </div>
  <div id="email-view" hidden>
    <button id="js-otp-email-send" type="button">發送 Email 驗證碼</button>
    <input id="OtpMailPassword" type="text">
  </div>
  <button id="btnConfirm" type="button">確定</button>
  <p id="otp-message"></p>
</section>
<div id="trust" role="dialog" hidden>
  <p>信任這台裝置？</p>
  <button id="trust-yes" type="button">信任這台裝置</button>
  <button id="trust-no" type="button">暫時不用加入信任裝置</button>
  <div id="trust-name" hidden><input placeholder="請輸入裝置名稱"><button aria-label="確定" type="button">確定</button></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const post = (path) => fetch(path, { method: "POST", credentials: "include" }).then((response) => response.json());
const home = () => { location.href = "/OnlineBanking/Home"; };
let channel = null;
document.querySelector(".js-login").onclick = async () => {
  const { trusted } = await post("/fixture/login");
  if (trusted) home(); else $("otp").hidden = false;
};
$("email-link").onclick = (event) => { event.preventDefault(); $("sms-view").hidden = true; $("email-view").hidden = false; };
$("js-otp-send").onclick = async () => { channel = "sms"; await post("/fixture/send?channel=sms"); };
$("js-otp-email-send").onclick = async () => { channel = "email"; await post("/fixture/send?channel=email"); };
$("btnConfirm").onclick = async () => {
  const code = (channel === "email" ? $("OtpMailPassword") : $("sms-code")).value;
  const { outcome } = await post("/fixture/verify?code=" + encodeURIComponent(code));
  if (outcome === "accepted") { $("otp").hidden = true; $("trust").hidden = false; }
  else $("otp-message").textContent = outcome === "expired" ? "驗證碼已逾時，請重新取得" : "驗證碼錯誤，請重新輸入";
};
$("trust-yes").onclick = () => { $("trust-name").hidden = false; };
$("trust-name").querySelector("button").onclick = async () => {
  await post("/fixture/trust?name=" + encodeURIComponent($("trust-name").querySelector("input").value));
  home();
};
$("trust-no").onclick = home;
</script>`;
}

async function installCathayFixture(context: BrowserContext, options: FixtureOptions, log: FixtureLog) {
  await context.route("https://www.cathaybk.com.tw/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const trusted = /(?:^|;\s*)CUB\.eBank\.DeviceId=/u.test((await request.allHeaders()).cookie ?? "");
    switch (url.pathname) {
      case "/MyBank/":
        return await route.fulfill({ contentType: "text/html; charset=utf-8", body: loginPage(options.view ?? "sms") });
      case "/fixture/login":
        log.logins += 1;
        if (trusted) log.trustedLogins += 1;
        return await route.fulfill({ json: { trusted } });
      case "/fixture/send":
        log.sends.push(url.searchParams.get("channel") ?? "");
        return await route.fulfill({ json: {} });
      case "/fixture/verify": {
        const code = url.searchParams.get("code") ?? "";
        log.submits.push(code);
        const outcome = options.codeOutcome ?? (code === CODE ? "accepted" : "rejected");
        return await route.fulfill({ json: { outcome } });
      }
      case "/fixture/trust":
        log.trustedNames.push(url.searchParams.get("name") ?? "");
        return await route.fulfill({
          json: {},
          headers: {
            "set-cookie": "CUB.eBank.DeviceId=synthetic-device; Domain=.cathaybk.com.tw; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax",
          },
        });
      case "/OnlineBanking/Home":
        return await route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><a href="#">登出</a>' });
      default:
        return await route.fulfill({ status: 404, body: "" });
    }
  });
}

async function withFixture(
  options: FixtureOptions,
  body: (context: Readonly<{
    service: ReturnType<typeof createCathayRegistrationService>;
    log: FixtureLog;
    lock: SourceDeviceLock;
    credentialsText: () => Promise<string>;
    cookieJarText: () => Promise<string>;
    openRunPage<T>(run: (page: Page) => Promise<T>): Promise<T>;
  }>) => Promise<void>,
  serviceOptions: Readonly<{ codeTimeoutMs?: number; signInDetails?: boolean }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cathay-registration-"));
  const credentialsPath = join(root, "credentials.json");
  writeAutomationCredentialsFile(
    credentialsPath,
    serviceOptions.signInDetails === false
      ? {}
      : Object.fromEntries(Object.entries(SIGN_IN).map(([key, value]) => [`LIBRETTO_CLOUD_${key.toUpperCase()}`, value])),
    codec,
  );
  const log: FixtureLog = { logins: 0, trustedLogins: 0, sends: [], submits: [], trustedNames: [] };
  const lock = createSourceDeviceLock();
  let runs = 0;
  const openPage = <T>(signal: AbortSignal, run: (page: Page) => Promise<T>) =>
    createAppWorkflowBrowserPort({
      taskId: TASK_ID,
      taskRunId: `fixture-run-${runs += 1}`,
      signal,
      userDataDirectory: root,
      credentialCodec: codec,
      browserProfile: "cathay-login",
    }).withPage(async (page) => {
      await installCathayFixture(page.context(), options, log);
      return await run(page);
    });
  const service = createCathayRegistrationService({
    store: createCathaySecretStore(credentialsPath, codec),
    withCathayTaskPage: openPage,
    deviceLock: lock,
    ...(serviceOptions.codeTimeoutMs === undefined ? {} : { codeTimeoutMs: serviceOptions.codeTimeoutMs }),
  });
  try {
    await body({
      service,
      log,
      lock,
      credentialsText: async () => codec.decrypt(JSON.parse(await readFile(credentialsPath, "utf8")).data),
      cookieJarText: async () => {
        const path = join(root, "data", "automation", "browser-state", TASK_ID, "authentication", "cookies.safeStorage.json");
        return codec.decrypt(JSON.parse(await readFile(path, "utf8")).data);
      },
      openRunPage: (run) => openPage(new AbortController().signal, run),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const gmailNotConnected: CathayGmailOtpPort = {
  ensureAccess: async () => ({ status: "fallback", reason: "not-configured" }),
  prepareRetrieval: async () => assert.fail("no Gmail retrieval without a Gmail grant"),
  retrieve: async () => assert.fail("no Gmail retrieval without a Gmail grant"),
};

function signInAsRun(page: Page, events: string[]) {
  return signInCathayForApp(page, SIGN_IN, {
    otp: gmailNotConnected,
    signal: new AbortController().signal,
    event: async (code) => { events.push(code); },
  });
}

test("registering sends one code, adds the device as OctopusBeak, and a later run signs in without a code", async () => {
  await withFixture({}, async ({ service, log, lock, credentialsText, cookieJarText, openRunPage }) => {
    assert.deepEqual(service.status(), { registered: false });
    const sms = await service.start();
    assert.equal(sms.status, "code-required");
    assert.equal(sms.status === "code-required" && sms.channel, "sms");
    assert.deepEqual(log.sends, ["sms"]);
    assert.equal(lock.holder(), "registration", "no sync may start while the person reads the code");
    const registrationId = sms.status === "code-required" ? sms.registrationId : "";

    assert.deepEqual(await service.submitCode(registrationId, CODE), { status: "registered", channels: ["sms"] });
    assert.deepEqual(log.submits, [CODE]);
    assert.deepEqual(log.trustedNames, ["OctopusBeak"]);
    assert.deepEqual(service.status(), { registered: true });
    assert.equal(lock.holder(), null);
    assert.equal((await credentialsText()).includes(CODE), false, "no one-time code is written");
    assert.match(await cookieJarText(), /CUB\.eBank\.DeviceId/u, "the trusted-device cookie is saved with the task's browser state");

    const events: string[] = [];
    await openRunPage((page) => signInAsRun(page, events));
    assert.equal(log.trustedLogins, 1, "the run presented the restored device cookie");
    assert.deepEqual(log.sends, ["sms"], "the run never asked Cathay for a code");
    assert.equal(events.includes("device-registration-required"), false);
  });
});

test("a run that meets Cathay's OTP without connected Gmail stops asking for device registration and sends nothing", async () => {
  await withFixture({}, async ({ log, openRunPage }) => {
    const events: string[] = [];
    await assert.rejects(
      openRunPage((page) => signInAsRun(page, events)),
      (error: unknown) =>
        error instanceof ProductCollectionFatalError && error.errorCode === "device-registration-required",
    );
    assert.deepEqual(log.sends, []);
    assert.deepEqual(log.submits, []);
    assert.equal(events.at(-1), "device-registration-required");
  });
});

test("registration switches to the Email code when Cathay keeps its sender behind the Email link", async () => {
  await withFixture({ view: "email-behind-toggle" }, async ({ service, log }) => {
    const email = await service.start();
    assert.equal(email.status === "code-required" && email.channel, "email");
    const registrationId = email.status === "code-required" ? email.registrationId : "";
    assert.deepEqual(await service.submitCode(registrationId, CODE), { status: "registered", channels: ["email"] });
    assert.deepEqual(log.sends, ["email"]);
  });
});

test("a rejected or expired code ends the registration without trusting or recording the device", async () => {
  for (const [options, reason] of [[{}, "code-rejected"], [{ codeOutcome: "expired" }, "code-expired"]] as const) {
    await withFixture(options, async ({ service, log, lock, credentialsText }) => {
      const sms = await service.start();
      const registrationId = sms.status === "code-required" ? sms.registrationId : "";
      assert.deepEqual(await service.submitCode(registrationId, "135791"), { status: "failed", reason });
      assert.deepEqual(log.sends, ["sms"], "a failed code is never followed by another send");
      assert.deepEqual(log.trustedNames, []);
      assert.deepEqual(service.status(), { registered: false });
      assert.equal(lock.holder(), null);
      assert.equal((await credentialsText()).includes("CATHAY_TRUSTED_DEVICE_USER_ID"), false);
    });
  }
});

test("a registration ends when the code wait expires or the person cancels, and releases the device", async () => {
  await withFixture({}, async ({ service, lock }) => {
    const sms = await service.start();
    const registrationId = sms.status === "code-required" ? sms.registrationId : "";
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(await service.submitCode(registrationId, CODE), { status: "failed", reason: "expired" });
    assert.equal(lock.holder(), null);
  }, { codeTimeoutMs: 20 });

  await withFixture({}, async ({ service, log, lock }) => {
    const sms = await service.start();
    const registrationId = sms.status === "code-required" ? sms.registrationId : "";
    service.cancel(registrationId);
    assert.equal(lock.holder(), null, "a cancelled registration releases the device");
    assert.deepEqual(await service.submitCode(registrationId, CODE), { status: "failed", reason: "cancelled" });
    assert.deepEqual(log.submits, []);
  });
});

test("registration is refused while a Cathay sync runs and needs saved sign-in details", async () => {
  await withFixture({}, async ({ service, log, lock }) => {
    lock.claim("sync");
    assert.deepEqual(await service.start(), { status: "failed", reason: "sync-running" });
    assert.equal(log.logins, 0, "a refused registration never signs in");
    lock.release("sync");
  });
  await withFixture({}, async ({ service, log }) => {
    assert.deepEqual(await service.start(), { status: "failed", reason: "sign-in-details-missing" });
    assert.equal(log.logins, 0);
  }, { signInDetails: false });
});
