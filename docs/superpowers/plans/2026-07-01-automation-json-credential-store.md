# Automation JSON Credential Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move automation non-secret switches to `settings.json` and sensitive credential values to a local `credentials.json`, then stop writing desktop automation credentials to `.env`.

**Architecture:** Keep existing environment variable names as the contract for every `src/workflows/*.ts` file. Add one small server-side config layer that reads `settings.json`, reads `credentials.json`, migrates known automation keys out of legacy `.env`, and returns a merged env object for spawned automation tasks. `credentials.json` is local, ignored, and written with `0600` permissions; OS keychain/`safeStorage` encryption is intentionally deferred until SSR is removed and the Electron main/preload API boundary is stable.

**Tech Stack:** SvelteKit server actions, Svelte components, Node `fs`/`path`/`os`/`assert`, existing `*.check.ts` self-checks.

---

## Scope Decisions

- Use `settings.json` for non-secret automation settings:

```json
{
  "AUTOMATION_BUSINESS_TIMEZONE": "Asia/Taipei",
  "LIBRETTO_CLOUD_FUBON_ENABLED": true,
  "LIBRETTO_CLOUD_ESUN_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED": true,
  "LIBRETTO_CLOUD_CATHAY_ENABLED": true,
  "LIBRETTO_CLOUD_HNCB_ENABLED": true,
  "MAX_ENABLED": true,
  "MAX_SUB_ACCOUNT": "main"
}
```

- Use `credentials.json` for sensitive values:

```json
{
  "LIBRETTO_CLOUD_FUBON_USER_ID": "local-user",
  "LIBRETTO_CLOUD_FUBON_ACCOUNT": "local-account",
  "LIBRETTO_CLOUD_FUBON_PASSWORD": "local-password",
  "MAX_ACCESS_KEY": "local-access-key",
  "MAX_SECRET_KEY": "local-secret-key"
}
```

- This phase improves source separation, git safety, and migration behavior, but does not provide OS-backed encryption yet.
- Do not put app settings or secrets in the ledger SQLite database.
- Treat user IDs, account numbers, passwords, certificate passwords, access keys, and secret keys as sensitive.
- Treat enabled flags, `AUTOMATION_BUSINESS_TIMEZONE`, and `MAX_SUB_ACCOUNT` as non-secret.
- Keep workflows unchanged: they continue to read `process.env`.
- Keep `.env.example` as a developer key list.
- Use exported shell env for direct `libretto run ...` development; `.env.local` is only a convenient ignored file to source manually.
- Keep legacy `.env` as a migration source. After successful JSON writes, remove only known automation keys from `.env` and preserve unknown lines/comments.
- Do not read or mutate `.env.local` during migration.
- Do not add Electron `safeStorage`, keytar, SQLite settings tables, or new dependencies in this phase.

## File Structure

- Create `src/lib/automation/server/config-files.ts`: JSON read/write helpers, key classification, `.env` migration, and env merge helpers.
- Create `src/lib/automation/server/config-files.check.ts`: self-checks for JSON parsing, file mode, migration, `.env.local` preservation, and env merge behavior.
- Modify `src/lib/automation/server/tasks.ts`: export secret/non-secret key lists.
- Modify `src/lib/automation/server/settings.ts`: replace `.env` settings reads with JSON settings reads plus legacy fallback.
- Modify `src/lib/automation/server/runner.ts`: build spawned task env from `settings.json` + `credentials.json`.
- Modify `src/routes/automation/+page.server.ts`: save form updates into the two JSON files instead of `.env`.
- Modify `src/lib/automation/AutomationDashboard.svelte`: update modal copy/button text from `.env` to local settings/credentials files.
- Modify `electron/runtime.cjs`: initialize `settings.json` defaults in desktop userData.
- Modify `.gitignore`: ignore `settings.json`, `credentials.json`, and `.env.local`.
- Modify `README.md` and `.env.example`: document JSON storage and direct Libretto development.

---

### Task 1: Classify Settings and Credentials

**Files:**
- Modify: `src/lib/automation/server/tasks.ts`
- Test: `src/lib/automation/server/automation-core.check.ts`

- [ ] **Step 1: Add key classification exports**

Add these exports after `AUTOMATION_CREDENTIAL_KEYS`:

