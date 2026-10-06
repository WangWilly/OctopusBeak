import type { BrowserWindowConstructorOptions } from "electron";
import { displayScaleZoomFactor } from "../src/lib/settings/display-zoom.ts";

type IntegratedTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
>;

const defaultTrafficLightPosition = { x: 14, y: 23 } as const;
const trafficLightRadius = 7;

export const isFiniteDisplayScale = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function trafficLightPositionForScale(percent: number) {
  if (!isFiniteDisplayScale(percent)) throw new TypeError("Display scale must be finite.");
  const zoomFactor = displayScaleZoomFactor(percent);
  return {
    x: defaultTrafficLightPosition.x,
    y: Math.round(
      (defaultTrafficLightPosition.y + trafficLightRadius) * zoomFactor - trafficLightRadius,
    ),
  };
}

export function integratedTitleBarOptions(
  platform: NodeJS.Platform = process.platform,
): Partial<IntegratedTitleBarOptions> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: trafficLightPositionForScale(100),
    };
  }

  // ponytail: keep non-mac native until Windows/Linux integrated titlebars are visually verified.
  return {};
}
