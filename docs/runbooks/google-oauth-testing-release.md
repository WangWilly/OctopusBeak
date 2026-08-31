# Google OAuth Testing release runbook

This runbook prepares the restricted Gmail OTP configuration for the signed
Electron release pipeline. It does not create a version, tag, GitHub Release,
or production OAuth client by itself.

The release uses a Google OAuth project in **Testing** status. Only accounts
listed as Google OAuth test users can authorize it. The application UI and
release notes intentionally do not describe this restriction. Do not put a
real client JSON file in Git or paste a secret into a command, issue, pull
request, or CI log.

## Required names and paths

| Item | Value |
| --- | --- |
| GitHub Environment | `release` |
| Environment secret | `GOOGLE_OAUTH_DESKTOP_CLIENT_ID` |
| Environment secret | `GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET` |
| Local/build path | `data/google-oauth/google-oauth-desktop-client.json` |
| Required file mode | `0600` |
| Requested Gmail scope | `https://www.googleapis.com/auth/gmail.readonly` |

The JSON is an installed-app Google OAuth client document. Its `installed`
object must contain a client ID. If authorization/token endpoints are present,
they must be HTTPS; the application uses Google's HTTPS endpoints when those
optional fields are omitted. The packager intentionally keeps only this exact
file under the packaged `app/data/google-oauth/` path.

## One-time Google Cloud setup

1. Use a dedicated Google Cloud project for Testing. Do not reuse the future
   Production project.
2. Configure the OAuth consent screen for the project and add every account
   that may test the feature to its Test users list.
3. Enable the Gmail API for the project.
4. Create or download a **Desktop app** OAuth client. Keep the downloaded JSON
   outside the repository until it is copied to the local path below.
5. Confirm that the project, client, consent-screen status, test-user list, and
   requested scope are the same configuration used by the test account. A
   Google authorization screen can reject an account even when the JSON is
   structurally valid.

## Local development setup

Create the ignored directory and copy the downloaded client document to the
exact path expected by the app:

```sh
mkdir -p data/google-oauth
cp /path/to/downloaded/client-secret.json data/google-oauth/google-oauth-desktop-client.json
chmod 600 data/google-oauth/google-oauth-desktop-client.json
```

Check the mode without displaying the file:

```sh
# macOS
stat -f '%Sp %Lp %N' data/google-oauth/google-oauth-desktop-client.json

# Linux
stat -c '%A %a %n' data/google-oauth/google-oauth-desktop-client.json
```

The numeric mode must be `600`. Confirm that `git status --short` does not
show the file. Do not add an exception to `.gitignore`; the repository's
`data/` rule is the intended protection for local runtime data.

For a structure-only check, parse the JSON and verify that it has the
installed-app shape and non-empty `client_id`; do not print the parsed object
or any value from it. The normal Forge pre-package check must also pass before
an unsigned local package is attempted.

## Configure GitHub Actions

The secrets belong to the protected `release` Environment, not to a source
file, repository variable, pull-request comment, or checked-in GitHub Actions
configuration.

Using GitHub's web UI:

1. Open the repository's **Settings → Environments → release**.
2. Keep required reviewer approval enabled.
3. Add `GOOGLE_OAUTH_DESKTOP_CLIENT_ID` and
   `GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET` as Environment secrets.
4. Paste each value into its matching secret and save it. Never combine the
   two values into one JSON secret.

Using GitHub CLI, run each command interactively so the value is not placed in
shell history:

```sh
gh secret set GOOGLE_OAUTH_DESKTOP_CLIENT_ID --env release
gh secret set GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET --env release
```

Verify only the names and timestamps, never values:

```sh
gh secret list --env release
```

The release job must read these secrets only after the `release` Environment is
approved. Before packaging it should create
`data/google-oauth/google-oauth-desktop-client.json` from the two values,
write it with mode `0600`, validate its structure without printing it, and
remove it in an `always` cleanup step. The materialization step belongs in the
macOS build job, immediately before `npm run desktop:make:signed`; it is not a
repository-generated artifact and must not be added to the preflight commit.

## Release preflight

Before dispatching a real release:

1. Confirm the workflow is run from `main`, the `release` Environment still
   requires approval, and all Apple signing/notarization secrets are present.
2. Confirm both Google secret names are listed in the Environment and that the
   workflow's materialization step validates mode `0600` and has
   failure-safe cleanup.