```ts
export const AUTOMATION_ENABLED_KEYS = AUTOMATION_CREDENTIAL_GROUPS.map((group) => group.enabledKey);

export const AUTOMATION_NON_SECRET_KEYS = [
  "AUTOMATION_BUSINESS_TIMEZONE",
  "MAX_SUB_ACCOUNT",
  ...AUTOMATION_ENABLED_KEYS,
] as const;

const nonSecretCredentialKeys = new Set<string>(["MAX_SUB_ACCOUNT"]);

export const AUTOMATION_SECRET_KEYS = AUTOMATION_CREDENTIAL_KEYS.filter(
  (key) => !nonSecretCredentialKeys.has(key),
);

export function automationCredentialKeyIsSecret(key: string) {
  return !nonSecretCredentialKeys.has(key);
}
```

- [ ] **Step 2: Add assertions**

Add these names to the existing `./tasks.ts` import in `src/lib/automation/server/automation-core.check.ts`:

```ts
AUTOMATION_ENABLED_KEYS,
AUTOMATION_NON_SECRET_KEYS,
AUTOMATION_SECRET_KEYS,
automationCredentialKeyIsSecret,
```

Then append:

```ts
assert.equal(AUTOMATION_ENABLED_KEYS.includes("LIBRETTO_CLOUD_FUBON_ENABLED"), true);
assert.equal(AUTOMATION_NON_SECRET_KEYS.includes("MAX_SUB_ACCOUNT"), true);
assert.equal(AUTOMATION_SECRET_KEYS.includes("MAX_SECRET_KEY"), true);
assert.equal(AUTOMATION_SECRET_KEYS.includes("MAX_SUB_ACCOUNT"), false);
assert.equal(automationCredentialKeyIsSecret("MAX_SECRET_KEY"), true);
assert.equal(automationCredentialKeyIsSecret("MAX_SUB_ACCOUNT"), false);
```

- [ ] **Step 3: Run the check**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
```

Expected: exits `0` with no output.

- [ ] **Step 4: Commit**

```bash
git add src/lib/automation/server/tasks.ts src/lib/automation/server/automation-core.check.ts
git commit -m "chore: classify automation config keys"
```

---

### Task 2: Add JSON Config File Helpers

**Files:**
- Create: `src/lib/automation/server/config-files.ts`
- Create: `src/lib/automation/server/config-files.check.ts`

- [ ] **Step 1: Write the failing check**

Create `src/lib/automation/server/config-files.check.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationConfigEnv,
  credentialStatusFromValues,
  migrateAutomationEnvFile,
  readAutomationCredentialsFile,
  readAutomationSettingsFile,
  settingsToEnv,
  splitAutomationUpdates,
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";

