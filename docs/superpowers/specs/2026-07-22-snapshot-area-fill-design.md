# Snapshot area fill

## Goal

Show a low-opacity fill between each overview history line and its visible baseline.

## Design

- Reuse LayerChart's `yBaseline` in `SnapshotSparkline`.
- With all or multiple selected series, use `0`: positive values fill down to zero and liabilities fill up to zero.
- With one selected series, use the visible domain edge: positive series fill downward; liabilities fill upward.
- Keep the existing Y-axis brushing, automatic ticks, and trend-scale domains.
- Apply a subtle shared area opacity while leaving the lines unchanged.

## Verification

- Add a component-source check for the baseline and visible fill style.
- Verify the overview chart with a single positive and a single negative selection in the Electron app.
