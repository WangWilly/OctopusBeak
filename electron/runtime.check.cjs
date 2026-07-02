const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildDesktopEnv, ensureDataRoot } = require("./runtime.cjs");

async function main() {
  assert.equal(typeof buildDesktopEnv, "function");
  assert.equal(typeof ensureDataRoot, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopusbeak-runtime-"));
  const defaultSettings = {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: true,
    LIBRETTO_CLOUD_ESUN_ENABLED: true,
    LIBRETTO_CLOUD_YUANTA_ENABLED: true,
    LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: true,
    LIBRETTO_CLOUD_CATHAY_ENABLED: true,
    LIBRETTO_CLOUD_HNCB_ENABLED: true,
    MAX_ENABLED: true,
    MAX_SUB_ACCOUNT: "main",
  };

  try {
    ensureDataRoot(root);
    const settingsPath = path.join(root, "settings.json");
    const credentialsPath = path.join(root, "credentials.json");
    assert.equal(fs.existsSync(settingsPath), true);
    assert.equal(fs.existsSync(credentialsPath), false);
    assert.equal(fs.existsSync(path.join(root, ".libretto")), true);
    assert.equal(fs.existsSync(path.join(root, "downloads")), true);
    assert.equal(fs.existsSync(path.join(root, "data", "ledger")), true);
    assert.equal(fs.existsSync(path.join(root, "data", "automation", "logs")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), defaultSettings);
    const existingSettingsText = `${JSON.stringify({ CUSTOM_SETTING: "keep-me" }, null, 2)}\n`;
    fs.writeFileSync(settingsPath, existingSettingsText, "utf8");
    ensureDataRoot(root);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettingsText);

    const missingBrowsersAppRoot = path.join(root, "missing-browsers-app");
    const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/tmp/inherited-playwright";
    const env = buildDesktopEnv({
      userData: root,
      appRoot: missingBrowsersAppRoot,
      electronPath: "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak",
    });
    if (originalBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.LEDGER_DIR, path.join(root, "data", "ledger"));
    assert.equal(env.OCTOPUSBEAK_DESKTOP, "1");
    assert.equal(env.OCTOPUSBEAK_APP_ROOT, missingBrowsersAppRoot);
    assert.equal(env.OCTOPUSBEAK_USER_DATA, root);
    assert.equal(env.OCTOPUSBEAK_NODE_PATH, "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak");
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, "/tmp/inherited-playwright");

    const packagedAppRoot = path.join(root, "packaged-app");
    const packagedBrowsersPath = path.join(packagedAppRoot, "node_modules", "playwright-core", ".local-browsers");
    fs.mkdirSync(packagedBrowsersPath, { recursive: true });
    const packagedEnv = buildDesktopEnv({
      userData: root,
      appRoot: packagedAppRoot,
      electronPath: "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak",
    });
    assert.equal(
      packagedEnv.PLAYWRIGHT_BROWSERS_PATH,
      packagedBrowsersPath,
    );

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
