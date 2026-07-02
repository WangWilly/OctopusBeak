# Automation SafeStorage Credentials Design

## Goal

Encrypt desktop automation credentials at rest with Electron `safeStorage`. Keep non-secret automation switches in plaintext `settings.json`; keep secret values in `credentials.json`, but store them as an encrypted whole-file envelope.

## Scope

In scope:

- Register an Electron `safeStorage` credential codec in the main process.
- Fail desktop startup with a clear error when `safeStorage.isEncryptionAvailable()` is false.
- Keep legacy plaintext `credentials.json` readable.
- Migrate an existing plaintext `credentials.json` to the encrypted envelope during Electron startup.
- Keep automation workflows unchanged: spawned tasks still receive credentials through `process.env`.
- Keep direct CLI workflow development on exported shell environment variables.

Out of scope:

- Adding `keytar`, native keychain libraries, or another dependency.
- Plaintext fallback in desktop runtime.
- Cross-device credential sync or manual export/import.
- UI redesign or credential form changes.
- Encrypting `settings.json`.

## Approach

Use one storage format for all desktop secrets:

```json
{
  "format": "octopusbeak.credentials.safeStorage.v1",
  "data": "<base64 safeStorage ciphertext>"
}
```

The encrypted payload is the JSON object that `credentials.json` stores today. Whole-file encryption is smaller and less error-prone than per-field encryption because every value in `credentials.json` is already classified as secret.

`src/lib/automation/server/config-files.ts` remains the single credential read/write path. It gains a small process-wide credential codec. When the codec is registered, writes produce the encrypted envelope and reads decrypt it. When no codec is registered, the helper can still read and write plaintext for Node checks and direct development, but an encrypted file without a codec fails with a clear error.

Electron main registers the codec after `app.whenReady()`, `ensureDataRoot(userData)`, runtime env setup, and `process.chdir(userData)`. If `safeStorage.isEncryptionAvailable()` is false, registration throws and the existing startup error dialog quits the app.

## Migration

On Electron startup, after registering the codec and after changing cwd to `userData`, run an explicit credential encryption migration:

1. If `credentials.json` does not exist, do nothing.
2. If it is already an encrypted envelope, do nothing.
3. If it is a plaintext object with known automation secret keys, rewrite it through the normal encrypted writer.

Reads stay side-effect-free. Migration is explicit so dashboard loading does not unexpectedly mutate files.

## Error Handling

- `safeStorage.isEncryptionAvailable() === false`: throw `Electron safeStorage encryption is not available. Refusing to read or write automation credentials.`
- Encrypted credentials without a configured codec: throw `Credential encryption is not configured. Refusing to read encrypted automation credentials.`
- Invalid encrypted envelope: throw an invalid-envelope error instead of treating it as empty credentials.

Do not log credential values or decrypted payloads.

## Testing

Use the existing assert-based checks:

- `config-files.check.ts`: fake codec encrypt/decrypt, encrypted envelope does not contain plaintext, encrypted reads fail without a codec, plaintext credentials migrate to encrypted envelope.
- `desktop-api.check.ts`: saving credentials through the desktop API writes an encrypted envelope when the codec is configured.
- Existing checks remain green: config files, desktop API, runtime, typecheck, build, privacy check.

Manual smoke:

```bash
OCTOPUSBEAK_USER_DATA=/private/tmp/octopusbeak-safe-storage-smoke npm run desktop:dev
```

Save a credential in `#/automation`, quit, then verify the temp `credentials.json` contains an envelope and not the secret text.

## Alternatives Considered

Recommended: Electron `safeStorage` whole-file envelope. This uses the dependency already in the app and keeps the storage diff small.

Rejected: per-field encryption. It adds schema complexity without buying much because every key in `credentials.json` is secret.

Rejected: `keytar` or direct keychain integration. It adds a dependency and packaging surface before there is a demonstrated need beyond Electron `safeStorage`.

Rejected: plaintext fallback when `safeStorage` is unavailable. The chosen behavior is explicit failure, as requested.
