# Local Gmail OAuth for Cathay Email OTP

Status: accepted

## Decision

Cathay United Bank Email OTP may be completed automatically through a user-enabled Gmail connection. The feature is Cathay-specific, is disabled by default, and uses a project-provided Google Desktop OAuth client with the `gmail.readonly` restricted scope. Authorization runs in the system browser with PKCE and a loopback callback; the application never asks for or stores the person's Google password.

The Gmail refresh token is an Authentication Secret encrypted locally with Electron `safeStorage`. Access tokens and message contents remain in memory. Turning the feature off stops Gmail access without revoking the grant; disconnecting the account revokes the grant when possible, deletes the local token, and turns the feature off. First authorization begins only from the person's enable action. If an enabled workflow discovers an expired or invalid refresh token, it opens the system browser directly for renewed authorization. OAuth is single-flight across concurrent Cathay runs.

The workflow establishes usable Gmail authorization before asking Cathay to send an OTP. Immediately before that request, the host snapshots the IDs of recent matching Gmail messages and returns an opaque, single-use boundary identifier; this avoids treating clock differences between the device and Gmail as evidence that a new message is stale. It then polls Gmail every five seconds for at most two minutes and considers only message IDs absent from that snapshot. A message is eligible only when it is new to that request boundary and its authenticated sender path, exact CUBE subject and template, five-minute validity statement, and single four-letter-plus-six-digit answer match the calibrated Cathay login Email OTP family. Direct Gmail delivery requires Google-verified Cathay sender authentication. Apple Hide My Email delivery requires Google-verified iCloud authentication, an iCloud DKIM signature covering the relay header, and the signed relay header identifying the calibrated Cathay delivery domain.

Exactly one eligible message with exactly one answer is required. The workflow fills and submits that answer at most once. Missing, ambiguous, stale, unauthenticated, rejected, uncertain, OAuth-cancelled, or timed-out retrieval returns to the existing human assistance path. OTP values, message bodies, and mailbox content are not persisted or logged.

Development begins with a Google OAuth project in Testing status and allowlisted test users. Public distribution remains gated by Google's Restricted Scope OAuth App Verification.

## Considered Options

- **Gmail API with OAuth and local polling** — chosen because it avoids collecting a mailbox password, keeps tokens and message processing on-device, works for Gmail and Google Workspace, and requires no public notification backend.
- **Generic IMAP with a mailbox or app-specific password** — rejected because providers differ, Google recommends OAuth, and collecting another long-lived password broadens the Authentication Secret surface.
- **Gmail push notifications through Google Cloud Pub/Sub** — rejected because it requires remotely reachable infrastructure and is disproportionate to one short login window.
- **Remote OTP-reading service** — rejected because it would transmit mailbox authorization or message content outside the Local financial data boundary.
- **Metadata-only Gmail scope** — rejected because it cannot reliably read the OTP from the message body.
- **Automatic choice among multiple messages or answers** — rejected because a guessed OTP increases rejection and lockout risk.
- **Fill without submit** — rejected because it still requires the person to return to the workflow and does not complete the requested automation.

## Consequences

- The desktop application needs a Gmail connection lifecycle, encrypted token storage, OAuth loopback coordination, and Gmail REST access without introducing a remote application backend.
- Cathay settings need separate enable, connect/reconnect, connection-status, and disconnect actions.
- Cathay login must retain its human Email OTP contract as the fallback for every unsupported or uncertain outcome.
- Candidate parsing and sender authentication need sanitized fixtures for direct Gmail and Apple Hide My Email delivery, including nested MIME and signed relay headers.
- The production OAuth consent screen and restricted-scope verification become release prerequisites rather than implementation prerequisites.
