import { writable } from "svelte/store";

type Domain = [number, number];
type ZoomState = { range: Domain | null; resetKey: number };
type ZoomPolicy =
  | { click: "reset" }
  | { click: "select-day"; defaultDomain: () => Domain };

type Brush = { active?: boolean; y: readonly unknown[]; reset: () => void };

/** A chart supplies its own axis limits whenever there is no selected range. */
export function createBalanceChartZoom(policy: ZoomPolicy) {
  const state = writable<ZoomState>({ range: null, resetKey: 0 });

  const clickToReset = policy.click === "reset";

  function onBrushEnd({ brush }: { brush: Brush }) {
    const [start, end] = brush.y;
    if (!brush.active || !isFiniteNumber(start) || !isFiniteNumber(end)) {
      if (clickToReset) state.update((zoom) => ({ ...zoom, range: null }));
      return;
    }

    const range: Domain = [Math.min(start, end), Math.max(start, end)];
    state.update((zoom) => {
      if (policy.click === "select-day") {
        const [min, max] = zoom.range ?? policy.defaultDomain();
        if (range[1] - range[0] < (max - min) * 0.03) return zoom;
      }
      return { ...zoom, range };
    });
    // The history chart owns the domain and must release even a sub-threshold brush.
    if (policy.click === "select-day") brush.reset();
  }

  return {
    subscribe: state.subscribe,
    brush: { axis: "y" as const, clickToReset, zoomOnBrush: clickToReset, onBrushEnd },
    reset() {
      // Remount LayerChart to clear its internal brush and transform along with our range.
      state.update(({ resetKey }) => ({ range: null, resetKey: resetKey + 1 }));
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
