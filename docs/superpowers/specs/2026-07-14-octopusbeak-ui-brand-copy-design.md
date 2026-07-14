# OctopusBeak UI Brand Copy Design

## Goal

Replace user-facing references to the implementation platform name `Electron app` with the product name `OctopusBeak`.

## Scope

- Update the English language and display-size descriptions in `src/lib/i18n/i18n.ts`.
- Update the matching Traditional Chinese descriptions.
- Keep technical identifiers, Electron imports, runtime messages, errors, and documentation unchanged.
- Use `OctopusBeak` in full prose. Reserve `OB` for compact branding surfaces only; none are added here.

## Verification

- Extend the existing i18n check with the four exact expected descriptions.
- Assert that serialized user-facing translations do not contain `Electron app`.
- Run the focused i18n check and TypeScript/Svelte typecheck.

## Non-goals

- No global text replacement.
- No brand-name constant or new abstraction.
- No layout, behavior, or API changes.
