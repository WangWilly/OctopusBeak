# Automation JSON Credential Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move automation non-secret switches to `settings.json` and sensitive credential values to `credentials.json`, then stop writing automation credentials to `.env`.

**Architecture:** Keep the existing environment variable names as JSON keys to avoid rewriting every workflow. Add one small server-side config layer that reads `settings.json`, reads `credentials.json`, migrates known automation keys out of `.env`, and returns a merged env object for spawned automation tasks. `credentials.json` is a local ignored file with `0600` permissions; OS keychain encryption is intentionally deferred until the Electron IPC/API migration.

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

- Treat user IDs, account numbers, passwords, certificate passwords, access keys, and secret keys as sensitive. Treat `MAX_SUB_ACCOUNT` as non-secret and store it in `settings.json`.
- Keep workflows unchanged: they continue to read `process.env`. Only the automation server runner changes how env vars are assembled before spawning those workflows.
- Keep `.env` as a read-only migration source. After a successful migration, remove known automation keys from `.env` and preserve unknown lines/comments.
- Do not add a new dependency. Use the standard library only.

## File Structure

- Create `src/lib/automation/server/config-files.ts`: JSON read/write helpers, key classification, `.env` migration, and env merge helpers.
- Create `src/lib/automation/server/config-files.check.ts`: self-checks for JSON parsing, file mode, migration, and env merge behavior.
- Modify `src/lib/automation/server/settings.ts`: replace `.env` settings reads with JSON settings reads.
- Modify `src/lib/automation/server/runner.ts`: build spawned task env from `settings.json` + `credentials.json`.
- Modify `src/routes/automation/+page.server.ts`: save form updates into the two JSON files instead of `.env`.
- Modify `src/lib/automation/AutomationDashboard.svelte`: update modal copy/button text from `.env` to local settings/credentials files.
- Modify `electron/runtime.cjs`: initialize `settings.json` defaults in desktop userData.
- Modify `.gitignore`: ignore `settings.json` and `credentials.json`.
- Modify `README.md` and `.env.example`: document JSON storage and leave `.env` as legacy/CLI-only fallback.

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

Then append these assertions:

```ts
assert.equal(AUTOMATION_ENABLED_KEYS.includes("LIBRETTO_CLOUD_FUBON_ENABLED"), true);
assert.equal(AUTOMATION_NON_SECRET_KEYS.includes("MAX_SUB_ACCOUNT"), true);
assert.equal(AUTOMATION_SECRET_KEYS.includes("MAX_SECRET_KEY"), true);
assert.equal(AUTOMATION_SECRET_KEYS.includes("MAX_SUB_ACCOUNT"), false);
assert.equal(automationCredentialKeyIsSecret("MAX_SECRET_KEY"), true);
assert.equal(automationCredentialKeyIsSecret("MAX_SUB_ACCOUNT"), false);
```

- [ ] **Step 3: Run the check**

Run:

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
try {
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const envPath = join(dir, ".env");

  writeAutomationSettingsFile(settingsPath, {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  writeAutomationCredentialsFile(credentialsPath, {
    LIBRETTO_CLOUD_FUBON_PASSWORD: "secret",
    MAX_SECRET_KEY: "max-secret",
  });

  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath), {
    LIBRETTO_CLOUD_FUBON_PASSWORD: "secret",
    MAX_SECRET_KEY: "max-secret",
  });
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
    LIBRETTO_CLOUD_FUBON_PASSWORD: "pw",
    MAX_SUB_ACCOUNT: "main",
  }), {
    settings: {
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
      MAX_SUB_ACCOUNT: "main",
    },
    credentials: {
      LIBRETTO_CLOUD_FUBON_PASSWORD: "pw",
    },
  });

  assert.deepEqual(credentialStatusFromValues(
    { LIBRETTO_CLOUD_FUBON_PASSWORD: "pw" },
    ["LIBRETTO_CLOUD_FUBON_PASSWORD", "MAX_SECRET_KEY"],
  ), {
    LIBRETTO_CLOUD_FUBON_PASSWORD: true,
    MAX_SECRET_KEY: false,
  });

  writeFileSync(envPath, [
    "# keep",
    "LIBRETTO_CLOUD_FUBON_ENABLED=false",
    "LIBRETTO_CLOUD_FUBON_PASSWORD=legacy-pw",
    "MAX_SUB_ACCOUNT=sub",
    "UNKNOWN=value",
    "",
  ].join("\n"));

  migrateAutomationEnvFile({ envPath, settingsPath, credentialsPath });
  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath), {
    LIBRETTO_CLOUD_FUBON_PASSWORD: "secret",
    MAX_SECRET_KEY: "max-secret",
  });
  assert.equal(readFileSync(envPath, "utf8"), "# keep\nUNKNOWN=value\n");

  assert.deepEqual(automationConfigEnv({
    baseEnv: { KEEP_ME: "yes", NODE_ENV: "production" },
    settings: { LIBRETTO_CLOUD_FUBON_ENABLED: true },
    credentials: { LIBRETTO_CLOUD_FUBON_PASSWORD: "pw" },
  }), {
    KEEP_ME: "yes",
    NODE_ENV: "development",
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    LIBRETTO_CLOUD_FUBON_PASSWORD: "pw",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Verify it fails**

Run:

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
  automationCredentialKeyIsSecret,
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
    if (automationCredentialKeyIsSecret(key) && value.trim()) credentials[key] = value;
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
) {
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
} = {}) {
  if (!existsSync(envPath)) return;
  const envText = readFileSync(envPath, "utf8");
  const parsed = parseEnvText(envText);
  const existingSettings = readAutomationSettingsFile(settingsPath);
  const existingCredentials = readAutomationCredentialsFile(credentialsPath);
  const migrated = splitAutomationUpdates(parsed);
  writeAutomationSettingsFile(settingsPath, {
    ...migrated.settings,
    ...existingSettings,
  });
  writeAutomationCredentialsFile(credentialsPath, {
    ...migrated.credentials,
    ...existingCredentials,
  });
  writeFileSync(envPath, withoutKnownAutomationLines(envText), { encoding: "utf8", mode: 0o600 });
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

Run:

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

Replace `src/lib/automation/server/settings.ts` with:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_SETTINGS_PATH,
  migrateAutomationEnvFile,
  readAutomationSettingsFile,
  type AutomationSettingsFile,
} from "./config-files.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";

