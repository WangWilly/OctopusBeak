import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserRuntimeConfigurationError,
  browserRuntime,
  createBrowserRuntime,
  type BrowserRuntimeProfileId,
} from "./browser-runtime.ts";

test("default runtime resolves the installed Playwright Chromium build metadata", async () => {
  const resolved = await browserRuntime.resolve();
  assert.match(resolved.identity.chromiumVersion, /^\d{2,3}\.\d+\.\d+\.\d+$/u);
  assert.ok(resolved.userAgent.includes(`Chrome/${resolved.identity.chromiumVersion}`));
  assert.equal(resolved.identity.profileId, "default");
});

test("default and source profiles share a version-derived normal Chrome User-Agent", async () => {
  const runtime = createBrowserRuntime({
    getChromiumVersion: async () => "151.0.7922.34",
    platform: "darwin",
  });

  const defaultProfile = await runtime.resolve();
  const ctbcProfile = await runtime.resolve("ctbc-login");

  assert.deepEqual(defaultProfile.identity, {
    profileId: "default",
    profileRevision: 1,
    chromiumVersion: "151.0.7922.34",
  });
  assert.equal(defaultProfile.userAgent, ctbcProfile.userAgent);
  assert.match(defaultProfile.userAgent, /Chrome\/151\.0\.7922\.34/u);
  assert.doesNotMatch(defaultProfile.userAgent, /HeadlessChrome|Chrome\/143\./u);
  assert.deepEqual(defaultProfile.args, []);
  assert.deepEqual(ctbcProfile.args, ["--disable-blink-features=AutomationControlled"]);
  assert.equal(ctbcProfile.cookieResetDomain, "ctbcbank.com");
});

test("normal Chrome User-Agent uses the host platform token", async () => {
  const windows = createBrowserRuntime({ getChromiumVersion: async () => "151.0.7922.34", platform: "win32" });
  const linux = createBrowserRuntime({ getChromiumVersion: async () => "151.0.7922.34", platform: "linux" });

  assert.match((await windows.resolve()).userAgent, /Windows NT 10\.0; Win64; x64/u);
  assert.match((await linux.resolve()).userAgent, /X11; Linux x86_64/u);
});

test("unknown profiles and unavailable Chromium versions fail with stable sanitized codes", async () => {
  const runtime = createBrowserRuntime({ getChromiumVersion: async () => "151.0.7922.34", platform: "darwin" });
  await assert.rejects(runtime.resolve("unregistered-login" as BrowserRuntimeProfileId), (error: unknown) => {
    assert.ok(error instanceof BrowserRuntimeConfigurationError);
    assert.equal(error.code, "unsupported-profile");
    assert.equal(error.message, "browser-runtime/unsupported-profile");
    return true;
  });

  const unavailable = createBrowserRuntime({ getChromiumVersion: async () => { throw new Error("raw install path"); }, platform: "darwin" });
  await assert.rejects(unavailable.resolve(), (error: unknown) => {
    assert.ok(error instanceof BrowserRuntimeConfigurationError);
    assert.equal(error.code, "chromium-version-unavailable");
    assert.equal(error.message, "browser-runtime/chromium-version-unavailable");
    return true;
  });
});