3. Run the normal local checks and tests. A missing local OAuth JSON should
   fail packaging; that is expected for a clean checkout unless a local test
   file has been supplied.
4. Remember that the current release workflow is a real versioning and
   publication flow, not a dry run. `new-release` creates a version commit and
   tag; `retry` rebuilds an existing draft tag. Do not dispatch either operation
   merely to test secret injection.
5. When authorized to publish, use the existing immutable-release procedure in
   [Desktop Release](../desktop-release.md). The generated DMG/ZIP contains the
   client configuration by design; it must not contain access tokens, refresh
   tokens, or mailbox contents.

After a build, inspect only the file path, permissions, packaging result, and
cleanup result. Never print the generated JSON, its fields, or the secret
environment variables. A failed build must still remove the runner copy.

## Troubleshooting

### Missing or invalid OAuth configuration

If Forge reports that the Desktop Google OAuth client configuration is missing,
the local file is absent from the expected path or the release materialization
step did not run in the same job as packaging. If it reports an invalid
configuration, check the downloaded client is a Desktop/`installed` client
document, that its endpoints are HTTPS, and that the two Environment secrets
were not transposed or truncated. Replace the local file or rotate the
Environment secret; do not relax the packager's path or validation rules.

### Google blocks authorization

Check that the account is an exact Test user in the Testing project, the Gmail
API is enabled in that project, and the client belongs to that project. A
valid-looking JSON file cannot authorize an account that is outside the
allowlist. If the refresh token is expired or revoked, reconnect from the app;
do not copy a token into CI.

### Gmail OTP is not retrieved

Confirm the feature was enabled by the user, the Gmail grant is connected, and
the message satisfies the Cathay sender, subject, timing, and code-shape
contract. The workflow polls for five seconds at a time for up to two minutes;
missing, stale, ambiguous, or unauthenticated mail returns to human
verification. This is separate from build-time OAuth client configuration.

### A value appeared in CI output or Git history

Treat it as an incident even though an installed-app client is exposed in the
desktop artifact. Stop the affected release, rotate or disable the Testing
OAuth client in Google Cloud, replace both Environment secrets as applicable,
and inspect GitHub Actions logs and artifacts for further exposure. Do not
attempt to hide a leaked value by editing only the latest commit. User grants,
refresh tokens, and mailbox contents require separate local revocation and
must never be uploaded as a remediation artifact.

## Rotation, revocation, and incident response

For planned rotation or suspected exposure:

1. Pause the release workflow and preserve only sanitized run metadata (run ID,
   commit, timestamps, and failure category).
2. In Google Cloud, rotate the Testing client secret or disable/delete the
   Testing client. If the client identity itself must change, create a new
   Desktop client rather than editing the packaged JSON by hand.
3. Update both `release` Environment secrets through the UI or interactive
   `gh secret set` commands. Verify names only.
4. For already-authorized test accounts, revoke the app grant in the Google
   Account security page or use the app's disconnect action. Existing local
   refresh tokens are encrypted on-device; they are not part of GitHub
   Actions and must not be copied to the runner.
5. Remove any affected draft release artifacts and rebuild only through the
   immutable release procedure once the client and secrets are validated.
6. Record what was rotated, which release/run was affected, and which test
   accounts must reconnect. Do not record client secrets, tokens, OTPs, or
   message bodies.

## Moving to Production later

Do not turn the Testing project into the Production project in place.

1. Create a separate Google Cloud Production project and Desktop OAuth client.
2. Configure the Production consent screen, authorized domains/redirect setup
   required by Google, and the intended external-user policy. Complete the
   required Restricted Scope OAuth App Verification before broad distribution.
3. Create a separate protected GitHub Environment (for example,
   `release-production`) or explicitly update the release workflow's selected
   Environment only as part of an approved migration. Store Production values
   under the same two secret names in that separate Environment; never mix
   Testing and Production values in one JSON or one secret.
4. Run a controlled authorization and Gmail OTP smoke test with Production
   accounts, then run the complete release preflight.
5. Publish a new immutable desktop version. Do not rewrite a Testing release or
   reuse its tag. Keep the Testing client available only for the remaining
   allowlisted test workflow until its grants are intentionally revoked.

## References

- [Local Gmail OAuth ADR](../adr/0014-local-gmail-oauth-for-cathay-email-otp.md)
- [Desktop Release](../desktop-release.md)
- [Google OAuth for installed applications](https://developers.google.com/identity/protocols/oauth2/native-app)
- [GitHub Actions Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)
