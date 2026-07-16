# Yuanta HITL disables Logitech mouse scrolling on macOS

- Date: 2026-07-16
- Status: Fixed and verified on hardware
- Affected workflow: `yuanta-trade-statements`
- Affected device: Logitech M720 over Bluetooth Low Energy
- Platform: macOS

## Symptom

When `yuanta-trade-statements` reached its human-in-the-loop pause on the YuanTa login page, the M720 wheel stopped scrolling in every macOS application. Pointer movement and buttons still worked, and the MacBook trackpad could still scroll. Closing only the HITL viewer did not recover the wheel; closing the browser page or browser did.

The workflow could also log `page.evaluate: Execution context was destroyed, most likely because of a navigation`. That navigation race is a separate issue and was not the cause of the system-wide wheel failure.

## Root cause

Playwright's `locator.fill()` focuses the target field and leaves it focused. `fillTradeLoginForm()` filled `#loginPWD` immediately before `pause(authSession)`, so YuanTa's `input[type=password]` remained focused for the entire HITL wait.

On this macOS and Logitech combination, that password focus activated a Secure Input path under which the M720 continued producing pointer events but stopped producing scroll events. This was not a CPU or memory exhaustion problem.

## Evidence

The following A/B checks isolated the trigger:

1. An empty Playwright headless Chromium did not reproduce the problem.
2. Loading the YuanTa login page without focusing the password field did not reproduce it.
3. CDP screenshot connections, the remote debugging port, and both Chromium headless runtimes did not reproduce it by themselves.
4. Focusing `#loginPWD` and filling a dummy value reproduced the system-wide M720 wheel failure without running the workflow or entering HITL.
5. Calling `blur()` restored the wheel immediately while the YuanTa page, renderer, Chromium browser process, and workflow daemon all remained alive.
6. During the failure, macOS HID service counters continued increasing for `Pointer` but not `Scroll`. Restarting the Logitech daemon did not recover scrolling.

## Fix

Remove focus from the password field immediately after filling it and before entering HITL:

```ts
await page.locator("#loginPWD").fill(password);
await page.locator("#loginPWD").blur();
```

The fix is in `src/workflows/yuanta-trade-statements.ts`. Its regression check in `src/workflows/yuanta-trade-statements.check.ts` verifies that credential filling ends with `blur:#loginPWD`.

## Verification

- Targeted YuanTa workflow checks: 4/4 passed.
- Full test suite: 140/140 passed.
- Type checking: 0 errors and 0 warnings.
- Packaged OctopusBeak app: verified at the YuanTa HITL wait with the affected M720; scrolling remained functional across macOS applications.

## Recovery and prevention

For an already affected session, blur the password field through the page or close the YuanTa page/browser. Restarting Logi Options is not sufficient.

For future HITL workflows, do not pause while a password input remains focused. Explicitly blur sensitive fields after programmatic filling when the page will remain open for human interaction.
