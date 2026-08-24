import assert from "node:assert/strict";
import {
  mapViewerPointer,
  shouldDispatchViewerClickBeforeType,
  viewerOverlayAnchorForRect,
} from "./viewer-coordinate.ts";

function closeTo(actual: number, expected: number, epsilon = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function scaledRect(
  layout: { left: number; top: number; width: number; height: number },
  scale: number,
  origin: { x: number; y: number },
) {
  return {
    left: layout.left + origin.x * (1 - scale),
    top: layout.top + origin.y * (1 - scale),
    width: layout.width * scale,
    height: layout.height * scale,
  };
}

const natural = { width: 1366, height: 768 };
const layout = {
  left: 44.5,
  top: 137.8485,
  width: 867.483 / 1.15,
  height: 384,
};
const origin = { x: 358.961, y: 232.25 };

assert.equal(shouldDispatchViewerClickBeforeType(["click"]), true);
assert.equal(shouldDispatchViewerClickBeforeType(["type"]), false);
assert.equal(shouldDispatchViewerClickBeforeType(["click", "type"]), false);

{
  const imageRect = scaledRect(layout, 1, { x: 0, y: 0 });
  const point = mapViewerPointer({
    clientX: imageRect.left + (imageRect.width * 650) / natural.width,
    clientY: imageRect.top + (imageRect.height * 464) / natural.height,
    imageRect,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    layoutWidth: layout.width,
    layoutHeight: layout.height,
  });
  assert.ok(point);
  closeTo(point.x, 650);
  closeTo(point.y, 464);
  closeTo(point.left, (layout.width * 650) / natural.width);
  closeTo(point.top, (layout.height * 464) / natural.height);
}

{
  // This mirrors the live SinoPac viewer: a zoomed focus with a non-centre
  // origin extends beyond a clipped frame in both directions.
  const imageRect = scaledRect(layout, 1.15, origin);
  const visibleTarget = {
    x: imageRect.left + (imageRect.width * 650) / natural.width,
    y: imageRect.top + (imageRect.height * 464) / natural.height,
  };
  const point = mapViewerPointer({
    clientX: visibleTarget.x,
    clientY: visibleTarget.y,
    imageRect,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    layoutWidth: layout.width,
    layoutHeight: layout.height,
  });
  assert.ok(point);
  closeTo(point.x, 650);
  closeTo(point.y, 464);
  closeTo(point.left, (layout.width * 650) / natural.width);
  closeTo(point.top, (layout.height * 464) / natural.height);
}

{
  // A clipped viewport must not be used as the image's origin. The target is
  // inside the visible frame even though the transformed image starts above
  // and to the left of it.
  const clippedFrame = {
    left: 43.5,
    top: 136.849,
    width: 756.333,
    height: 359.484,
  };
  const imageRect = scaledRect(layout, 1.15, origin);
  const target = {
    x: imageRect.left + (imageRect.width * 650) / natural.width,
    y: imageRect.top + (imageRect.height * 464) / natural.height,
  };
  assert.ok(
    target.x >= clippedFrame.left &&
      target.x <= clippedFrame.left + clippedFrame.width,
  );
  assert.ok(
    target.y >= clippedFrame.top &&
      target.y <= clippedFrame.top + clippedFrame.height,
  );
  const point = mapViewerPointer({
    clientX: target.x,
    clientY: target.y,
    imageRect,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    layoutWidth: layout.width,
    layoutHeight: layout.height,
  });
  assert.ok(point);
  closeTo(point.x, 650);
  closeTo(point.y, 464);
}

{
  // Keyboard activation uses the transformed image centre and must still map
  // to the natural screenshot centre and the untransformed anchor centre.
  const imageRect = scaledRect(layout, 1.15, origin);
  const point = mapViewerPointer({
    clientX: imageRect.left + imageRect.width / 2,
    clientY: imageRect.top + imageRect.height / 2,
    imageRect,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    layoutWidth: layout.width,
    layoutHeight: layout.height,
  });
  assert.ok(point);
  closeTo(point.x, natural.width / 2);
  closeTo(point.y, natural.height / 2);
  closeTo(point.left, layout.width / 2);
  closeTo(point.top, layout.height / 2);
}

{
  // The assistance response returns this natural CAPTCHA input rect. The
  // overlay anchor must share its transformed rendered centre, rather than
  // using the pointer's left edge as the form's left edge.
  const targetRect = { x: 589.03125, y: 447, width: 122, height: 35 };
  const imageRect = scaledRect(layout, 1.15, origin);
  const anchor = viewerOverlayAnchorForRect({
    targetRect,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    layoutWidth: layout.width,
    layoutHeight: layout.height,
    frameWidth: layout.width,
    frameHeight: layout.height,
    overlayWidth: 288,
    overlayHeight: 44,
  });
  assert.ok(anchor);
  const renderedAnchorCenter = {
    x: imageRect.left + anchor.left * 1.15,
    y: imageRect.top + anchor.top * 1.15,
  };
  const renderedTargetCenter = {
    x:
      imageRect.left +
      imageRect.width * ((targetRect.x + targetRect.width / 2) / natural.width),
    y:
      imageRect.top +
      imageRect.height *
        ((targetRect.y + targetRect.height / 2) / natural.height),
  };
  closeTo(renderedAnchorCenter.x, renderedTargetCenter.x);
  closeTo(renderedAnchorCenter.y, renderedTargetCenter.y);
  closeTo(
    anchor.left,
    (layout.width * (targetRect.x + targetRect.width / 2)) / natural.width,
  );
  closeTo(
    anchor.top,
    (layout.height * (targetRect.y + targetRect.height / 2)) / natural.height,
  );
}

{
  // Near an edge the centered form is clamped inside the untransformed
  // viewer-focus bounds instead of being clipped out of the assistance view.
  const anchor = viewerOverlayAnchorForRect({
    targetRect: { x: 0, y: 0, width: 8, height: 8 },
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    layoutWidth: layout.width,
    layoutHeight: layout.height,
    frameWidth: layout.width,
    frameHeight: layout.height,
    overlayWidth: 288,
    overlayHeight: 44,
  });
  assert.ok(anchor);
  assert.equal(anchor.left, 156);
  assert.equal(anchor.top, 34);
}

assert.equal(
  mapViewerPointer({
    clientX: 1,
    clientY: 1,
    imageRect: { left: 0, top: 0, width: 0, height: 1 },
    naturalWidth: 1,
    naturalHeight: 1,
    layoutWidth: 1,
    layoutHeight: 1,
  }),
  null,
);