export const AUTOMATION_ENV_PATH = resolve(".env");

export function readAutomationEnvText(envPath = AUTOMATION_ENV_PATH) {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}

export function envFlagEnabled(value: string | boolean | undefined) {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
}

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

Also change the import block to import `automationConfigEnv` from `./config-files.ts`.

- [ ] **Step 3: Update call sites that passed env text**

In `src/lib/automation/server/runner.check.ts`, replace assertions that call `automationProcessEnv("...")` with direct `automationConfigEnv(...)` tests from Task 2, or with:

```ts
assert.equal(automationProcessEnv({ NODE_ENV: "production" }).NODE_ENV, "development");
assert.equal(automationProcessEnv({ NODE_ENV: "test" }).NODE_ENV, "test");
```

- [ ] **Step 4: Update automation core check imports**

Keep `credentialStatus` and `updateEnvText` checks for legacy parser coverage, but add one `automationGroupEnabledStatus` assertion using a settings object:

```ts
const enabledGroups = automationGroupEnabledStatus({
  LIBRETTO_CLOUD_ESUN_ENABLED: false,
});
```

- [ ] **Step 5: Run focused checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
```

Expected: each exits `0` with no output.

- [ ] **Step 6: Commit**

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

- [ ] **Step 2: Update credential status**

Replace `currentCredentialStatus` with:

```ts
function currentCredentialStatus() {
  const credentials = readAutomationCredentialsFile();
  const status = credentialStatusFromValues(credentials, AUTOMATION_CREDENTIAL_KEYS);
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    status[key] = status[key] || Boolean(process.env[key]?.trim());
  }
  return status;
}
```

- [ ] **Step 3: Update model settings reads**

Replace local `envText` reads with JSON settings:

```ts
const settings = readAutomationSettings();
const enabledGroups = automationGroupEnabledStatus(settings);
```

Use that pattern in `currentAutomationModel()` and `load()`.

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

Run:

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
- Modify: `.gitignore`

- [ ] **Step 1: Update desktop data root initialization**

In `electron/runtime.cjs`, replace the `.env` creation block in `ensureDataRoot` with:

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

- [ ] **Step 2: Ignore local JSON files**

Add to `.gitignore`:

```gitignore
settings.json
credentials.json
```

- [ ] **Step 3: Run package/runtime checks**

Run:

```bash
npm run desktop:runtime-probe
npm run typecheck
```

Expected: both commands exit `0`.

- [ ] **Step 4: Commit**

```bash
git add electron/runtime.cjs .gitignore
git commit -m "chore: initialize local automation settings"
```

---

### Task 6: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Optional create: `settings.example.json`

- [ ] **Step 1: Update README automation panel section**

Replace the sentence:

```md
The `/automation` page wraps the existing npm scripts. It stores credential edits in `.env`, records task history in `data/ledger/ledger.sqlite`, writes full task logs under `data/automation/logs/`, and keeps only the latest log tail in SQLite.
```

with:

```md
The `/automation` page wraps the existing npm scripts. It stores non-secret switches in `settings.json`, stores secret credential values in `credentials.json`, records task history in `data/ledger/ledger.sqlite`, writes full task logs under `data/automation/logs/`, and keeps only the latest log tail in SQLite.
```

Replace "Useful `.env` flags:" with "Useful `settings.json` keys:" and show JSON instead of shell assignments.

- [ ] **Step 2: Update `.env.example`**

Reduce `.env.example` to legacy/CLI-only guidance:

```dotenv
# Legacy CLI-only fallback. The desktop automation panel stores app settings in
# settings.json and secret credentials in credentials.json.
AUTOMATION_BUSINESS_TIMEZONE=Asia/Taipei
```

- [ ] **Step 3: Add optional settings example**

Create `settings.example.json` if a committed example is useful:

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

- [ ] **Step 4: Run privacy check**

Run:

```bash
npm run privacy-check
```

Expected: exits `0`.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example settings.example.json
git commit -m "docs: document automation JSON config"
```

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
- Running a task still receives the same env variable names as before.

## Self-Review

- Spec coverage: covers `settings.json`, `credentials.json`, migration away from `.env`, route save behavior, runner env behavior, docs, and verification.
- Placeholder scan: no TBD/TODO/implement-later placeholders.
- Type consistency: plan uses `AutomationSettingsFile`, `AutomationCredentialsFile`, `settingsToEnv`, `credentialStatusFromValues`, `splitAutomationUpdates`, and `automationConfigEnv` consistently.

Skipped: OS keychain/safeStorage encryption. Add it when the Electron main/preload API migration lands, so only one native boundary owns credential encryption.