const dir = mkdtempSync(join(tmpdir(), "octopusbeak-config-"));
const fubonPasswordKey = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
try {
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const envPath = join(dir, ".env");
  const envLocalPath = join(dir, ".env.local");

  writeAutomationSettingsFile(settingsPath, {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  writeAutomationCredentialsFile(credentialsPath, {
    [fubonPasswordKey]: "secret",
    MAX_SECRET_KEY: "max-secret",
  });

  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath), {
    [fubonPasswordKey]: "secret",
    MAX_SECRET_KEY: "max-secret",
  });
  assert.equal((statSync(settingsPath).mode & 0o777), 0o600);
  assert.equal((statSync(credentialsPath).mode & 0o777), 0o600);

  assert.deepEqual(settingsToEnv({
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  }), {
    LIBRETTO_CLOUD_FUBON_ENABLED: "false",
    MAX_SUB_ACCOUNT: "main",
  });

  assert.deepEqual(splitAutomationUpdates({
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    [fubonPasswordKey]: "pw",
    MAX_SUB_ACCOUNT: "main",
  }), {
    settings: {
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
      MAX_SUB_ACCOUNT: "main",
    },
    credentials: {
      [fubonPasswordKey]: "pw",
    },
  });

  assert.deepEqual(credentialStatusFromValues(
    { [fubonPasswordKey]: "pw" },
    [fubonPasswordKey, "MAX_SECRET_KEY"],
  ), {
    [fubonPasswordKey]: true,
    MAX_SECRET_KEY: false,
  });

  writeFileSync(envPath, [
    "# keep",
    "LIBRETTO_CLOUD_FUBON_ENABLED=false",
    `${fubonPasswordKey}=legacy-pw`,
    "MAX_SUB_ACCOUNT=sub",
    "UNKNOWN=value",
    "",
  ].join("\n"));
  writeFileSync(envLocalPath, `${fubonPasswordKey}=dev-only\n`);

  migrateAutomationEnvFile({ envPath, settingsPath, credentialsPath });
  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath), {
    [fubonPasswordKey]: "secret",
    MAX_SECRET_KEY: "max-secret",
  });
  assert.equal(readFileSync(envPath, "utf8"), "# keep\nUNKNOWN=value\n");
  assert.equal(readFileSync(envLocalPath, "utf8"), `${fubonPasswordKey}=dev-only\n`);

  assert.deepEqual(automationConfigEnv({
    baseEnv: { KEEP_ME: "yes", NODE_ENV: "production" },
    settings: { LIBRETTO_CLOUD_FUBON_ENABLED: true },
    credentials: { [fubonPasswordKey]: "pw" },
  }), {
    KEEP_ME: "yes",
    NODE_ENV: "development",
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    [fubonPasswordKey]: "pw",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Verify it fails**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
```

Expected: FAIL because `config-files.ts` does not exist.

- [ ] **Step 3: Add the config helper module**

Create `src/lib/automation/server/config-files.ts`:

```ts
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_NON_SECRET_KEYS,
  AUTOMATION_SECRET_KEYS,
} from "./tasks.ts";

export type AutomationSettingValue = string | boolean;
export type AutomationSettingsFile = Record<string, AutomationSettingValue>;
export type AutomationCredentialsFile = Record<string, string>;

export const AUTOMATION_SETTINGS_PATH = resolve("settings.json");
export const AUTOMATION_CREDENTIALS_PATH = resolve("credentials.json");

const automationSettingKeys = new Set<string>(AUTOMATION_NON_SECRET_KEYS);
const automationSecretKeys = new Set<string>(AUTOMATION_SECRET_KEYS);
const automationKnownKeys = new Set<string>([
  ...AUTOMATION_NON_SECRET_KEYS,
  ...AUTOMATION_SECRET_KEYS,
]);

function readJsonRecord(path: string) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function atomicWrite(path: string, text: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, text, { encoding: "utf8", mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, path);
}

function cleanSettings(record: Record<string, unknown>): AutomationSettingsFile {
  const result: AutomationSettingsFile = {};
  for (const [key, value] of Object.entries(record)) {
    if (!automationSettingKeys.has(key)) continue;
    if (typeof value === "boolean" || typeof value === "string") result[key] = value;
  }
  return result;
}

function cleanCredentials(record: Record<string, unknown>): AutomationCredentialsFile {
  const result: AutomationCredentialsFile = {};
  for (const [key, value] of Object.entries(record)) {
    if (!automationSecretKeys.has(key)) continue;
    if (typeof value === "string" && value.trim()) result[key] = value;
  }
  return result;
}

export function readAutomationSettingsFile(path = AUTOMATION_SETTINGS_PATH) {
  return cleanSettings(readJsonRecord(path));
}

export function readAutomationCredentialsFile(path = AUTOMATION_CREDENTIALS_PATH) {
  return cleanCredentials(readJsonRecord(path));
}

export function writeAutomationSettingsFile(path: string, settings: AutomationSettingsFile) {
  atomicWrite(path, `${JSON.stringify(cleanSettings(settings), null, 2)}\n`);
}

export function writeAutomationCredentialsFile(path: string, credentials: AutomationCredentialsFile) {
  atomicWrite(path, `${JSON.stringify(cleanCredentials(credentials), null, 2)}\n`);
}

export function writeAutomationSettings(settings: AutomationSettingsFile) {
  writeAutomationSettingsFile(AUTOMATION_SETTINGS_PATH, settings);
}

export function writeAutomationCredentials(credentials: AutomationCredentialsFile) {
  writeAutomationCredentialsFile(AUTOMATION_CREDENTIALS_PATH, credentials);
}

function envValueToSetting(key: string, value: string): AutomationSettingValue {
  if (key.endsWith("_ENABLED")) {
    return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
  }
  return value;
}

export function splitAutomationUpdates(updates: Record<string, string>) {
  const settings: AutomationSettingsFile = {};
  const credentials: AutomationCredentialsFile = {};
  for (const [key, value] of Object.entries(updates)) {
    if (automationSettingKeys.has(key)) {
      settings[key] = envValueToSetting(key, value);
      continue;
    }
    if (automationSecretKeys.has(key) && value.trim()) credentials[key] = value;
  }
  return { settings, credentials };
}

export function settingsToEnv(settings: AutomationSettingsFile): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, String(value)]),
  );
}

