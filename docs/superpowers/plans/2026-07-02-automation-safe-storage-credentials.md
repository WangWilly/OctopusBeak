# Automation SafeStorage Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt desktop automation `credentials.json` at rest with Electron `safeStorage`, while leaving `settings.json` plaintext.

**Architecture:** Keep `src/lib/automation/server/config-files.ts` as the only credential file read/write layer. Add a tiny process-wide codec there; Electron main registers a `safeStorage` codec after switching cwd to `userData`, then migrates any legacy plaintext credentials file. If `safeStorage.isEncryptionAvailable()` is false, desktop startup fails instead of writing plaintext.

**Tech Stack:** Electron `safeStorage`, Node `fs`/`Buffer`/`assert`, existing TypeScript strip-types checks, existing Electron preload IPC boundary.

---

## Scope Decisions

- Encrypt only `credentials.json`.
- Keep `settings.json` plaintext.
- Store all credentials in one encrypted envelope, not per-key envelopes.
- Keep legacy plaintext credentials readable.
- Migrate plaintext credentials during Electron startup, not during ordinary reads.
- Do not add `keytar` or another keychain dependency.
- Do not add a plaintext fallback in Electron desktop runtime.
- Keep workflows unchanged; they still receive secrets through environment variables from the automation runner.
- Keep direct `libretto run ...` development on exported shell env, not desktop JSON injection.

## File Structure

- Modify `src/lib/automation/server/config-files.ts`: add the codec, encrypted envelope parsing, encrypted writing, and explicit migration helper.
- Modify `src/lib/automation/server/config-files.check.ts`: cover fake-codec encryption, no-plaintext-at-rest, missing-codec failure, and plaintext migration.
- Create `electron/credential-codec.ts`: bind Electron `safeStorage` to the config-file codec and run credential encryption migration.
- Modify `electron/main.ts`: register the safeStorage credential codec after `process.chdir(userData)` and before IPC handlers.
- Modify `src/lib/automation/server/desktop-api.check.ts`: verify desktop credential saves write encrypted envelopes when a codec is configured.
- Modify `README.md` and `.env.example`: replace "safeStorage follow-up" wording with current encrypted behavior and explicit-failure behavior.

---

### Task 1: Add Encrypted Credential File Support

**Files:**
- Modify: `src/lib/automation/server/config-files.ts`
- Modify: `src/lib/automation/server/config-files.check.ts`

- [ ] **Step 1: Write the failing config-file check**

Update the import in `src/lib/automation/server/config-files.check.ts`:

```ts
import {
  AUTOMATION_CREDENTIALS_FORMAT,
  AUTOMATION_CREDENTIALS_PATH,
  AUTOMATION_SETTINGS_PATH,
  automationConfigEnv,
  credentialStatusFromValues,
  migrateAutomationCredentialsFileEncryption,
  migrateAutomationEnvFile,
  readAutomationCredentialsFile,
  readAutomationSettingsFile,
  setAutomationCredentialCodec,
  settingsToEnv,
  splitAutomationUpdates,
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";
```

Append this block before the `finally` in the same file:

```ts
  const fakeCodec = {
    encrypt(text: string) {
      return Buffer.from(`safe:${text}`, "utf8").toString("base64");
    },
    decrypt(payload: string) {
      const text = Buffer.from(payload, "base64").toString("utf8");
      if (!text.startsWith("safe:")) throw new Error("bad fake credential payload");
      return text.slice("safe:".length);
    },
  };

  const encryptedCredentialsPath = join(dir, "encrypted-credentials.json");
  setAutomationCredentialCodec(fakeCodec);
  writeAutomationCredentialsFile(encryptedCredentialsPath, {
    [fubonPasswordKey]: "encrypted-secret",
  });
  const encryptedText = readFileSync(encryptedCredentialsPath, "utf8");
  const encryptedRecord = JSON.parse(encryptedText) as { format?: unknown; data?: unknown };
  assert.equal(encryptedRecord.format, AUTOMATION_CREDENTIALS_FORMAT);
  assert.equal(typeof encryptedRecord.data, "string");
  assert.equal(encryptedText.includes("encrypted-secret"), false);
  assert.deepEqual(readAutomationCredentialsFile(encryptedCredentialsPath), {
    [fubonPasswordKey]: "encrypted-secret",
  });

  setAutomationCredentialCodec(null);
  assert.throws(
    () => readAutomationCredentialsFile(encryptedCredentialsPath),
    /Credential encryption is not configured/,
  );

  const legacyCredentialsPath = join(dir, "legacy-credentials.json");
  writeFileSync(legacyCredentialsPath, `${JSON.stringify({
    [maxSecretKey]: "legacy-secret",
  }, null, 2)}\n`);
  setAutomationCredentialCodec(fakeCodec);
  assert.equal(migrateAutomationCredentialsFileEncryption(legacyCredentialsPath), true);
  assert.deepEqual(readAutomationCredentialsFile(legacyCredentialsPath), {
    [maxSecretKey]: "legacy-secret",
  });
  assert.equal(readFileSync(legacyCredentialsPath, "utf8").includes("legacy-secret"), false);
  assert.equal(migrateAutomationCredentialsFileEncryption(legacyCredentialsPath), false);
  setAutomationCredentialCodec(null);
```

