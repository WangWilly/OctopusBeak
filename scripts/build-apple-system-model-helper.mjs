import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.stdout.write("Skipped Apple system model helper build on non-macOS.\n");
  process.exit(0);
}

const swiftArchitecture = process.arch === "arm64"
  ? "arm64"
  : process.arch === "x64"
    ? "x86_64"
    : null;
if (!swiftArchitecture) {
  throw new Error(`Unsupported Apple helper architecture: ${process.arch}`);
}
const swiftTarget = `${swiftArchitecture}-apple-macosx26.0`;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(projectRoot, "build-helpers");
const executable = join(outputDirectory, "apple-system-model-helper");
const source = join(projectRoot, "electron", "apple-system-model-helper.swift");
const moduleCache = join(outputDirectory, "swift-module-cache");

mkdirSync(moduleCache, { recursive: true });
const compiled = spawnSync("xcrun", [
  "swiftc",
  "-parse-as-library",
  "-target",
  swiftTarget,
  "-module-cache-path",
  moduleCache,
  "-o",
  executable,
  source,
], {
  encoding: "utf8",
  stdio: ["ignore", "inherit", "pipe"],
  env: {
    ...process.env,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR
      ?? "/Applications/Xcode.app/Contents/Developer",
  },
});

if (compiled.status !== 0) {
  if (typeof compiled.stderr === "string" && compiled.stderr.length > 0) {
    process.stderr.write(compiled.stderr);
  }
  if (compiled.error) {
    const detail = compiled.error instanceof Error
      ? compiled.error.message
      : String(compiled.error);
    process.stderr.write(`Apple system model helper build failed to launch xcrun: ${detail}\n`);
  } else if (compiled.status === null) {
    process.stderr.write("Apple system model helper build failed: xcrun exited without a status.\n");
  }
  process.exit(compiled.status ?? 1);
}
chmodSync(executable, 0o755);
process.stdout.write(`Built ${executable}\n`);
