# Local Gmail OAuth for Cathay Email OTP

Status: accepted; amended by [ADR 0039](0039-solver-only-verification.md)

ADR 0039 removed manual Email OTP entry and the development-only human actor. Gmail retrieval is the only way the Cathay workflow completes Email OTP. When the Cathay send button is not visible, the workflow fails with the typed reason `challenge-unavailable`. The sentences below about manual Email OTP describe the original decision and no longer apply.

## Decision

Cathay United Bank Email OTP is automatic and requires an explicitly authorized Gmail connection. There is no user-facing enable/disable switch; legacy disabled flags do not block an existing grant. The feature is Cathay-specific and uses a project-provided Google Desktop OAuth client with the `gmail.readonly` restricted scope. Authorization runs in the system browser with PKCE and a loopback callback; the application never asks for or stores the person's Google password.

The Gmail refresh token is an Authentication Secret encrypted locally with Electron `safeStorage`. Access tokens and message contents remain in memory. Disconnecting the account revokes the grant when possible and deletes the local token; automatic verification then reports that authorization is required. First authorization begins only from the person's connect action. A workflow may silently refresh an existing valid grant; if the grant is missing or invalid, it stops with a specific reason and directs the person to Gmail settings to connect or reconnect before starting another run. It never opens OAuth from the automatic workflow. OAuth is single-flight across concurrent Cathay runs.

The workflow establishes usable Gmail authorization before asking Cathay to send an OTP. Immediately before that request, the host snapshots the IDs of recent matching Gmail messages and returns an opaque, single-use boundary identifier; this avoids treating clock differences between the device and Gmail as evidence that a new message is stale. It then polls Gmail every five seconds for at most two minutes and considers only message IDs absent from that snapshot. A message is eligible only when it is new to that request boundary and its authenticated sender path, exact CUBE subject and template, five-minute validity statement, and single four-letter-plus-six-digit answer match the calibrated Cathay login Email OTP family. Direct Gmail delivery requires Google-verified Cathay sender authentication. Apple Hide My Email delivery requires Google-verified iCloud authentication, an iCloud DKIM signature covering the relay header, and the signed relay header identifying the calibrated Cathay delivery domain.

Exactly one eligible message with exactly one answer is required. The workflow fills and submits that answer at most once. Under automatic verification, missing authorization, ambiguous, stale, unauthenticated, rejected, uncertain, OAuth-cancelled, or timed-out retrieval ends the run with a specific reason and applicable setup guidance; it never returns to human assistance. A person can correct the setup and start a new run. Manual Email OTP is available only when the source uses the explicit development-only human actor defined in ADR 0012; that actor does not invoke automatic retrieval. OTP values, message bodies, and mailbox content are not persisted or logged.

Development and the first restricted desktop releases use a Google OAuth project in Testing status with allowlisted test users. The Google Desktop OAuth client configuration is never committed to Git. Local development reads `data/google-oauth/google-oauth-desktop-client.json`; the file is ignored by Git and must be readable only by its owner. The GitHub `release` Environment stores the Testing client ID and client secret as separate secrets, `GOOGLE_OAUTH_DESKTOP_CLIENT_ID` and `GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET`. The release job materializes the exact JSON file on the runner with mode `0600` immediately before packaging and removes it after the job, including failure cleanup. It must not print the values or include them in ordinary CI output.

The desktop package necessarily exposes this OAuth client identity, including the installed-app `client_secret`; this is accepted for the Testing release and is not treated as protection for user grants or tokens. Refresh tokens remain local Authentication Secrets and are encrypted with `safeStorage`. The application UI and release notes do not disclose the Testing-user restriction. A future broadly available release must use a separate Google project and client and pass Google's Restricted Scope OAuth App Verification before changing the distribution boundary.

## Considered Options

- **Gmail API with OAuth and local polling** — chosen because it avoids collecting a mailbox password, keeps tokens and message processing on-device, works for Gmail and Google Workspace, and requires no public notification backend.
- **Generic IMAP with a mailbox or app-specific password** — rejected because providers differ, Google recommends OAuth, and collecting another long-lived password broadens the Authentication Secret surface.
- **Gmail push notifications through Google Cloud Pub/Sub** — rejected because it requires remotely reachable infrastructure and is disproportionate to one short login window.
- **Remote OTP-reading service** — rejected because it would transmit mailbox authorization or message content outside the Local financial data boundary.
- **Metadata-only Gmail scope** — rejected because it cannot reliably read the OTP from the message body.
- **Automatic choice among multiple messages or answers** — rejected because a guessed OTP increases rejection and lockout risk.
- **Fill without submit** — rejected because it still requires the person to return to the workflow and does not complete the requested automation.
- **Commit the Desktop OAuth JSON** — rejected because it places a build input in Git history and makes accidental reuse or copying easier; the release runner can reconstruct it from protected Environment Secrets without changing the packaged application's required path.
- **Keep the client secret out of the packaged app** — rejected for this installed-app OAuth shape because the current application must contain the client configuration to start authorization; the secret is therefore treated as a public client credential, while user grants and tokens remain protected locally.

## Consequences

- The desktop application needs a Gmail connection lifecycle, encrypted token storage, OAuth loopback coordination, and Gmail REST access without introducing a remote application backend.
- Cathay settings show automatic verification status, connect/reconnect, connection status, and disconnect actions; users cannot turn off automatic verification.
- Cathay login retains its human Email OTP contract only for explicitly enabled development verification, not as an automatic-verification fallback. Gmail authorization remains an explicit user action; defaulting to automatic verification does not grant mailbox access.
- Candidate parsing and sender authentication need sanitized fixtures for direct Gmail and Apple Hide My Email delivery, including nested MIME and signed relay headers.
- The production OAuth consent screen and restricted-scope verification become release prerequisites rather than implementation prerequisites.
- Testing release builds require protected release Environment Secrets and a cleanup-guaranteed, owner-readable temporary configuration file. A missing or malformed file must fail packaging before an installer is produced.
- Rotating or revoking the Testing client invalidates future authorization and may require users to reconnect; it does not expose or recover any local refresh token. Testing and future Production clients must be operated and rotated independently.
