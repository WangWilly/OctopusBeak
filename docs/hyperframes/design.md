# OctopusBeak Website Capture Design

## Overview

OctopusBeak is a dense personal finance dashboard with a desktop-first operational layout. The page uses a dark persistent sidebar, a translucent sticky topbar, white data cards, compact tables, and monochrome tabular money values. The visual system is quiet and utilitarian: the product is the dashboard itself, with emphasis on scan speed, hierarchy, and precise money data.

## Colors

- **Background**: `#f9fafc` / `oklch(98.5% 0.003 250)` — page canvas
- **Surface**: `#ffffff` / `oklch(100% 0 0)` — cards and panels
- **Surface Soft**: `#f1f4f6` / `oklch(96.5% 0.004 250)` — secondary fills
- **Surface Strong**: `#0e1217` / `oklch(18% 0.012 250)` — sidebar and primary text
- **Muted**: `#5e646a` / `oklch(50% 0.012 250)` — labels and supporting copy
- **Border**: `#d5d8db` / `oklch(88% 0.006 250)` — panel dividers
- **Accent**: `#006bbb` / `oklch(52% 0.15 250)` — sparkline and secondary action emphasis
- **Accent Soft**: `#dcedff` / `oklch(94% 0.032 250)` — accent chip fill
- **Success**: `#1d7d3e` / `oklch(52% 0.13 150)` — positive state
- **Danger**: `#b33830` / `oklch(52% 0.16 28)` — negative state

## Typography

- **Display**: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Display`, `Inter`, `Segoe UI`, `system-ui`, `sans-serif`. Used for page titles and panel headings.
- **Body**: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, `Inter`, `Segoe UI`, `system-ui`, `sans-serif`. Used for UI labels and supporting copy.
- **Mono**: `Courier Prime`, `SFMono-Regular`, `ui-monospace`, `Menlo`, `Consolas`, `monospace`. Used for all money and tabular values with `font-variant-numeric: tabular-nums`.

## Elevation

Depth is restrained. Panels use 1px borders and small radius, not heavy decoration. The topbar uses translucent surface fill plus blur. In video, keep shadows subtle and use scale/parallax for depth instead of loud glows.

## Components

- **Persistent Finance Sidebar**: dark vertical navigation with brand mark, three route links, and a net position readout.
- **Sticky Overview Topbar**: eyebrow, `Portfolio` title, imported timestamp chip, and value visibility switch.
- **Metric Cards**: white bordered cards with uppercase labels, large mono values, and compact breakdown text.
- **Snapshot Sparkline Panel**: card with currency chip, 30-day chip, blue line chart, and compact history table.
- **Asset Allocation Bars**: right-side panel with category names, percentages, and thin progress bars.
- **Daily History Table**: sortable table with dense rows, right-aligned money values, and pagination controls.

## Do's and Don'ts

### Do's

- Keep the dark sidebar visible as a first-frame brand signal.
- Use real dashboard labels and values from the capture.
- Preserve the white-card, thin-border, mono-number visual language.
- Use motion to guide scanning: card cascade, sparkline drawing, bar fills, table row sweeps.
- Optimize for vertical by staging the desktop dashboard as a moving product surface.

### Don'ts

- Do not iframe the live app; use captured/recreated visuals.
- Do not turn the dashboard into a marketing hero page.
- Do not invent bright gradients or decorative blobs.
- Do not hide the data density; the dense operational feel is the point.
- Do not use tiny text below 16px in rendered video.
