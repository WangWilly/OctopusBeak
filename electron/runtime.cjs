const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

function ensureDataRoot(userData) {
  fs.mkdirSync(path.join(userData, ".libretto"), { recursive: true });
  fs.mkdirSync(path.join(userData, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(userData, "data", "ledger"), { recursive: true });
  fs.mkdirSync(path.join(userData, "data", "automation", "logs"), { recursive: true });

  const envPath = path.join(userData, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, "AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei\n", "utf8");
  }
}

function buildDesktopEnv({ userData, appRoot, port, electronPath = process.execPath }) {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
    NODE_ENV: "production",
    LEDGER_DIR: path.join(userData, "data", "ledger"),
    OCTOPUSBEAK_DESKTOP: "1",
    OCTOPUSBEAK_APP_ROOT: appRoot,
    OCTOPUSBEAK_USER_DATA: userData,
    OCTOPUSBEAK_NODE_PATH: electronPath,
    PLAYWRIGHT_BROWSERS_PATH: path.join(appRoot, "node_modules", "playwright-core", ".local-browsers"),
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not allocate a local port."));
      });
    });
  });
}

function listenWithHandler(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

module.exports = {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
};