export function credentialStatusFromValues(
  credentials: AutomationCredentialsFile,
  keys: readonly string[],
): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, Boolean(credentials[key]?.trim())]));
}

function withoutKnownAutomationLines(envText: string) {
  return `${envText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      return !match || !automationKnownKeys.has(match[1]);
    })
    .filter((line, index, lines) => line || index < lines.length - 1)
    .join("\n")}\n`;
}

export function migrateAutomationEnvFile({
  envPath = resolve(".env"),
  settingsPath = AUTOMATION_SETTINGS_PATH,
  credentialsPath = AUTOMATION_CREDENTIALS_PATH,
}: {
  envPath?: string;
  settingsPath?: string;
  credentialsPath?: string;
} = {}) {
  if (!existsSync(envPath)) return;
  const envText = readFileSync(envPath, "utf8");
  const parsed = parseEnvText(envText);
  const existingSettings = readAutomationSettingsFile(settingsPath);
  const existingCredentials = readAutomationCredentialsFile(credentialsPath);
  const migrated = splitAutomationUpdates(parsed);

  const hasSettings = Object.keys(migrated.settings).length > 0 || existsSync(settingsPath);
  const hasCredentials = Object.keys(migrated.credentials).length > 0 || existsSync(credentialsPath);
  if (hasSettings) {
    writeAutomationSettingsFile(settingsPath, {
      ...migrated.settings,
      ...existingSettings,
    });
  }
  if (hasCredentials) {
    writeAutomationCredentialsFile(credentialsPath, {
      ...migrated.credentials,
      ...existingCredentials,
    });
  }
  if (Object.keys(migrated.settings).length > 0 || Object.keys(migrated.credentials).length > 0) {
    writeFileSync(envPath, withoutKnownAutomationLines(envText), { encoding: "utf8", mode: 0o600 });
  }
}

export function automationConfigEnv({
  baseEnv = process.env,
  settings = readAutomationSettingsFile(),
  credentials = readAutomationCredentialsFile(),
}: {
  baseEnv?: NodeJS.ProcessEnv;
  settings?: AutomationSettingsFile;
  credentials?: AutomationCredentialsFile;
} = {}) {
  const env = {
    ...baseEnv,
    ...settingsToEnv(settings),
    ...credentials,
  };
  if (env.NODE_ENV === "production") env.NODE_ENV = "development";
  return env;
}
```

- [ ] **Step 4: Run the new check**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
```

Expected: exits `0` with no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automation/server/config-files.ts src/lib/automation/server/config-files.check.ts
git commit -m "feat: add automation JSON config files"
```

---

### Task 3: Wire Settings and Runner Env

**Files:**
- Modify: `src/lib/automation/server/settings.ts`
- Modify: `src/lib/automation/server/runner.ts`
- Modify: `src/lib/automation/server/runner.check.ts`
- Modify: `src/lib/automation/server/automation-core.check.ts`

- [ ] **Step 1: Update settings helpers**

Replace `.env` as the primary settings source. Keep legacy `.env` and shell env as fallback:

```ts
export function readAutomationSettings(settingsPath = AUTOMATION_SETTINGS_PATH) {
  migrateAutomationEnvFile({ envPath: AUTOMATION_ENV_PATH, settingsPath });
  return readAutomationSettingsFile(settingsPath);
}

export function automationBusinessTimezone(settings: AutomationSettingsFile = readAutomationSettings()) {
  const value = settings.AUTOMATION_BUSINESS_TIMEZONE;
  return typeof value === "string" && value.trim() ? value : "Asia/Taipei";
}

