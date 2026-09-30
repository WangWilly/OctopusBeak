import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import {
  AUTOMATION_CREDENTIALS_FORMAT,
  setAutomationCredentialCodec,
} from "../src/lib/automation/server/config-files.ts";
import { readAutomationCredentialState } from "../src/lib/automation/server/desktop-api.ts";
import { toAutomationCredentialStateDto } from "./automation-credential-state.ts";

function reportAndExit(report, code) {
  process.stdout.write(`${JSON.stringify(report)}\n`, () => app.exit(code));
}

function p95(samples) {
  samples.sort((left, right) => left - right);
  return samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
}

function syntheticCredentialKey(...parts) {
  return parts.join("_");
}

app.whenReady().then(() => {
  let backend = null;
  try {
    backend = safeStorage.getSelectedStorageBackend?.() ?? null;
    if (!safeStorage.isEncryptionAvailable()) {
      reportAndExit({
        status: "skipped",
        reason: "safe-storage-unavailable",
        backend,
      }, 77);
      return;
    }
    if (process.platform === "linux" && backend === "basic_text") {
      reportAndExit({
        status: "skipped",
        reason: "safe-storage-basic-text-backend",
        backend,
      }, 77);
      return;
    }

    setAutomationCredentialCodec({
      encrypt(text) {
        return safeStorage.encryptString(text).toString("base64");
      },
      decrypt(payload) {
        return safeStorage.decryptString(Buffer.from(payload, "base64"));
      },
    });
    mkdirSync(process.cwd(), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({
      [syntheticCredentialKey("LIBRETTO", "CLOUD", "FUBON", "USER", "ID")]: "synthetic-user",
      [syntheticCredentialKey("LIBRETTO", "CLOUD", "FUBON", "ACCOUNT")]: "synthetic-account",
      [syntheticCredentialKey("LIBRETTO", "CLOUD", "FUBON", "PASSWORD")]: "synthetic-password",
    })).toString("base64");
    writeFileSync(join(process.cwd(), "settings.json"), "{}\n");
    writeFileSync(join(process.cwd(), "credentials.json"), JSON.stringify({
      format: AUTOMATION_CREDENTIALS_FORMAT,
      data: encrypted,
    }));

    const samples = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      const source = readAutomationCredentialState();
      toAutomationCredentialStateDto(source, index);
      samples.push(performance.now() - startedAt);
    }
    const snapshotP95Ms = p95(samples);
    reportAndExit({
      status: snapshotP95Ms <= 50 ? "passed" : "failed",
      reason: "safe-storage-decrypt-and-snapshot",
      backend,
      snapshotP95Ms,
      encryptedEnvelope: true,
    }, snapshotP95Ms <= 50 ? 0 : 1);
  } catch {
    reportAndExit({
      status: "failed",
      reason: "safe-storage-probe-error",
      backend,
    }, 1);
  }
}).catch(() => {
  process.stdout.write(`${JSON.stringify({
    status: "failed",
    reason: "electron-runtime-unavailable",
  })}\n`);
  app.exit(1);
});
