export type TreemapRect = { x: number; y: number; width: number; height: number };

type Box = TreemapRect;

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). Values must be positive and
 * sorted largest first; rects come back in the same order, in the units of
 * `width` and `height`, tiling the box exactly.
 */
export function squarify(values: readonly number[], width: number, height: number): TreemapRect[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length === 0 || total <= 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const areas = values.map((value) => value * scale);
  const rects: TreemapRect[] = [];
  let box: Box = { x: 0, y: 0, width, height };
  let row: number[] = [];
  for (const area of areas) {
    const side = Math.min(box.width, box.height);
    if (row.length === 0 || worst([...row, area], side) <= worst(row, side)) {
      row.push(area);
      continue;
    }
    box = placeRow(row, box, rects);
    row = [area];
  }
  placeRow(row, box, rects);
  return rects;
}

function worst(row: readonly number[], side: number): number {
  const sum = row.reduce((total, area) => total + area, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

function placeRow(row: readonly number[], box: Box, rects: TreemapRect[]): Box {
  const sum = row.reduce((total, area) => total + area, 0);
  if (box.width >= box.height) {
    const columnWidth = sum / box.height;
    let y = box.y;
    for (const area of row) {
      const height = area / columnWidth;
      rects.push({ x: box.x, y, width: columnWidth, height });
      y += height;
    }
    return { x: box.x + columnWidth, y: box.y, width: box.width - columnWidth, height: box.height };
  }
  const rowHeight = sum / box.width;
  let x = box.x;
  for (const area of row) {
    const width = area / rowHeight;
    rects.push({ x, y: box.y, width, height: rowHeight });
    x += width;
  }
  return { x: box.x, y: box.y + rowHeight, width: box.width, height: box.height - rowHeight };
}
