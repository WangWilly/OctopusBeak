# Desktop Release

OctopusBeak desktop releases use Electron Forge.

Current automated release target: macOS arm64. The workflow produces a DMG and ZIP, signs and notarizes the app, verifies the bundle, uploads both installers with a SHA-256 checksum file, and publishes the GitHub Release only after the build succeeds. Windows x64 and Linux x64 are future targets and are not enabled yet.

## Automated GitHub Release

Use the `Release Electron` workflow from the `main` branch. The `new-release` operation runs the release preflight, then accepts a `patch`, `minor`, or `major` version increment. The workflow uses npm's default version commit and `vX.Y.Z` tag, pushes both to `main`, builds the signed macOS arm64 artifacts, creates a Draft GitHub Release with generated notes, uploads the installers and `SHA256SUMS.txt`, and publishes the Draft only after all checks pass.

The `retry` operation accepts an existing `vX.Y.Z` tag. It validates that the tag is unchanged, matches the package version, and is reachable from `main`, then rebuilds that exact version without creating another commit or tag. A published Release cannot be retried; a Draft Release is reused and same-named assets are replaced.

The workflow references the protected `release` Environment. Configure it with required reviewer approval and these secrets:

```text
MACOS_CERTIFICATE_BASE64
MACOS_CERTIFICATE_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

The repository's `main` branch policy must allow this workflow's `GITHUB_TOKEN` to push the version commit and tag. If branch protection requires pull requests for every change, this direct-release workflow will stop at the push step without creating a remote version.

The previous tag-triggered `release-macos.yml` workflow was retired so a release tag cannot start a second competing release process.

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