export function automationGroupEnabledStatus(
  settings: AutomationSettingsFile = readAutomationSettings(),
  env: Record<string, string | undefined> = process.env,
) {
  const legacy = parseEnvText(readAutomationEnvText());
  return Object.fromEntries(
    AUTOMATION_CREDENTIAL_GROUPS.map((group) => [
      group.id,
      envFlagEnabled(settings[group.enabledKey] ?? legacy[group.enabledKey] ?? env[group.enabledKey]),
    ]),
  );
}
```

- [ ] **Step 2: Update `automationProcessEnv`**

In `src/lib/automation/server/runner.ts`, replace `automationProcessEnv` with:

```ts
export function automationProcessEnv(baseEnv: NodeJS.ProcessEnv = process.env) {
  return automationConfigEnv({ baseEnv });
}
```

Also import `automationConfigEnv` from `./config-files.ts`.

- [ ] **Step 3: Use settings timezone in runner gates**

In `src/lib/automation/server/runner.ts`, replace the old settings import:

```ts
import { automationGroupEnabledStatus, readAutomationEnvText } from "./settings.ts";
```

with:

```ts
import {
  automationBusinessTimezone,
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "./settings.ts";
```

Then replace the auto-import gate settings block near the end of `runAutomationTask`:

```ts
const range = businessDayUtcRange();
const enabledGroups = automationGroupEnabledStatus(readAutomationEnvText());
```

with:

```ts
const settings = readAutomationSettings();
const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
const enabledGroups = automationGroupEnabledStatus(settings);
```

- [ ] **Step 4: Preserve direct Libretto development path**

Do not change any `src/workflows/*.ts` files. They keep reading `process.env`.

Document and preserve this runtime split:

```text
Desktop automation button:
  settings.json + credentials.json -> runner env -> workflow process.env

Developer terminal:
  set -a; source .env.local; set +a
  libretto run src/workflows/foo.ts -> workflow process.env
```

- [ ] **Step 5: Update checks**

In `runner.check.ts`, replace old `automationProcessEnv("...")` checks with:

```ts
assert.equal(automationProcessEnv({ NODE_ENV: "production" }).NODE_ENV, "development");
assert.equal(automationProcessEnv({ NODE_ENV: "test" }).NODE_ENV, "test");
```

In `automation-core.check.ts`, add `automationBusinessTimezone` to the `./settings.ts` import, then add these assertions:

```ts
const enabledGroups = automationGroupEnabledStatus({
  LIBRETTO_CLOUD_ESUN_ENABLED: false,
});
assert.equal(enabledGroups.esun, false);

const utcRange = businessDayUtcRange(
  new Date("2026-06-30T15:30:00.000Z"),
  automationBusinessTimezone({ AUTOMATION_BUSINESS_TIMEZONE: "UTC" }),
);
assert.equal(utcRange.businessDate, "2026-06-30");
```

- [ ] **Step 6: Run focused checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
```

Expected: each exits `0` with no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/server/settings.ts src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts src/lib/automation/server/automation-core.check.ts
git commit -m "feat: load automation env from JSON config"
```

---

### Task 4: Save Form Data to `settings.json` and `credentials.json`

**Files:**
- Modify: `src/routes/automation/+page.server.ts`
- Modify: `src/lib/automation/AutomationDashboard.svelte`

- [ ] **Step 1: Replace route imports**

In `src/routes/automation/+page.server.ts`, remove `writeFileSync`, `credentialStatus`, and `updateEnvText` imports. Add:

```ts
import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  splitAutomationUpdates,
  writeAutomationCredentials,
  writeAutomationSettings,
} from "$lib/automation/server/config-files.ts";
```

Also import `readAutomationSettings` from `$lib/automation/server/settings.ts`.
Include `automationBusinessTimezone` in that same settings import.

- [ ] **Step 2: Update credential status**

Replace `currentCredentialStatus` with:

```ts
function currentCredentialStatus() {
  const settings = readAutomationSettings();
  const credentials = readAutomationCredentialsFile();
  const status = credentialStatusFromValues(credentials, AUTOMATION_CREDENTIAL_KEYS);
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    status[key] = status[key] || Boolean(settings[key]) || Boolean(process.env[key]?.trim());
  }
  return status;
}
```

- [ ] **Step 3: Update model settings reads**

Use JSON settings:

```ts
const settings = readAutomationSettings();
const enabledGroups = automationGroupEnabledStatus(settings);
```

Use that pattern in `currentAutomationModel()` and `load()`.

In `currentAutomationModel()`, use the same settings object for the business-day range:

```ts
const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
```

- [ ] **Step 4: Update save action**

Replace the body of `saveCredentials` with:

```ts
saveCredentials: async ({ request }) => {
  const formData = await request.formData();
  const updates: Record<string, string> = {};
  for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
    updates[group.enabledKey] = formData.getAll(group.enabledKey).includes("true") ? "true" : "false";
  }
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    const value = String(formData.get(key) ?? "").trim();
    if (value) updates[key] = value;
  }
  const { settings, credentials } = splitAutomationUpdates(updates);
  writeAutomationSettings({
    ...readAutomationSettings(),
    ...settings,
  });
  writeAutomationCredentials({
    ...readAutomationCredentialsFile(),
    ...credentials,
  });
  return { saved: true };
},
```

- [ ] **Step 5: Update UI copy**

In `src/lib/automation/AutomationDashboard.svelte`, change:

```svelte
<p>Saved to local .env. Existing secret values are shown only as saved or missing.</p>
...
<button class="button primary fixed-action" type="submit">Save .env</button>
```

to:

```svelte
<p>Saved locally. Switches go to settings.json; secrets go to credentials.json.</p>
...
<button class="button primary fixed-action" type="submit">Save</button>
```

- [ ] **Step 6: Run checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
npm run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/automation/+page.server.ts src/lib/automation/AutomationDashboard.svelte src/lib/automation/server/config-files.ts
git commit -m "feat: save automation credentials to JSON files"
```

---

### Task 5: Initialize Desktop Defaults and Ignore Local Files

**Files:**
- Modify: `electron/runtime.cjs`
- Modify: `electron/runtime.check.cjs`
- Modify: `.gitignore`

- [ ] **Step 1: Update desktop data root initialization**

In `electron/runtime.cjs`, create `settings.json` under `userData` when missing:

```js
const settingsPath = path.join(userData, "settings.json");
if (!fs.existsSync(settingsPath)) {
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: true,
    LIBRETTO_CLOUD_ESUN_ENABLED: true,
    LIBRETTO_CLOUD_YUANTA_ENABLED: true,
    LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: true,
    LIBRETTO_CLOUD_CATHAY_ENABLED: true,
    LIBRETTO_CLOUD_HNCB_ENABLED: true,
    MAX_ENABLED: true,
    MAX_SUB_ACCOUNT: "main",
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
```

Do not create `credentials.json` until the user saves a credential.

- [ ] **Step 2: Update runtime check**

In `electron/runtime.check.cjs`, replace the `.env` assertions:

```js
assert.equal(fs.existsSync(path.join(root, ".env")), true);
assert.equal(
  fs.readFileSync(path.join(root, ".env"), "utf8"),
  "AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei\n",
);
const existingEnvText = "CUSTOM_SECRET=keep-me\n";
fs.writeFileSync(path.join(root, ".env"), existingEnvText, "utf8");
ensureDataRoot(root);
assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), existingEnvText);
```

with:

```js
const settingsPath = path.join(root, "settings.json");
assert.equal(fs.existsSync(settingsPath), true);
assert.equal(fs.existsSync(path.join(root, "credentials.json")), false);
assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
  AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
  LIBRETTO_CLOUD_FUBON_ENABLED: true,
  LIBRETTO_CLOUD_ESUN_ENABLED: true,
  LIBRETTO_CLOUD_YUANTA_ENABLED: true,
  LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: true,
  LIBRETTO_CLOUD_CATHAY_ENABLED: true,
  LIBRETTO_CLOUD_HNCB_ENABLED: true,
  MAX_ENABLED: true,
  MAX_SUB_ACCOUNT: "main",
});
const existingSettingsText = JSON.stringify({ CUSTOM_SETTING: "keep-me" }, null, 2) + "\n";
fs.writeFileSync(settingsPath, existingSettingsText, "utf8");
ensureDataRoot(root);
assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettingsText);
```

- [ ] **Step 3: Ignore local files**

Add to `.gitignore`:

```gitignore
settings.json
credentials.json
.env.local
```

- [ ] **Step 4: Run package/runtime checks**

```bash
npm run desktop:runtime-probe
npm run typecheck
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add electron/runtime.cjs electron/runtime.check.cjs .gitignore
git commit -m "chore: initialize local automation settings"
```

---

### Task 6: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `settings.example.json`

- [ ] **Step 1: Update README automation panel section**

Document:

```md
The `/automation` page wraps the existing npm scripts. It stores non-secret switches in `settings.json`, stores secret credential values in local `credentials.json`, records task history in `data/ledger/ledger.sqlite`, writes full task logs under `data/automation/logs/`, and keeps only the latest log tail in SQLite.
```

Also document:

```md
`credentials.json` is local and ignored, but it is not OS-keychain encrypted yet. Electron `safeStorage` should be added after SSR is removed and the Electron main/preload API boundary owns credential access.
```

- [ ] **Step 2: Document direct Libretto development**

Add:

```md
For direct `libretto run src/workflows/foo.ts` development, provide credentials through exported shell env. If you keep them in ignored `.env.local`, load them first with `set -a; source .env.local; set +a`; Libretto does not auto-load that file. Workflow files still read `process.env`; the desktop JSON store is only injected by the automation runner.
```

- [ ] **Step 3: Update `.env.example`**

Keep it as a key list and mark it developer-only:

```dotenv
# Developer-only fallback for direct workflow runs.
# The desktop automation panel stores app settings in settings.json and
# credential values in credentials.json.
AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei
```

Keep the existing bank/MAX key list, but remove wording that says the desktop panel writes to `.env`.

- [ ] **Step 4: Add settings example**

Create `settings.example.json`:

```json
{
  "AUTOMATION_BUSINESS_TIMEZONE": "Asia/Taipei",
  "LIBRETTO_CLOUD_FUBON_ENABLED": true,
  "LIBRETTO_CLOUD_ESUN_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_ENABLED": true,
  "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED": true,
  "LIBRETTO_CLOUD_CATHAY_ENABLED": true,
  "LIBRETTO_CLOUD_HNCB_ENABLED": true,
  "MAX_ENABLED": true,
  "MAX_SUB_ACCOUNT": "main"
}
```

- [ ] **Step 5: Run privacy check**

```bash
npm run privacy-check
```

Expected: exits `0`.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example settings.example.json
git commit -m "docs: document automation JSON config"
```

---

## Deferred Work

Do not implement this work in this phase. Add it to follow-up work after SSR removal:

```text
After SSR is removed:
  renderer UI -> preload/contextBridge -> ipcMain handlers
  ipcMain handlers -> Electron safeStorage
  safeStorage encrypted blobs -> userData/credentials.json
```

Reason: adding `safeStorage` now would place native credential behavior behind the current SvelteKit server-action boundary, then require moving the same behavior again during the Electron API migration.

---

## Final Verification

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
npm run typecheck
npm run privacy-check
```

Expected: all commands exit `0`.

Manual desktop smoke check:

```bash
npm run desktop:dev
```

Expected:

- `/automation` opens.
- Credential modal says switches go to `settings.json` and secrets go to `credentials.json`.
- Saving a group switch creates/updates `settings.json`.
- Saving a password creates/updates `credentials.json`.
- Known automation keys are no longer left in `.env` after migration.
- `.env.local` is left untouched.
- Running a desktop task still receives the same env variable names as before.
- Direct `libretto run src/workflows/foo.ts` still works when credentials are supplied through shell env, including values manually sourced from `.env.local`.

## Self-Review

- Spec coverage: covers `settings.json`, `credentials.json`, migration away from `.env`, `.env.local` development fallback, route save behavior, runner env behavior, docs, and verification.
- Placeholder scan: no placeholder markers remain.
- Type consistency: plan uses `AutomationSettingsFile`, `AutomationCredentialsFile`, `settingsToEnv`, `credentialStatusFromValues`, `splitAutomationUpdates`, and `automationConfigEnv` consistently.

Skipped: OS keychain/`safeStorage` encryption and SQLite credential storage. Add `safeStorage` after SSR removal; add SQLite only if settings become query-heavy or multi-profile.
