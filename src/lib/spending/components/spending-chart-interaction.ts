import type { BarChartProps } from "layerchart";

export type SpendingChartInteraction = "static" | "brush" | "pan-zoom" | "brush-pan-zoom";

type InteractionProps = Pick<BarChartProps<unknown>, "brush" | "transform">;

const transform: NonNullable<InteractionProps["transform"]> = {
  mode: "domain",
  axis: "x",
  scrollMode: "scale",
  scrollActivationKey: "meta",
  scaleExtent: [1, 6],
};

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
