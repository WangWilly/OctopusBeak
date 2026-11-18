import type { NetWorthPoint } from "./overview-model.ts";

/** Evenly spaced round values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value < max + step * 0.999; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

/** The first point of each calendar month, used as an x-axis label. */
export function monthTicks(points: readonly NetWorthPoint[]): NetWorthPoint[] {
  const ticks: NetWorthPoint[] = [];
  let month = "";
  for (const point of points) {
    const pointMonth = point.date.slice(0, 7);
    if (pointMonth === month) continue;
    month = pointMonth;
    ticks.push(point);
  }
  return ticks;
}

/**
 * The ticks whose labels fit: walking back from the latest, a tick closer than
 * `minGap` pixels to the last one kept is skipped, so a cramped first month
 * gives way to the months after it.
 */
export function spacedTicks<T>(ticks: readonly T[], x: (tick: T) => number, minGap: number): T[] {
  const kept: T[] = [];
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const tick = ticks[index]!;
    const last = kept.at(-1);
    if (last === undefined || x(last) - x(tick) >= minGap) kept.push(tick);
  }
  return kept.reverse();
}

/** Days since the first point, so gaps between observations keep their width. */
export function dayOffset(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}