- [ ] **Step 2: Run the check and verify it fails**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
```

Expected: FAIL because `AUTOMATION_CREDENTIALS_FORMAT`, `setAutomationCredentialCodec`, and `migrateAutomationCredentialsFileEncryption` do not exist yet.

- [ ] **Step 3: Add the credential codec and envelope helpers**

In `src/lib/automation/server/config-files.ts`, add this after `export const AUTOMATION_CREDENTIALS_PATH = "credentials.json";`:

```ts
export const AUTOMATION_CREDENTIALS_FORMAT = "octopusbeak.credentials.safeStorage.v1";

export type AutomationCredentialCodec = {
  encrypt(text: string): string;
  decrypt(payload: string): string;
};

type EncryptedAutomationCredentialsFile = {
  format: typeof AUTOMATION_CREDENTIALS_FORMAT;
  data: string;
};

let automationCredentialCodec: AutomationCredentialCodec | null = null;

export function setAutomationCredentialCodec(codec: AutomationCredentialCodec | null) {
  automationCredentialCodec = codec;
}
```

Add these helpers after `cleanCredentials`:

```ts
function encryptedAutomationCredentialsFile(
  record: Record<string, unknown>,
): EncryptedAutomationCredentialsFile | null {
  if (record.format !== AUTOMATION_CREDENTIALS_FORMAT) return null;
  if (typeof record.data !== "string" || !record.data.trim()) {
    throw new Error(`${AUTOMATION_CREDENTIALS_PATH} encrypted envelope is invalid.`);
  }
  return {
    format: AUTOMATION_CREDENTIALS_FORMAT,
    data: record.data,
  };
}

function requireAutomationCredentialCodec() {
  if (!automationCredentialCodec) {
    throw new Error("Credential encryption is not configured. Refusing to read encrypted automation credentials.");
  }
  return automationCredentialCodec;
}

