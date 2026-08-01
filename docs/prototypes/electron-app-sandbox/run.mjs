#!/usr/bin/env node

/*
 * THROWAWAY PROTOTYPE — packages and runs the Electron / Swift helper probe.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import packager from "@electron/packager";
import { signAsync } from "@electron/osx-sign";

const prototypeRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(prototypeRoot, "../../..");
const outputRoot = path.join(repoRoot, "out", "prototype-electron-app-sandbox");
const stageRoot = path.join(outputRoot, "stage");
const appSource = path.join(prototypeRoot, "app");
const reportPath = path.join(outputRoot, "report.json");
const markdownPath = path.join(outputRoot, "report.md");

function command(commandName, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({
      ok: false,
      code: null,
      signal: null,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: `${Buffer.concat(stderr).toString("utf8")}${error.stack ?? error}`,
    }));
    child.on("close", (code, signal) => resolve({
      ok: code === 0,
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function requireCommand(commandName, args, options) {
  const result = await command(commandName, args, options);
  if (!result.ok) {
    throw new Error(`${commandName} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function hostInventory() {
  const [osVersion, identities, developerDir, notarytool] = await Promise.all([
    command("sw_vers", []),
    command("security", ["find-identity", "-v", "-p", "codesigning"]),
    command("xcode-select", ["-p"]),
    command("xcrun", ["notarytool", "help"]),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    macOS: osVersion.stdout.trim(),
    memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    electron: JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8")).version,
    developerDir: developerDir.stdout.trim(),
    fullXcodeSelected: developerDir.stdout.trim().endsWith(".app/Contents/Developer"),
    signingIdentities: identities.stdout.trim(),
    validSigningIdentityCount: Number(identities.stdout.match(/(\d+) valid identities found/)?.[1] ?? 0),
    notarytoolAvailable: notarytool.ok,
    notaryProfileConfigured: Boolean(process.env.OCTOPUSBEAK_NOTARY_PROFILE),
  };
}

async function prepareStage() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });
  fs.cpSync(appSource, stageRoot, { recursive: true });
  fs.mkdirSync(path.join(stageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(stageRoot, "model-sentinel.gguf"),
    "THROWAWAY MODEL PATH SENTINEL — not a model\n",
  );
  await requireCommand("xcrun", [
    "swiftc",
    path.join(prototypeRoot, "helper.swift"),
    "-o",
    path.join(stageRoot, "bin", "probe-helper"),
  ]);
}

function developerIdIdentity(inventory) {
  const line = inventory.signingIdentities
    .split("\n")
    .find((candidate) => candidate.includes("Developer ID Application:"));
  return line?.match(/"([^"]+)"/)?.[1] ?? null;
}

async function packageDirectCell(inventory) {
  const [packagePath] = await packager({
    dir: stageRoot,
    out: path.join(outputRoot, "package"),
    overwrite: true,
    platform: "darwin",
    arch: "arm64",
    electronVersion: JSON.parse(
      fs.readFileSync(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"),
    ).version,
    name: "OctopusSandboxProbe",
    executableName: "OctopusSandboxProbe",
    appBundleId: "app.octopusbeak.sandbox-probe",
    asar: false,
    prune: false,
  });
  const appPath = path.join(packagePath, "OctopusSandboxProbe.app");
  const identity = developerIdIdentity(inventory);
  if (!identity) throw new Error("Developer ID Application identity is required for the direct cell");

  await signAsync({
    app: appPath,
    identity,
    platform: "darwin",
    type: "distribution",
    timestamp: "none",
    optionsForFile: () => ({ timestamp: "none" }),
  });
  const verify = await command("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  const signature = await command("/usr/bin/codesign", [
    "-dvvv",
    "--entitlements",
    ":-",
    appPath,
  ]);
  return { appPath, identity, verify, signature };
}

async function runPackagedApp(appPath, runOrdinal) {
  const resultFile = path.join(outputRoot, `run-${runOrdinal}.json`);
  const executable = path.join(appPath, "Contents", "MacOS", "OctopusSandboxProbe");
  const launched = await command(executable, [], {
    env: {
      PROBE_RESULT_PATH: resultFile,
      PROBE_RUN_ORDINAL: String(runOrdinal),
    },
  });
  return {
    launched,
    evidence: fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
      : null,
  };
}

function sandboxPreflight(inventory) {
  const blockers = [];
  blockers.push(
    "The installed/package cell is Electron's standard darwin build; Electron documents that only its mas build can run under macOS App Sandbox.",
  );
  if (inventory.validSigningIdentityCount === 0) {
    blockers.push("No valid Apple code-signing identity is installed.");
  }
  if (!inventory.notaryProfileConfigured) {
    blockers.push("No OCTOPUSBEAK_NOTARY_PROFILE is configured for this probe process.");
  }
  return {
    eligibleToClaimAppSandboxPass: false,
    eligibleToClaimDeveloperIdNotarizationPass:
      inventory.validSigningIdentityCount > 0
      && inventory.notarytoolAvailable
      && inventory.notaryProfileConfigured,
    requiredAppSandboxCell: {
      electronDistribution: "mas-arm64",
      appEntitlement: "com.apple.security.app-sandbox",
      childEntitlements: [
        "com.apple.security.app-sandbox",
        "com.apple.security.inherit",
      ],
      topology: "MAS-signed app and inherited sandbox helpers",
    },
    blockers,
  };
}

function verdict(report) {
  const runs = report.directDistribution.runs;
  const runtimePass = runs.every(({ launched, evidence }) =>
    launched.ok
    && evidence?.packaged === true
    && evidence?.rendererFacts?.requireType === "undefined"
    && evidence?.rendererFacts?.processType === "undefined"
    && evidence?.ipc?.senderValidated === true
    && evidence?.helper?.ready?.modelRead === true
    && evidence?.helper?.ready?.insideWrite === true
    && evidence?.helper?.loopbackReply === "pong"
    && evidence?.helper?.terminated?.signal === "SIGTERM"
    && evidence?.helper?.crashed?.code === 42
  );
  const restartPass = runs[1]?.evidence?.restart?.recovered === true;
  const signaturePass = report.directDistribution.signatureVerification.ok;
  return {
    directPackagedHelperTopology: runtimePass && restartPass && signaturePass ? "pass" : "fail",
    appSandbox: "not-proven",
    developerIdNotarization: "not-proven",
    decisionSupportedByThisHost:
      runtimePass && restartPass && signaturePass
        ? "A main-owned embedded Swift helper is viable for the current direct-distribution package. Do not claim macOS App Sandbox support from this cell."
        : "The current direct-distribution helper topology is not yet viable; inspect the failed evidence before deciding.",
  };
}

async function main() {
  const inventory = await hostInventory();
  await prepareStage();
  const packaged = await packageDirectCell(inventory);
  const first = await runPackagedApp(packaged.appPath, 1);
  const second = await runPackagedApp(packaged.appPath, 2);
  const report = {
    schemaVersion: 1,
    question:
      "Can packaged Electron main own a real Swift helper, and which distribution security claims can this host prove?",
    generatedAt: new Date().toISOString(),
    inventory,
    directDistribution: {
      electronDistribution: "darwin-arm64",
      signing: `Developer ID (${packaged.identity}) with Hardened Runtime and timestamp disabled for the local probe`,
      appPath: packaged.appPath,
      signatureVerification: packaged.verify,
      signatureDescription: packaged.signature,
      runs: [first, second],
    },
    appSandboxPreflight: sandboxPreflight(inventory),
  };
  report.verdict = verdict(report);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, [
    "# Electron / App Sandbox probe report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- Direct packaged helper topology: **${report.verdict.directPackagedHelperTopology}**`,
    `- macOS App Sandbox: **${report.verdict.appSandbox}**`,
    `- Developer ID notarization: **${report.verdict.developerIdNotarization}**`,
    `- ${report.verdict.decisionSupportedByThisHost}`,
    "",
    "## App Sandbox / notarization blockers",
    "",
    ...report.appSandboxPreflight.blockers.map((blocker) => `- ${blocker}`),
    "",
    "See `report.json` for complete launch, IPC, helper, filesystem, loopback,",
    "termination, crash, restart, and signature evidence.",
    "",
  ].join("\n"));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict.directPackagedHelperTopology !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
