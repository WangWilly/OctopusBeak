// The displayed 100% is the old 80% zoom, which reads better on Mac displays.
export const DISPLAY_SCALE_BASE_ZOOM = 0.8;

export function displayScaleZoomFactor(percent: number) {
  if (!Number.isFinite(percent)) throw new TypeError("Display scale must be finite.");
  return (Math.min(150, Math.max(75, percent)) * DISPLAY_SCALE_BASE_ZOOM) / 100;
}
