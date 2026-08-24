export interface ViewerCoordinateRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewerPointerMapping {
  clientX: number;
  clientY: number;
  imageRect: ViewerCoordinateRect;
  naturalWidth: number;
  naturalHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  layoutLeft?: number;
  layoutTop?: number;
  frameWidth?: number;
  frameHeight?: number;
}

export interface ViewerNaturalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewerOverlayAnchorMapping {
  targetRect: ViewerNaturalRect;
  naturalWidth: number;
  naturalHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  layoutLeft?: number;
  layoutTop?: number;
  frameWidth?: number;
  frameHeight?: number;
  overlayWidth: number;
  overlayHeight: number;
  margin?: number;
}

export interface MappedViewerPoint {
  x: number;
  y: number;
  left: number;
  top: number;
  frameWidth: number;
  frameHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  layoutLeft: number;
  layoutTop: number;
}

export function shouldDispatchViewerClickBeforeType(modes: readonly string[]) {
  return modes.includes("click") && !modes.includes("type");
}

/**
 * Maps a pointer from the screenshot's transformed viewport back to the
 * screenshot's natural coordinate system. `imageRect` must be the current
 * transformed DOMRect (getBoundingClientRect), while layout dimensions and
 * offsets describe the untransformed viewer-focus coordinate system used by
 * floating controls.
 */
export function mapViewerPointer({
  clientX,
  clientY,
  imageRect,
  naturalWidth,
  naturalHeight,
  layoutWidth,
  layoutHeight,
  layoutLeft = 0,
  layoutTop = 0,
  frameWidth = layoutWidth,
  frameHeight = layoutHeight,
}: ViewerPointerMapping): MappedViewerPoint | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(imageRect.left) ||
    !Number.isFinite(imageRect.top) ||
    !Number.isFinite(imageRect.width) ||
    !Number.isFinite(imageRect.height) ||
    imageRect.width <= 0 ||
    imageRect.height <= 0 ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    !Number.isFinite(layoutWidth) ||
    !Number.isFinite(layoutHeight) ||
    layoutWidth <= 0 ||
    layoutHeight <= 0 ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    !Number.isFinite(layoutLeft) ||
    !Number.isFinite(layoutTop)
  )
    return null;

  const xRatio = (clientX - imageRect.left) / imageRect.width;
  const yRatio = (clientY - imageRect.top) / imageRect.height;
  return {
    x: xRatio * naturalWidth,
    y: yRatio * naturalHeight,
    left: layoutLeft + xRatio * layoutWidth,
    top: layoutTop + yRatio * layoutHeight,
    frameWidth,
    frameHeight,
    naturalWidth,
    naturalHeight,
    layoutWidth,
    layoutHeight,
    layoutLeft,
    layoutTop,
  };
}

function centeredOverlayCoordinate(
  center: number,
  frameSize: number,
  overlaySize: number,
  margin: number,
) {
  const safeOverlaySize = Math.min(
    overlaySize,
    Math.max(0, frameSize - margin * 2),
  );
  const halfOverlay = safeOverlaySize / 2;
  const min = margin + halfOverlay;
  const max = frameSize - margin - halfOverlay;
  return Math.min(Math.max(center, min), max);
}

/**
 * Positions a floating editor at the inspected target's centre in the
 * untransformed viewer-focus coordinate system. The CSS editor is centred at
 * this point, so the anchor remains aligned after the focus is transformed.
 */
export function viewerOverlayAnchorForRect({
  targetRect,
  naturalWidth,
  naturalHeight,
  layoutWidth,
  layoutHeight,
  layoutLeft = 0,
  layoutTop = 0,
  frameWidth = layoutWidth,
  frameHeight = layoutHeight,
  overlayWidth,
  overlayHeight,
  margin = 12,
}: ViewerOverlayAnchorMapping) {
  if (
    !Number.isFinite(targetRect.x) ||
    !Number.isFinite(targetRect.y) ||
    !Number.isFinite(targetRect.width) ||
    !Number.isFinite(targetRect.height) ||
    targetRect.width <= 0 ||
    targetRect.height <= 0 ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    !Number.isFinite(layoutWidth) ||
    !Number.isFinite(layoutHeight) ||
    layoutWidth <= 0 ||
    layoutHeight <= 0 ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    !Number.isFinite(overlayWidth) ||
    !Number.isFinite(overlayHeight) ||
    overlayWidth <= 0 ||
    overlayHeight <= 0 ||
    !Number.isFinite(layoutLeft) ||
    !Number.isFinite(layoutTop) ||
    !Number.isFinite(margin) ||
    margin < 0
  )
    return null;

  const targetCenterX =
    layoutLeft +
    ((targetRect.x + targetRect.width / 2) / naturalWidth) * layoutWidth;
  const targetCenterY =
    layoutTop +
    ((targetRect.y + targetRect.height / 2) / naturalHeight) * layoutHeight;
  return {
    left: centeredOverlayCoordinate(
      targetCenterX,
      frameWidth,
      overlayWidth,
      margin,
    ),
    top: centeredOverlayCoordinate(
      targetCenterY,
      frameHeight,
      overlayHeight,
      margin,
    ),
  };
}
