# Automation Disclosure Motion Design

## Goal

Add a consistent expanding and collapsing motion to the automation workflow disclosures shown in the approved screenshots.

## Interaction

- Stage bodies expand and collapse vertically in 220 ms.
- Inline task logs use the same vertical motion beneath the selected task.
- Additional collect-stage task rows animate when `顯示全部任務` is toggled.
- Stage carets rotate over 180 ms so the control state changes with the content.
- Reduced-motion users receive an immediate state change.

## Constraints

- Reuse Svelte's installed `slide` transition and the existing component state.
- Do not add packages for the disclosure motion, or add routes, data state, or new visual styling.
- Preserve table semantics, fixed column widths, labels, and existing controls.

## Verification

- Add a source-level regression check for the shared transition and each disclosure surface.
- Run the focused check, typecheck, and production build.
- Use the running Electron app over CDP to open and close the three disclosure surfaces and inspect console errors.
