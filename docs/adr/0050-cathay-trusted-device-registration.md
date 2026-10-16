# Cathay trusted-device registration

Status: proposed. It becomes accepted after the owner's live run shows that a registered device signs in without an OTP on two consecutive runs (issue #215).

## Context

Every Cathay United Bank run reaches Cathay's login OTP step. Gmail retrieval of the Email OTP ([ADR 0014](0014-local-gmail-oauth-for-cathay-email-otp.md)) requires Google OAuth, and Google's Testing status blocks wide release. On 2026-10-16 every run on the owner's App also failed with `challenge-unavailable` because the Email send control was not visible.

After a successful OTP, Cathay asks 「信任這台裝置？」. The run always answered 「暫時不用加入信任裝置」. TedLin1993/all-set-tw (MIT) registers a trusted device after its first OTP and restores only the `CUB.eBank.DeviceId` cookie on later syncs, which then skip the OTP. The App browser saved every cookie, but the `cathay-login` profile ([ADR 0033](0033-browser-runtime-profiles.md)) dropped every `cathaybk.com.tw` cookie before each run, so a trusted device could never be recognised.

## Decision

Cathay gets a Source device registration in its sign-in settings, the same action TDCC has ([ADR 0041](0041-tdcc-epassbook-app-protocol-source.md)).

- The person clicks Register. The App signs in with the saved Sign-in Details in an App-owned browser that uses the Cathay task's browser state and profile. It sends one code by the channel Cathay shows (Email or SMS), asks the person to type that code in the settings UI, submits it once, and answers Cathay's 「信任這台裝置？」 prompt with 「加入信任裝置」. Cathay's prompt offers only 「加入信任裝置」 and 「暫時不用」 and takes no device name (observed live on 2026-10-16).
- Registration succeeds only when the browser holds `CUB.eBank.DeviceId`. The App browser host saves it into the task's encrypted cookie state, as it does for runs. The App records the sign-in identifier it registered for. The status shows Registered only while that identifier matches the saved one.
- The `cathay-login` profile still drops retained Cathay session cookies before a run but keeps `CUB.eBank.DeviceId`. The profile revision moves to 2.
- Sign-in settings disclose that registering adds the App's browser as a trusted device on the person's Cathay account, that it can be removed in Cathay's 裝置管理, and that trust set up elsewhere may revoke it.
- A run whose device is trusted passes login without an OTP. A run that meets Cathay's OTP asks one question, through `cathayRunOtpRoute`: does the person keep Gmail OTP mailbox authorization connected? If yes, the ADR 0014 Gmail path runs unchanged. If not, the run fails with `device-registration-required` and the dashboard links to Cathay sign-in settings. Runs never prompt for a code ([ADR 0039](0039-solver-only-verification.md)) and never add a trusted device.
- One registration runs at a time, and a Cathay run and a registration never overlap. Each source has its own device lock, and the runner refuses a run of a source while its registration holds the lock.

TDCC and Cathay share one registration session (codes, timeout, cancel, lock) and one settings component. Each source supplies only its sign-in, trust check, and copy.

## Removing Gmail

When the live run confirms trust holds, a follow-up removes Gmail OTP mailbox authorization and its code, and marks ADR 0014 superseded. Until then Gmail stays as the fallback for people who connected it.

## Considered options

- **Let a Gmail-backed run accept the trusted-device prompt.** Rejected. It adds a device to the person's bank account without a settings action they can see, and it still needs Gmail for the first run.
- **Restore the whole Cathay cookie jar.** Rejected. Stale Cathay session cookies are why the profile resets that domain. all-set-tw restores only the device cookie.
- **A separate Cathay registration UI and service.** Rejected. The TDCC session state machine, lock, and component carried no TDCC-specific logic beyond its sign-in, so one shared version is less code than two.