function decodeCredentialsRecord(record: Record<string, unknown>) {
  const encrypted = encryptedAutomationCredentialsFile(record);
  if (!encrypted) return record;
  const text = requireAutomationCredentialCodec().decrypt(encrypted.data);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${AUTOMATION_CREDENTIALS_PATH} encrypted payload must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function credentialsFileText(credentials: AutomationCredentialsFile) {
  const cleaned = cleanCredentials(credentials);
  if (!automationCredentialCodec) return `${JSON.stringify(cleaned, null, 2)}\n`;
  return `${JSON.stringify({
    format: AUTOMATION_CREDENTIALS_FORMAT,
    data: automationCredentialCodec.encrypt(JSON.stringify(cleaned)),
  }, null, 2)}\n`;
}
```

Replace `readAutomationCredentialsFile` and `writeAutomationCredentialsFile` with:

```ts
export function readAutomationCredentialsFile(path = AUTOMATION_CREDENTIALS_PATH) {
  return cleanCredentials(decodeCredentialsRecord(readJsonRecord(path)));
}

export function writeAutomationCredentialsFile(path: string, credentials: AutomationCredentialsFile) {
  atomicWrite(path, credentialsFileText(credentials));
}
```

Add this exported migration helper after `writeAutomationCredentials`:

```ts
export function migrateAutomationCredentialsFileEncryption(path = AUTOMATION_CREDENTIALS_PATH) {
  if (!existsSync(path)) return false;
  const record = readJsonRecord(path);
  if (encryptedAutomationCredentialsFile(record)) return false;
  const credentials = cleanCredentials(record);
  if (Object.keys(credentials).length === 0) return false;
  requireAutomationCredentialCodec();
  writeAutomationCredentialsFile(path, credentials);
  return true;
}
```

- [ ] **Step 4: Run the config-file check**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
```

Expected: exits `0` with no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automation/server/config-files.ts src/lib/automation/server/config-files.check.ts
git commit -m "feat: encrypt automation credential file"
```

---

### Task 2: Register Electron SafeStorage

**Files:**
- Create: `electron/credential-codec.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: Create the safeStorage adapter**

Create `electron/credential-codec.ts`:

```ts
import { safeStorage } from "electron";
import {
  migrateAutomationCredentialsFileEncryption,
  setAutomationCredentialCodec,
} from "../src/lib/automation/server/config-files.ts";

export function registerAutomationCredentialSafeStorage() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage encryption is not available. Refusing to read or write automation credentials.");
  }

  setAutomationCredentialCodec({
    encrypt(text: string) {
      return safeStorage.encryptString(text).toString("base64");
    },
    decrypt(payload: string) {
      return safeStorage.decryptString(Buffer.from(payload, "base64"));
    },
  });

  migrateAutomationCredentialsFileEncryption();
}
```

- [ ] **Step 2: Register it during desktop startup**

In `electron/main.ts`, add the import:

```ts
import { registerAutomationCredentialSafeStorage } from "./credential-codec.ts";
```

Then update `start()` so registration happens after `process.chdir(userData)` and before `registerOctopusBeakIpc()`:

```ts
  process.chdir(userData);
  registerAutomationCredentialSafeStorage();
  registerOctopusBeakIpc();
```

- [ ] **Step 3: Run the Electron build**

```bash
npm run build:electron
```

Expected: exits `0`.

- [ ] **Step 4: Run the desktop runtime probe**

```bash
npm run desktop:runtime-probe
```

Expected: exits `0`. A macOS codesign diagnostic is acceptable if the probe still exits `0`.

- [ ] **Step 5: Commit**

```bash
git add electron/credential-codec.ts electron/main.ts
git commit -m "feat: register safeStorage credentials"
```

---

### Task 3: Cover Desktop Save Integration

**Files:**
- Modify: `src/lib/automation/server/desktop-api.check.ts`

- [ ] **Step 1: Add the desktop save integration check**

In `src/lib/automation/server/desktop-api.check.ts`, import the config helpers before importing `desktop-api.ts`:

```ts
  const configFiles = await import("./config-files.ts");
  const api = await import("./desktop-api.ts");
```

Replace the existing `const api = await import("./desktop-api.ts");` line with the two lines above.

Add this fake codec before `automationSaveCredentials`:

```ts
  const fakeCodec = {
    encrypt(text: string) {
      return Buffer.from(`safe:${text}`, "utf8").toString("base64");
    },
    decrypt(payload: string) {
      const text = Buffer.from(payload, "base64").toString("utf8");
      if (!text.startsWith("safe:")) throw new Error("bad fake credential payload");
      return text.slice("safe:".length);
    },
  };
  configFiles.setAutomationCredentialCodec(fakeCodec);
```

Replace the credential assertions after `automationSaveCredentials` with:

```ts
  const settings = JSON.parse(readFileSync("settings.json", "utf8"));
  const rawCredentialsText = readFileSync("credentials.json", "utf8");
  const rawCredentials = JSON.parse(rawCredentialsText) as { format?: unknown };
  const credentials = configFiles.readAutomationCredentialsFile("credentials.json");
  assert.equal(settings[enabledKey], false);
  assert.equal(Object.hasOwn(settings, accountKey), false);
  assert.equal(rawCredentials.format, configFiles.AUTOMATION_CREDENTIALS_FORMAT);
  assert.equal(rawCredentialsText.includes("next-acct"), false);
  assert.equal(credentials[accountKey], "next-acct");
  assert.equal(Object.hasOwn(credentials, enabledKey), false);
  configFiles.setAutomationCredentialCodec(null);
```

- [ ] **Step 2: Run the check**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
```

Expected: exits `0` with no output.

- [ ] **Step 3: Commit**

```bash
git add src/lib/automation/server/desktop-api.check.ts
git commit -m "test: cover encrypted desktop credential saves"
```

---

### Task 4: Update Docs and Run Final Verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Update README credential wording**

In `README.md`, replace this paragraph:

```md
`credentials.json` is local and ignored, but it is not OS-keychain encrypted yet. Electron `safeStorage` is a follow-up now that the Electron main/preload API boundary owns credential access.
```

with:

```md
`credentials.json` is local, ignored, and encrypted by Electron `safeStorage` in desktop runtime. If `safeStorage` encryption is unavailable, the desktop app fails startup instead of writing plaintext credentials.
```

- [ ] **Step 2: Update `.env.example` credential wording**

At the top of `.env.example`, replace the current storage comment with:

```sh
# The desktop automation panel stores app settings in plaintext settings.json
# and credential values in a safeStorage-encrypted credentials.json envelope.
```

- [ ] **Step 3: Run focused checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
npm run desktop:runtime-probe
```

Expected: all commands exit `0`.

- [ ] **Step 4: Run broad verification**

```bash
npm run typecheck
npm run build
npm run privacy-check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Run a temp-userData desktop smoke**

```bash
OCTOPUSBEAK_USER_DATA=/private/tmp/octopusbeak-safe-storage-smoke npm run desktop:dev
```

Manual expected result:

- `#/automation` opens.
- Saving a credential succeeds.
- `/private/tmp/octopusbeak-safe-storage-smoke/credentials.json` contains `format` and `data`.
- The saved credential value does not appear as plaintext in that file.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example
git commit -m "docs: describe encrypted automation credentials"
```

---

## Final Review

- [ ] `credentials.json` writes encrypted envelopes in Electron runtime.
- [ ] Legacy plaintext `credentials.json` migrates to the encrypted envelope during Electron startup.
- [ ] Encrypted credentials fail clearly when no codec is configured.
- [ ] `settings.json` remains plaintext.
- [ ] No new dependencies were added.
- [ ] No credential values appear in logs, docs, test output, or tracked files.
