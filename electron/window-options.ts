import type { BrowserWindowConstructorOptions } from "electron";

type IntegratedTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
>;

export function integratedTitleBarOptions(
  platform: NodeJS.Platform = process.platform,
): Partial<IntegratedTitleBarOptions> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
    };
  }

  // ponytail: keep non-mac native until Windows/Linux integrated titlebars are visually verified.
  return {};
}
