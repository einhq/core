/**
 * The view of a drawing in a box it is dragged and zoomed in, as a map is: its scale, and where its
 * top-left corner sits in the box. Pure, so the gestures that move it (`usePanZoom`) and what
 * places it (fitting, centring) share one tested set of sums.
 */

export type PanZoomView = { scale: number; x: number; y: number };
export type PanZoomSize = { width: number; height: number };

/** Below this a fitted drawing is unreadable, so it stops shrinking and is dragged instead. */
export const MIN_FIT_SCALE = 0.2;

/** The scale the whole drawing fits the box at, no larger than full size and no smaller than `min`. */
export const fitScale = (content: PanZoomSize, box: PanZoomSize, min = MIN_FIT_SCALE): number =>
  Math.max(min, Math.min(1, box.width / content.width, box.height / content.height));

/** The whole drawing, as large as fits, in the middle of the box. */
export const fitView = (content: PanZoomSize, box: PanZoomSize, min = MIN_FIT_SCALE): PanZoomView => {
  const scale = fitScale(content, box, min);
  return { scale, x: (box.width - content.width * scale) / 2, y: (box.height - content.height * scale) / 2 };
};

/** The drawing's point (`x`, `y`) in the middle of the box at `scale`. */
export const centredOn = (point: { x: number; y: number }, scale: number, box: PanZoomSize): PanZoomView => ({
  scale,
  x: box.width / 2 - point.x * scale,
  y: box.height / 2 - point.y * scale,
});

/** The middle of the box stays on the drawing, so it cannot be dragged out of sight. */
export const clampView = (view: PanZoomView, content: PanZoomSize, box: PanZoomSize): PanZoomView => ({
  scale: view.scale,
  x: Math.min(box.width / 2, Math.max(box.width / 2 - content.width * view.scale, view.x)),
  y: Math.min(box.height / 2, Math.max(box.height / 2 - content.height * view.scale, view.y)),
});

export const sameView = (a: PanZoomView, b: PanZoomView): boolean => Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/** `view` at `scale`, with the drawing's point under box point (`px`, `py`) still under it. */
export const zoomedAbout = (view: PanZoomView, scale: number, px: number, py: number): PanZoomView => ({
  scale,
  x: px - (px - view.x) * scale / view.scale,
  y: py - (py - view.y) * scale / view.scale,
});

/** The drawing's point under box point (`px`, `py`). */
export const toDrawing = (view: PanZoomView, px: number, py: number): { x: number; y: number } => ({
  x: (px - view.x) / view.scale,
  y: (py - view.y) / view.scale,
});
