export type SwipeDirection = "forward" | "backward";

export type GesturePoint = {
  x: number;
  y: number;
};

export const WELCOME_SWIPE_THRESHOLD = 64;

/**
 * Classifies a horizontal Welcome swipe once it clears the distance threshold.
 * A vertical or mostly-vertical drag is intentionally ignored.
 */
export function classifyHorizontalSwipe(
  start: GesturePoint,
  current: GesturePoint,
  threshold = WELCOME_SWIPE_THRESHOLD,
): SwipeDirection | null {
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  return deltaX < 0 ? "forward" : "backward";
}
