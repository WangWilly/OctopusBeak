# E-Invoice Headless CAPTCHA Assist Design

## Goal

Run the personal e-invoice automation in a headless browser while preserving the existing user-triggered Assist modal for CAPTCHA completion.

## Existing Behavior

The e-invoice workflow fills the phone number and password, focuses the CAPTCHA input, logs a resumable Libretto session, and pauses. The automation runner recognizes that pause as `waiting_for_human`. The Automation dashboard already exposes an Assist button for waiting tasks with a resumable session.

The Assist modal connects to the paused Playwright browser over CDP. It renders screenshots and forwards clicks, drags, text input, and supported key presses to the page. Selecting Resume continues the same Libretto session.

The e-invoice automation task is currently the exception among crawler tasks because its command omits `--headless`.

## Design

Add `--headless` to the `einvoice-personal-invoices` automation command. Keep the existing CAPTCHA pause and existing Assist button behavior unchanged.

The interaction flow is:

1. The automation runner starts the e-invoice workflow headlessly.
2. The workflow fills stored credentials and pauses at the CAPTCHA field.
3. The runner records `waiting_for_human` and the resumable Libretto session.
4. The dashboard displays the existing Assist button.
5. The user opens Assist, reads the CAPTCHA from the screenshot, clicks the CAPTCHA input, and types the value.
6. The user selects Resume, and the workflow submits the login form and continues invoice collection.

The Assist modal remains user-triggered. It does not open automatically.

## Scope

Change only the e-invoice task command and its automation regression check. Do not add a task-level headless abstraction, a second browser, or e-invoice-specific Assist UI.

## Error Handling

Existing behavior remains authoritative:

- Missing or invalid resumable sessions surface through the Assist modal error state.
- Resuming with an empty CAPTCHA fails with the workflow's current actionable error.
- Login timeout and failed CAPTCHA submission remain workflow failures visible in task logs.
- Force Quit remains available through the existing Assist modal.

## Testing

Use test-driven development:

1. Add an assertion that the e-invoice automation command ends with `--headless` and run the automation check to observe the expected failure.
2. Add `--headless` to the task command and rerun the check to pass.
3. Run the TypeScript compiler and relevant automation checks.
4. Start the Electron development app and verify through CDP that a waiting e-invoice task exposes the Assist action and that the modal can display and interact with the paused headless page, if credentials and a live CAPTCHA session are available. If live credentials are unavailable, report that the UI path was verified statically and automated checks passed, without claiming end-to-end CAPTCHA verification.

## Success Criteria

- The e-invoice automation command runs Libretto with `--headless`.
- CAPTCHA pauses still produce a `waiting_for_human` task with a resumable session.
- The existing Assist button remains the user entry point.
- Assist can target the paused headless page through the existing CDP viewer path.
- Existing automation checks and TypeScript compilation pass.
