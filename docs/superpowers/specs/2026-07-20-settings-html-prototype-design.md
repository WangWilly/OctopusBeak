# Settings HTML Prototype Design

## Goal

Build one standalone HTML prototype of the approved OctopusBeak settings redesign. It should preserve the current desktop shell while making every setting auto-save through one global status indicator.

## Scope

- Add `docs/prototypes/settings-v2.html` with inline CSS and JavaScript.
- Do not change the production Svelte or Electron settings implementation.
- Reuse the existing visual language: dark sidebar, white top bar, restrained surfaces, native controls, and Traditional Chinese copy.
- Use no new dependencies, assets, routes, or reusable abstractions.

## Layout

The desktop composition keeps the current top bar and left navigation. The content area contains the page title `設定`, its existing descriptive copy, and two settings groups.

### 時區與排程設定

- Use a subtle blue-to-teal treatment limited to the group heading and a faint header wash.
- Keep the description `設定時間戳記使用的時區，以及每日匯率更新時間。`
- Include a timezone select with `Asia/Taipei` selected.
- Include a native time input with `06:00` selected.

### 語言與顯示設定

- Use a subtle violet-to-rose treatment limited to the group heading and a faint header wash.
- Keep the description `調整介面語言與 OctopusBeak 的整體顯示大小。`
- Put the English and 繁體中文 language controls in one row.
- Put display size in the next row with this horizontal order: label, minus button, current percentage, plus button, compact shortcut hint, flexible space, reset button.
- Keep `最小 75%，最大 150%` directly below the stepper cluster.
- Render the shortcut hint as quiet 11–12px text: `⌘− 縮小 · ⌘＋ 放大 · ⌘0 重設`.

## Interaction And Data Flow

The prototype initializes timezone, update time, language, and display size from `localStorage`, falling back to `Asia/Taipei`, `06:00`, `zh-TW`, and `85`.

Every control change follows one shared path:

1. Update the visible control state.
2. Change the top-bar status to `正在儲存…`.
3. Persist the complete settings object to `localStorage`.
4. Change the status to `所有變更已儲存` after a short delay.

There are no per-field saved messages and no Save button. The status sits immediately left of the eye control and represents every editable field.

Display size changes in 5% steps, clamps to 75–150%, and resets to 100%. The buttons and keyboard shortcuts share the same update path. Language selection updates the pressed state immediately.

## Error Handling

If `localStorage` read fails, use defaults. If a write fails, keep the user's visible changes and show `無法儲存` in the global status area. The prototype does not retry or simulate backend failures.

## Responsive And Accessibility Behavior

- Keep the approved desktop layout at wide widths.
- Below 760px, stack field labels above controls and allow the compact shortcut hint to wrap within the display-size row.
- Use native `select` and `input type="time"` controls.
- Give icon-only and stepper buttons accessible labels.
- Expose save status with `role="status"` and `aria-live="polite"`.
- Preserve visible focus styles and respect reduced-motion preferences.

## Verification

- Open the standalone file and compare it visually with the approved mockup at a 1440×1024 viewport.
- Exercise timezone, time, language, minus, plus, reset, and keyboard shortcuts.
- Confirm all controls use the single global save state and persist after reload.
- Confirm bounds, compact shortcut alignment, mobile wrapping, keyboard access, and the failure status path.

## Non-Goals

- No production Svelte/Electron integration.
- No additional settings or secondary navigation.
- No server, build step, framework, dependency, image asset, or deployment.
