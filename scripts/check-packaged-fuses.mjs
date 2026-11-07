import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The fuse values Forge was asked to set, keyed by fuse index; the plugin's `version` is not a fuse. */
export function expectedFuses(forgeConfig) {
  const plugin = forgeConfig.plugins?.find((candidate) => candidate.name === "fuses");
  if (!plugin) throw new Error("forge.config.cjs configures no fuses plugin.");
  const { version: _version, ...fuses } = plugin.fusesConfig;
  return fuses;
}

/**
 * Each configured fuse whose value in the binary's wire differs. A wire byte
 * is "1" (0x31) when the fuse is on and "0" (0x30) when it is off.
 */
export function fuseMismatches(wire, expected) {
  return Object.entries(expected).flatMap(([fuse, enabled]) => {
    const actual = wire[fuse];
    const on = actual === "1".charCodeAt(0);
    const off = actual === "0".charCodeAt(0);
    return (enabled ? on : off) ? [] : [{ fuse: Number(fuse), expected: enabled, actual }];
  });
}

async function main(argv) {
  const appIndex = argv.indexOf("--app");
  const appPath = appIndex === -1 ? undefined : argv[appIndex + 1];
  if (!appPath) throw new Error("Usage: node scripts/check-packaged-fuses.mjs --app <OctopusBeak.app>");
  const forgeConfig = require(join(repoRoot, "forge.config.cjs"));
  const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
  const executable = join(appPath, "Contents", "MacOS", forgeConfig.packagerConfig.executableName);
  const mismatches = fuseMismatches(await getCurrentFuseWire(executable), expectedFuses(forgeConfig));
  if (mismatches.length > 0) {
    for (const { fuse, expected, actual } of mismatches) {
      console.error(`${FuseV1Options[fuse] ?? fuse}: expected ${expected ? "on" : "off"}, wire byte ${actual}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Packaged fuses match forge.config.cjs: ${executable}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
