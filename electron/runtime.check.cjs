const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
} = require("./runtime.cjs");

async function main() {
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

    const env = buildDesktopEnv({
      userData: root,
      appRoot: "/Applications/OctopusBeak.app/Contents/Resources/app",
      port: 41234,
      electronPath: "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak",
    });
    assert.equal(env.HOST, "127.0.0.1");
    assert.equal(env.PORT, "41234");
    assert.equal(env.ORIGIN, "http://127.0.0.1:41234");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.LEDGER_DIR, path.join(root, "data", "ledger"));
    assert.equal(env.OCTOPUSBEAK_DESKTOP, "1");
    assert.equal(env.OCTOPUSBEAK_APP_ROOT, "/Applications/OctopusBeak.app/Contents/Resources/app");
    assert.equal(env.OCTOPUSBEAK_USER_DATA, root);
    assert.equal(env.OCTOPUSBEAK_NODE_PATH, "/Applications/OctopusBeak.app/Contents/MacOS/OctopusBeak");
    assert.equal(
      env.PLAYWRIGHT_BROWSERS_PATH,
      path.join("/Applications/OctopusBeak.app/Contents/Resources/app", "node_modules", "playwright-core", ".local-browsers"),
    );

    const port = await findFreePort();
    assert.equal(Number.isInteger(port), true);
    assert.equal(port > 0, true);

    const server = await listenWithHandler((request, response) => {
      response.end(request.url);
    }, 0);
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    assert.equal(address.address, "127.0.0.1");
    assert.equal(Number.isInteger(address.port), true);
    assert.equal(address.port > 0, true);
    const responseBody = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${address.port}/probe`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve(body);
        });
      }).on("error", reject);
    });
    assert.equal(responseBody, "/probe");
    server.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
