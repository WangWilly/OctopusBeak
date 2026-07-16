import type { BarChartProps } from "layerchart";

export type SpendingChartInteraction = "static" | "brush" | "pan-zoom" | "brush-pan-zoom";

type InteractionProps = Pick<BarChartProps<unknown>, "brush" | "transform">;

export type SpendingChartViewport = {
  startIndex: number;
  endIndex: number;
  atStart: boolean;
  atEnd: boolean;
};

const transform: NonNullable<InteractionProps["transform"]> = {
  mode: "domain",
  axis: "x",
  scrollMode: "scale",
  scrollActivationKey: "meta",
  scaleExtent: [1, 6],
};

export function spendingChartViewport(
  rowCount: number,
  width: number,
  scale: number,
  translateX: number,
): SpendingChartViewport | null {
  if (rowCount <= 0 || width <= 0) return null;
  const scaledWidth = width * Math.max(1, scale);
  const startIndex = Math.min(
    rowCount - 1,
    Math.floor(Math.max(0, -translateX) / scaledWidth * rowCount),
  );
  const endIndex = Math.min(
    rowCount - 1,
    Math.max(
      startIndex,
      Math.ceil(Math.min(scaledWidth, width - translateX) / scaledWidth * rowCount) - 1,
    ),
  );
  return { startIndex, endIndex, atStart: startIndex === 0, atEnd: endIndex === rowCount - 1 };
}

export function spendingChartInteractionProps(mode: SpendingChartInteraction): InteractionProps {
  if (mode === "brush") {
    return { brush: { axis: "x", minExtent: { x: 2 }, zoomOnBrush: false }, transform: undefined };
  }
  if (mode === "pan-zoom") return { brush: false, transform };
  if (mode === "brush-pan-zoom") {
    return { brush: { axis: "x", minExtent: { x: 2 } }, transform };
  }
  return { brush: false, transform: undefined };
}
