# Desktop Release

OctopusBeak desktop releases use Electron Forge.

## Local Unsigned Build

```bash
npm run desktop:package
open out/*/OctopusBeak.app
```

Use this for local smoke testing only.

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

## Smoke Test

1. Install the generated DMG on a clean macOS account.
2. Launch OctopusBeak from `/Applications`.
3. Open `/overview`, `/assets`, `/liabilities`, and `/automation`.
4. Save credentials in the automation panel.
5. Run the mock ledger seed flow from a developer build, or import known-safe CSV files.
6. Confirm new files appear under `~/Library/Application Support/OctopusBeak/`.

Do not run real bank workflows in automated checks.
