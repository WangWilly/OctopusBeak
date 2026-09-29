const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { buildDesktopEnv, ensureDataRoot } = require("./runtime.cjs");

function executeMainWrapper({ appRoot, packaged, environment, onMainLoad = () => {} }) {
  const wrapperDirectory = path.join(appRoot, "electron");
  fs.mkdirSync(wrapperDirectory, { recursive: true });
  const wrapperPath = path.join(__dirname, "main.cjs");
  const wrapperSource = fs.readFileSync(wrapperPath, "utf8");
  let mainLoaded = false;
  const wrapperRequire = (specifier) => {
    if (specifier === "node:fs" || specifier === "node:path") return require(specifier);
    if (specifier === "electron") return { app: { isPackaged: packaged } };
    if (specifier === "../build-electron/main.cjs") {
      mainLoaded = true;
      onMainLoad(environment);
      return {};
    }
    throw new Error(`Unexpected main wrapper dependency: ${specifier}`);
  };

  vm.runInNewContext(wrapperSource, {
    __dirname: wrapperDirectory,
    process: { env: environment },
    require: wrapperRequire,
  }, { filename: wrapperPath });
  return mainLoaded;
}

async function main() {
  assert.equal(typeof buildDesktopEnv, "function");
  assert.equal(typeof ensureDataRoot, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopusbeak-runtime-"));
  const defaultSettings = {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    LIBRETTO_CLOUD_ESUN_ENABLED: false,
    LIBRETTO_CLOUD_YUANTA_ENABLED: false,
    LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: false,
    LIBRETTO_CLOUD_CATHAY_ENABLED: false,
    LIBRETTO_CLOUD_HNCB_ENABLED: false,
    LIBRETTO_CLOUD_CTBC_ENABLED: false,
    LIBRETTO_CLOUD_POST_ENABLED: false,
    LIBRETTO_CLOUD_SINOPAC_ENABLED: false,
    LIBRETTO_CLOUD_LINEBANK_ENABLED: false,
    LIBRETTO_CLOUD_EINVOICE_ENABLED: false,
    MAX_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  };

  try {
    const wrapperRoot = path.join(root, "main-wrapper-fixture");
    const browserRoot = path.join(
      wrapperRoot,
      "node_modules",
      "playwright-core",
      ".local-browsers",
    );
    const shellRevision = "1234";
    const shellDirectory = path.join(browserRoot, `chromium_headless_shell-${shellRevision}`);
    const playwrightRoot = path.join(wrapperRoot, "node_modules", "playwright-core");
    fs.mkdirSync(shellDirectory, { recursive: true });
    fs.writeFileSync(path.join(playwrightRoot, "browsers.json"), JSON.stringify({
      browsers: [{ name: "chromium-headless-shell", revision: shellRevision }],
    }));

    const inheritedGlobalCache = { PLAYWRIGHT_BROWSERS_PATH: "/tmp/developer-playwright-cache" };
    assert.equal(executeMainWrapper({
      appRoot: wrapperRoot,
      packaged: true,
      environment: inheritedGlobalCache,
      onMainLoad(environment) {
        assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, browserRoot);
      },
    }), true);
    assert.equal(inheritedGlobalCache.PLAYWRIGHT_BROWSERS_PATH, browserRoot);

    const packagedMissingRoot = path.join(root, "main-wrapper-missing-fixture");
    const missingPayloadEnvironment = { PLAYWRIGHT_BROWSERS_PATH: "/tmp/developer-playwright-cache" };
    let packagedMainLoaded = false;
    assert.throws(() => executeMainWrapper({
      appRoot: packagedMissingRoot,
      packaged: true,
      environment: missingPayloadEnvironment,
      onMainLoad() { packagedMainLoaded = true; },
    }), /Packaged Chromium headless-shell payload is unavailable/u);
    assert.equal(packagedMainLoaded, false, "A packaged App must fail before loading Playwright when its shell is absent.");
    assert.equal(missingPayloadEnvironment.PLAYWRIGHT_BROWSERS_PATH, "/tmp/developer-playwright-cache");

    const developmentEnvironment = { PLAYWRIGHT_BROWSERS_PATH: "/tmp/developer-playwright-cache" };
    assert.equal(executeMainWrapper({
      appRoot: packagedMissingRoot,
      packaged: false,
      environment: developmentEnvironment,
    }), true);
    assert.equal(developmentEnvironment.PLAYWRIGHT_BROWSERS_PATH, "/tmp/developer-playwright-cache");

    ensureDataRoot(root);
    const settingsPath = path.join(root, "settings.json");
    const credentialsPath = path.join(root, "credentials.json");
    assert.equal(fs.existsSync(settingsPath), true);
    assert.equal(fs.statSync(path.join(root, "data")).isDirectory(), true);
    assert.equal(fs.existsSync(credentialsPath), false);
    assert.equal(fs.existsSync(path.join(root, ".libretto")), false);
    assert.equal(fs.existsSync(path.join(root, "downloads")), false);
    assert.equal(fs.existsSync(path.join(root, "data", "ledger")), false);
    assert.equal(fs.existsSync(path.join(root, "data", "automation", "logs")), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(settingsPath, "utf8")),
      defaultSettings,
    );
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
    if (originalBrowsersPath === undefined)
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
    assert.equal(env.NODE_ENV, "production");
    assert.equal(Object.hasOwn(env, "LEDGER_DIR"), false);
    assert.equal(Object.hasOwn(env, "OCTOPUSBEAK_CANONICAL_LEDGER_DIR"), false);
    assert.equal(
      Object.hasOwn(env, "OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR"),
      false,
    );
    assert.equal(
      Object.hasOwn(env, "OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR"),
      false,
    );
    assert.equal(env.OCTOPUSBEAK_DESKTOP, "1");
    assert.equal(env.OCTOPUSBEAK_APP_ROOT, missingBrowsersAppRoot);
    assert.equal(env.OCTOPUSBEAK_USER_DATA, root);
    assert.equal(
      env.OCTOPUSBEAK_NODE_PATH,
      "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak",
    );
    assert.equal(Object.hasOwn(env, "LIBRETTO_REPO_ROOT"), false);
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, "/tmp/inherited-playwright");

    const packagedAppRoot = path.join(root, "packaged-app");
    const packagedBrowsersPath = path.join(
      packagedAppRoot,
      "node_modules",
      "playwright-core",
      ".local-browsers",
    );
    fs.mkdirSync(packagedBrowsersPath, { recursive: true });
    const packagedEnv = buildDesktopEnv({
      userData: root,
      appRoot: packagedAppRoot,
      electronPath: "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak",
    });
    assert.equal(packagedEnv.PLAYWRIGHT_BROWSERS_PATH, packagedBrowsersPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
