# Electron Display Scale Design

## Goal

Add a persistent display-scale setting to the Electron app and a transient top-right control for keyboard-driven changes. The selected visual direction is the light frosted capsule shown in option 1.

## Scope

- Electron app only; the ordinary web build keeps its current scale.
- Scale range: 75% to 150%.
- Step: 5% in Settings and from keyboard controls.
- Default and reset value: 100%.
- Keyboard shortcuts:
  - macOS: `Command+-`, `Command++`, `Command+0`.
  - Windows/Linux: `Ctrl+-`, `Ctrl++`, `Ctrl+0`.
- Persist the last valid value on the device and restore it when the Electron renderer starts.

No custom shortcut editor, per-page scale, pinch gesture, or separate text-size setting is included.

## Settings UI

Extend the existing Settings page with one `Display size` card below the language card. Reuse the current card, spacing, typography, border, button, and focus styles.

The card contains:

- A large tabular percentage value.
- A native horizontal range input with 75%, 100%, and 150% labels.
- A Reset button, disabled at 100%.
- One quiet shortcut row showing decrease, increase, and reset keycaps.

Changing the slider applies the scale immediately. The value is clamped to the supported range before it is applied or stored.

## Transient Top-Right Control

Keyboard changes reveal a frosted light capsule under the Electron title bar, aligned 24px from the top and right edges of the content area. It contains, in order:

- Current percentage.
- Decrease button.
- Increase button.
- Reset button.

Hairline dividers separate the controls. The percentage uses tabular numerals. Buttons at the minimum or maximum are disabled.

The capsule:

- Fades and moves up 6px into place over 180ms.
- Remains visible for 1.4 seconds after the last keyboard or capsule action.
- Fades out over 220ms.
- Pauses dismissal while hovered or keyboard-focused.
- Restarts the dismissal timer after each action.
- Uses no movement when `prefers-reduced-motion: reduce` is active.

It is rendered above normal page content but below modal dialogs. Settings slider changes do not show the capsule because the card already provides visible feedback.

## Architecture

Use Electron's native page zoom rather than scaling the application with CSS.

- Renderer: owns the selected percentage, Settings controls, shortcut handling, capsule visibility, and device persistence.
- Preload: exposes one narrow method that applies a validated zoom factor through Electron's `webFrame` API.
- Shared shell: mounts the capsule once so keyboard feedback works on every route.

Reuse the existing local-storage pattern used by the shell. Keep one scale value and one application path; do not add a settings service or new dependency.

## Data Flow

1. On Electron renderer startup, read the stored percentage.
2. Parse it, clamp it to 75–150, fall back to 100, then apply it through preload.
3. Settings, keyboard, and capsule buttons all call the same renderer update function.
4. That function clamps the next value, applies it, persists it, and updates visible UI.
5. Keyboard and capsule actions also reveal or refresh the capsule timer.

The range and reset values are defined once and shared by the Settings control and capsule.

## Error Handling

- Missing or malformed stored values resolve to 100%; finite out-of-range values resolve to the nearest supported bound. The normalized value is stored again.
- The preload boundary rejects non-finite values and clamps valid numeric input again before calling Electron.
- Shortcut handlers ignore events already handled by the app and do not fire while modifier combinations include Alt/Option.
- Timer cleanup runs when the shared shell is destroyed.

## Accessibility

- Slider and buttons have localized accessible names.
- The percentage is announced through a polite live region only for keyboard changes.
- All capsule controls are reachable by keyboard while visible.
- Focus, disabled, hover, and pressed states reuse existing product styles.
- Capsule dismissal never removes a currently focused control.
- Reduced-motion preferences remove translation and shorten the visibility transition to an immediate state change.

## Verification

Keep verification minimal and runnable:

- One small unit check for parsing, clamping, stepping, and reset behavior.
- Existing build and type checks.
- Electron CDP verification at 75%, 100%, and 150% for persistence, shortcuts, disabled bounds, capsule timing, hover/focus pause, and reduced motion.
- Visual comparison of the Settings card and capsule against option 1 at the app's normal desktop window size.

## Acceptance Criteria

- A user can set 75%–150% scale in 5% increments from Settings.
- The selected scale survives an Electron app restart.
- Platform-standard keyboard shortcuts decrease, increase, and reset scale.
- Keyboard changes show the selected option-1 capsule at the top right, then dismiss it with the specified fade behavior.
- The value never exceeds the supported range, regardless of stored or boundary input.
- Web builds outside Electron are unchanged.
