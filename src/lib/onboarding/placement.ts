type Rect = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };
type Position = {
  left: number;
  top: number;
  width: number;
  height: number;
  compact: boolean;
  side: "right" | "left" | "below" | "above" | "bottom-right";
};

const MARGIN = 24;
const GAP = 18;
const COMPACT_COACH = { width: 360, height: 58 };
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function placeOnboardingCoach(
  target: Rect,
  coach: Size,
  viewport: Size,
  obstacles: Rect[] = [],
): Position | null {
  const obstaclePasses = obstacles.length
    ? [[target, ...obstacles], [target]]
    : [[target]];
  for (const blockedRects of obstaclePasses) {
    for (const [size, compact] of [[coach, false], [COMPACT_COACH, true]] as const) {
      if (
        size.width > viewport.width - MARGIN * 2
        || size.height > viewport.height - MARGIN * 2
      ) continue;

      const centeredTop = clamp(
        target.top + target.height / 2 - size.height / 2,
        MARGIN,
        viewport.height - size.height - MARGIN,
      );
      const centeredLeft = clamp(
        target.left + target.width / 2 - size.width / 2,
        MARGIN,
        viewport.width - size.width - MARGIN,
      );
      const candidates = [
        { side: "right" as const, left: target.left + target.width + GAP, top: centeredTop },
        { side: "left" as const, left: target.left - size.width - GAP, top: centeredTop },
        { side: "below" as const, left: centeredLeft, top: target.top + target.height + GAP },
        { side: "above" as const, left: centeredLeft, top: target.top - size.height - GAP },
        {
          side: "bottom-right" as const,
          left: viewport.width - size.width - MARGIN,
          top: viewport.height - size.height - MARGIN,
        },
      ];
      const position = candidates.find(({ left, top }) =>
        left >= MARGIN
        && top >= MARGIN
        && left + size.width <= viewport.width - MARGIN
        && top + size.height <= viewport.height - MARGIN
        && !blockedRects.some((rect) =>
          left + size.width > rect.left
          && left < rect.left + rect.width
          && top + size.height > rect.top
          && top < rect.top + rect.height)
      );
      if (position) return { ...position, ...size, compact };
    }
  }
  return null;
}
