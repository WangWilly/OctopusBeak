# YuanTa Trade Password Reminder Fix

## Problem

After CAPTCHA sign-in, YuanTa may redirect to
`/NexusWebTrade/NexusWebTrade/ChangePassword?remind=true`. The page is already
authenticated: `#btnLogout` is visible and the signed-in navigation is present.
The trade workflow does not dismiss this optional reminder, so
`librettoAuthenticate()` rechecks `isSignedIn()` while the page is still outside
`/AssetReport/` and reports a false sign-in failure.

This reminder is intermittent. The workflow must handle both its presence and
absence.

## Design

Add one optional post-login step to `yuanta-trade-statements.ts`:

1. Look for the exact button text `暫不變更`.
2. If visible, click it and wait for navigation to settle.
3. If absent, do nothing.
4. Continue through the existing personal-message and AssetReport disclaimer
   handlers.
5. Keep the existing signed-in readiness check: the URL must be under
   `/NexusWebTrade/AssetReport/` and `#btnLogout` must be visible.

The live exploration confirmed that clicking `暫不變更` opens
`/NexusWebTrade/AssetReport/Disclaimer`, where the existing
`acceptDisclaimerIfPresent()` selectors (`#checkDisclaimer`, `#btnConfirm`) are
valid. No URL whitelist, retry system, new dependency, or Libretto patch is
needed.

## Error Handling

Only absence of the optional reminder is ignored. A visible button that cannot
be clicked or whose navigation fails must surface the Playwright error. Existing
authentication, certificate, disclaimer, and session lifecycle errors remain
unchanged.

## Tests

- Regression check: a visible `暫不變更` button is clicked.
- Regression check: an absent reminder causes no click and no failure.
- Run the YuanTa trade workflow checks and project typecheck.
- Validate with a fresh headed Libretto session. After the user completes
  CAPTCHA, confirm the reminder path when it appears, the AssetReport transition,
  and a successful Stock holdings result written to a temporary output folder.
- Close the validation session after inspection.

## Scope

Only the YuanTa securities trade workflow and its focused regression check are
in scope. Other YuanTa workflows, App session lifecycle behavior, credentials,
and report parsing are unchanged.
