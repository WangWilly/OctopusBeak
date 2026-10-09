import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { applyOctopusBeakAppIdentity } from "../electron/app-identity.ts";
import { safeStorageCredentialCodec } from "../electron/credential-codec.ts";
import { TdccError } from "../src/workflows/tdcc-epassbook-client.ts";
import { TDCC_PROBE_USAGE, runTdccProbe } from "./tdcc-probe/probe.ts";
import { createTdccSecretStore } from "../src/lib/automation/server/tdcc-secret-store.ts";
import { createProbeTerminal } from "./tdcc-probe/terminal.ts";

const REPORTS_DIRECTORY = fileURLToPath(new URL("../reports/tdcc-probe/", import.meta.url));

function exitWith(text, code) {
  process.stdout.write(`${text}\n`, () => app.exit(code));
}

const userData = applyOctopusBeakAppIdentity(app);
const credentialsPath = join(userData, "credentials.json");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  exitWith([
    TDCC_PROBE_USAGE,
    "",
    `Runtime: Electron ${process.versions.electron}`,
    `Credentials: ${credentialsPath}`,
    `Reports: ${REPORTS_DIRECTORY}`,
  ].join("\n"), 0);
} else if (args.length > 0) {
  exitWith(`Unknown arguments: ${args.join(" ")}\n\n${TDCC_PROBE_USAGE}`, 2);
} else {
  app.dock?.hide();
  app.whenReady().then(async () => {
    const terminal = createProbeTerminal();
    let codec;
    try {
      codec = safeStorageCredentialCodec();
    } catch (error) {
      exitWith(`Refusing to run: ${error instanceof Error ? error.message : String(error)}`, 1);
      return;
    }
    terminal.print("Quit Octopus Beak before continuing. The App and this probe both write credentials.json.");
    terminal.print(`Credentials: ${credentialsPath}`);
    try {
      const reportPath = await runTdccProbe({
        store: createTdccSecretStore(credentialsPath, codec),
        reportsDirectory: REPORTS_DIRECTORY,
        terminal,
      });
      exitWith(`Report written to ${reportPath}`, 0);
    } catch (error) {
      const detail = error instanceof TdccError && error.providerMessage ? ` TDCC said "${error.providerMessage}".` : "";
      exitWith(`TDCC probe failed: ${error instanceof Error ? error.message : String(error)}${detail}`, 1);
    }
  });
}
