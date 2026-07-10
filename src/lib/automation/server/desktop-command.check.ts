import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  resolveLibrettoCommand,
  resolveNodeScriptCommand,
  resolvePatchCommand,
  resolveTaskCommand,
} from "./desktop-command.ts";
import { taskById } from "./tasks.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../../../../package.json") as {
  scripts: Record<string, string>;
};

const env = {
  OCTOPUSBEAK_DESKTOP: "1",
  OCTOPUSBEAK_APP_ROOT: "/AppRoot",
  OCTOPUSBEAK_NODE_PATH: "/AppRoot/OctopusBeak",
  PLAYWRIGHT_BROWSERS_PATH: "/AppRoot/node_modules/playwright-core/.local-browsers",
};

const fubon = taskById("fubon-all-statements");
assert.ok(fubon);
assert.deepEqual(
  resolveTaskCommand(fubon, {}, env),
  {
    display: "run:fubon-all-statements",
    command: "/AppRoot/OctopusBeak",
    args: [
      join("/AppRoot", "node_modules", "libretto", "dist", "cli", "index.js"),
      "run",
      join("/AppRoot", "src", "workflows", "fubon-all-statements.ts"),
      "--headless",
    ],
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  },
);

const importTask = taskById("import-downloads-csv");
assert.ok(importTask);
assert.deepEqual(
  resolveTaskCommand(importTask, {}, env).args,
  [
    "--no-warnings",
    "--experimental-strip-types",
    join("/AppRoot", "src", "ledger", "import-downloads-csv.ts"),
  ],
);

assert.deepEqual(
  resolveTaskCommand(fubon, {}, { PATH: "/usr/bin" }),
  {
    display: "run:fubon-all-statements",
    command: "npm",
    args: ["run", "run:fubon-all-statements"],
    env: { PATH: "/usr/bin" },
  },
);

const eInvoice = taskById("einvoice-personal-invoices");
assert.ok(eInvoice);
const eInvoiceCommand = resolveTaskCommand(eInvoice, {}, { PATH: "/usr/bin" });
assert.deepEqual(eInvoiceCommand, {
  display: "run:einvoice-personal-invoices",
  command: "npm",
  args: ["run", "run:einvoice-personal-invoices"],
  env: { PATH: "/usr/bin" },
});
assert.equal(
  packageJson.scripts[eInvoiceCommand.display],
  "libretto run src/workflows/einvoice-personal-invoices.ts --headless",
);

assert.deepEqual(
  resolveLibrettoCommand(["resume", "--session", "ses-123"], env),
  {
    display: "libretto resume --session ses-123",
    command: "/AppRoot/OctopusBeak",
    args: [
      join("/AppRoot", "node_modules", "libretto", "dist", "cli", "index.js"),
      "resume",
      "--session",
      "ses-123",
    ],
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  },
);

assert.deepEqual(
  resolveNodeScriptCommand(["--no-warnings", "scripts/patch-libretto-run-cdp.mjs"], env).args,
  ["--no-warnings", join("/AppRoot", "scripts", "patch-libretto-run-cdp.mjs")],
);

assert.deepEqual(
  resolvePatchCommand({}, env)?.args,
  [join("/AppRoot", "scripts", "patch-libretto-run-cdp.mjs")],
);
assert.equal(resolvePatchCommand({ resumeSession: "ses-123" }, env), null);
