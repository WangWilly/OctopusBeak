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
assert.equal(fubon.script, "workflow:fubon-all-statements");
assert.equal(fubon.workflowId, "fubon-all-statements");
assert.deepEqual(fubon.command, []);
assert.throws(
  () => resolveTaskCommand(fubon, {}, env),
  /App workflow tasks do not have a Libretto command/u,
);

const yuanta = taskById("yuanta-all-statements");
assert.ok(yuanta);
assert.deepEqual(resolveTaskCommand(yuanta, {}, env).args.slice(-2), [
  "--params",
  '{"statements":{"telemetry":true}}',
]);
assert.deepEqual(
  resolveTaskCommand(yuanta, { session: "ses-octopus-123" }, env).args.slice(
    -4,
  ),
  [
    "--params",
    '{"statements":{"telemetry":true}}',
    "--session",
    "ses-octopus-123",
  ],
);
assert.deepEqual(
  resolveTaskCommand(
    yuanta,
    { resumeSession: "ses-octopus-123" },
    env,
  ).args.slice(-3),
  ["resume", "--session", "ses-octopus-123"],
);

const cathay = taskById("cathay-all-statements");
assert.ok(cathay);
assert.equal(cathay.script, "workflow:cathay-all-statements");
assert.equal(cathay.workflowId, "cathay-all-statements");
assert.deepEqual(cathay.command, []);
assert.throws(
  () => resolveTaskCommand(cathay, {}, env),
  /App workflow tasks do not have a Libretto command/u,
);
assert.throws(
  () => resolveTaskCommand(cathay, { session: "ses-octopus-123" }, env),
  /App workflow tasks do not have a Libretto command/u,
);
assert.throws(
  () => resolveTaskCommand(cathay, { resumeSession: "ses-octopus-123" }, env),
  /App workflow tasks do not have a Libretto command/u,
);

assert.equal(taskById("import-downloads-csv"), null);

assert.throws(
  () => resolveTaskCommand(fubon, { session: "ses-octopus-123" }, { PATH: "/usr/bin" }),
  /App workflow tasks do not have a Libretto command/u,
);

const eInvoice = taskById("einvoice-personal-invoices");
assert.ok(eInvoice);
assert.throws(
  () => resolveTaskCommand(eInvoice, {}, { PATH: "/usr/bin" }),
  /App workflow tasks do not have a Libretto command/u,
);
assert.equal(eInvoice.workflowId, "einvoice-personal-invoices");
assert.deepEqual(eInvoice.command, []);

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
