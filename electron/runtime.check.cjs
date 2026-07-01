const assert = require("node:assert/strict");
const fs = require("node:fs");
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

  try {
    ensureDataRoot(root);
    assert.equal(fs.existsSync(path.join(root, ".env")), true);
    assert.equal(fs.existsSync(path.join(root, ".libretto")), true);
    assert.equal(fs.existsSync(path.join(root, "downloads")), true);
    assert.equal(fs.existsSync(path.join(root, "data", "ledger")), true);
    assert.equal(fs.existsSync(path.join(root, "data", "automation", "logs")), true);
    assert.equal(
      fs.readFileSync(path.join(root, ".env"), "utf8"),
      "AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei\n",
    );

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
    }, port);
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    assert.equal(address.address, "127.0.0.1");
    server.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
