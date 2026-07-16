import type { SpendingChartViewport } from "./spending-chart-interaction.ts";

export const SPENDING_CHART_VISIBLE_MONTHS = 18;
export const SPENDING_CHART_OVERSCAN = 2;

export function spendingChartInitialTransform(rowCount: number, width: number) {
  const scale = Math.max(1, rowCount / SPENDING_CHART_VISIBLE_MONTHS);
  return { scale, translateX: width > 0 ? width - width * scale : 0 };
}

export function spendingChartRenderWindow(
  rowCount: number,
  viewport: SpendingChartViewport | null,
) {
  if (rowCount <= 0 || !viewport) return null;
  return {
    startIndex: Math.max(0, viewport.startIndex - SPENDING_CHART_OVERSCAN),
    endIndex: Math.min(rowCount, viewport.endIndex + 1 + SPENDING_CHART_OVERSCAN),
  };
}
