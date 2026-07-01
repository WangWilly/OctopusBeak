# Desktop Release

OctopusBeak desktop releases use Electron Forge.

Current packaging target: macOS arm64. Windows packaging is not configured yet.

Desktop app runtime state lives in:

```text
~/Library/Application Support/OctopusBeak/
```

## Local Unsigned Build

```bash
npm run desktop:package
open out/*/OctopusBeak.app
```

Use this for local smoke testing only.

The unpacked app is created under:

```text
out/OctopusBeak-darwin-arm64/OctopusBeak.app
```

## macOS Signing Identity

List installed signing identities:

```bash
security find-identity -p codesigning -v
```

The signing identity must include a `Developer ID Application` certificate for distribution outside the Mac App Store.

## Notarization Credentials

Store notarization credentials in the local keychain profile used by Forge:

```bash
xcrun notarytool store-credentials OctopusBeakNotary \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD"
```

`APPLE_PASSWORD` is an app-specific password, not the normal Apple ID password.

## Signed Build

```bash
OCTOPUSBEAK_SIGN=1 OCTOPUSBEAK_NOTARY_PROFILE=OctopusBeakNotary npm run desktop:make
```

Forge signs and notarizes during packaging when `OCTOPUSBEAK_SIGN=1`.

Release artifacts are written to:

```text
out/make/OctopusBeak-0.1.0-arm64.dmg
out/make/zip/darwin/arm64/OctopusBeak-darwin-arm64-0.1.0.zip
```

## Verification

Run code checks before packaging:

```bash
npm run typecheck
npm run check:libretto-patch
node electron/runtime.check.cjs
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-command.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
npm run desktop:runtime-probe
npm run desktop:strip-types-probe
```

Verify the signed app:

```bash
codesign --verify --deep --strict --verbose=2 out/OctopusBeak-darwin-arm64/OctopusBeak.app
spctl --assess --type execute --verbose=4 out/OctopusBeak-darwin-arm64/OctopusBeak.app
```

Expected Gatekeeper source:

```text
source=Notarized Developer ID
```

## Smoke Test

1. Install the generated DMG on a clean macOS account or a clean `/Applications/OctopusBeak.app` path.
2. Launch OctopusBeak from `/Applications`.
3. Open `/overview`, `/assets`, `/liabilities`, and `/automation`.
4. Save credentials in the automation panel.
5. Run the mock ledger seed flow from a developer build, or import known-safe CSV files.
6. Confirm new files appear under `~/Library/Application Support/OctopusBeak/`.
7. Confirm Gatekeeper accepts the installed app:

```bash
spctl --assess --type execute --verbose=4 /Applications/OctopusBeak.app
```

Do not run real bank workflows in automated checks.
