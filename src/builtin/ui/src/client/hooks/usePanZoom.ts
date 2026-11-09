import { useEffect, useRef, useState } from 'react';
import { clampView, fitView, MIN_FIT_SCALE, type PanZoomSize, type PanZoomView, toDrawing, zoomedAbout } from '../lib/pan-zoom.ts';

const MAX_SCALE = 2;
/**
 * Scale change per pixel of wheel. A mouse notch is about 100px, so a notch is
 * a fifth; a trackpad pinch arrives as Ctrl+wheel in small deltas and so zooms
 * smoothly.
 */
const WHEEL_ZOOM_PER_PIXEL = 0.002;
/** Line-mode wheels (Firefox with some mice) report lines, about 16px each. */
const WHEEL_LINE_PIXELS = 16;
/** How far a pointer moves before a press is a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 24;
/** What a double tap multiplies the scale by, or divides it by with Shift. */
const DOUBLE_TAP_ZOOM = 2;
const ZOOM_ANIMATION_MS = 220;

export type PanZoomOptions = {
  /** The drawing's size; null while there is none to move. */
  content: PanZoomSize | null;
  /** The least scale for a box this size: the fitted scale, for a drawing that never shrinks past fitting. */
  minScale?: (box: PanZoomSize) => number;
  maxScale?: number;
  /** Room on the box's right and bottom kept out of the drawing's, for what stands there. */
  inset?: { right?: number; bottom?: number };
  /** A press that starts on such an element is the element's own: a node dragged, a port wired. The drawing does not move. */
  ignore?: (target: Element) => boolean;
  /** Each press on the box, before it is anything else. */
  onPress?: (target: EventTarget | null) => void;
};

/**
 * A drawing in a box it is dragged and zoomed in, as a map is: one finger or the mouse drags it,
 * two fingers pinch it, and the wheel zooms it about the cursor. A double click or tap on the
 * ground zooms in about that point, with Shift out, and at full zoom back to the whole drawing. A
 * press that moves less than `DRAG_THRESHOLD` is a click, so what is on the drawing still works; one
 * that moves further swallows the click that ends it.
 *
 * The box is `ref`'s element; give it `touch-action: none` and `overflow: hidden`, and move the
 * drawing with `translate(x, y) scale(scale)` about its top-left corner. The listeners are native
 * rather than React's: the wheel's must not be passive, and React's events would also arrive from a
 * menu portalled outside the box. So they run before an element's own React handlers, and `ignore`
 * is how such an element keeps a press to itself.
 */
export const usePanZoom = ({ content, minScale, maxScale = MAX_SCALE, inset, ignore, onPress }: PanZoomOptions) => {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  /** The room the drawing is placed in: the box without the inset. */
  const [size, setSize] = useState<PanZoomSize>({ width: 0, height: 0 });
  const [view, setViewState] = useState<PanZoomView | null>(null);
  const [fitted, setFitted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const insetRight = inset?.right ?? 0;
  const insetBottom = inset?.bottom ?? 0;

  // The gesture listeners are attached once per box, so they read through refs.
  const viewRef = useRef(view);
  const contentRef = useRef(content);
  contentRef.current = content;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fittedRef = useRef(fitted);
  fittedRef.current = fitted;
  const options = useRef({ minScale, maxScale, ignore, onPress });
  options.current = { minScale, maxScale, ignore, onPress };

  const setView = (next: PanZoomView, isFit = false) => {
    viewRef.current = next;
    fittedRef.current = isFit;
    setViewState(next);
    setFitted(isFit);
  };

  /** No smaller than `minScale` says and no larger than `maxScale`. */
  const scaleWithin = (scale: number): number => {
    const min = options.current.minScale?.(sizeRef.current) ?? MIN_FIT_SCALE;
    return Math.min(options.current.maxScale, Math.max(min, scale));
  };

  const animation = useRef<number | null>(null);
  const stopAnimation = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
  };

  /**
   * Glide to `to`. Between two scales the point both views put at the same place on screen stays
   * there throughout and the scale changes evenly in proportion, so a zoom about a point looks like
   * one, not like a slide and a zoom at once.
   */
  const animateTo = (to: PanZoomView, isFit = false) => {
    stopAnimation();
    const from = viewRef.current;
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setView(to, isFit);
      return;
    }
    const zooms = Math.abs(from.scale - to.scale) > 1e-6;
    const fixedX = zooms ? from.x + from.scale * (to.x - from.x) / (from.scale - to.scale) : 0;
    const fixedY = zooms ? from.y + from.scale * (to.y - from.y) / (from.scale - to.scale) : 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / ZOOM_ANIMATION_MS);
      if (t === 1) {
        animation.current = null;
        setView(to, isFit);
        return;
      }
      const e = 1 - (1 - t) ** 3;
      if (zooms) {
        const scale = from.scale * (to.scale / from.scale) ** e;
        setView({ scale, x: fixedX - (fixedX - from.x) * scale / from.scale, y: fixedY - (fixedY - from.y) * scale / from.scale });
      } else {
        setView({ scale: from.scale, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      }
      animation.current = requestAnimationFrame(frame);
    };
    animation.current = requestAnimationFrame(frame);
  };

  /** A view moved to, kept on the drawing. */
  const moveTo = (next: PanZoomView) => {
    const drawing = contentRef.current;
    if (drawing) setView(clampView(next, drawing, sizeRef.current));
  };

  /** A double tap at box point (`px`, `py`): in about it, with `out` out, and from full zoom back to the whole drawing. */
  const zoomByTap = (px: number, py: number, out: boolean) => {
    const current = viewRef.current;
    const drawing = contentRef.current;
    if (!current || !drawing) return;
    const box = sizeRef.current;
    const whole = fitView(drawing, box);
    const scale = out ? current.scale / DOUBLE_TAP_ZOOM : current.scale * DOUBLE_TAP_ZOOM;
    if ((out && scale <= whole.scale) || (!out && current.scale >= options.current.maxScale - 1e-6)) {
      animateTo(whole, true);
      return;
    }
    animateTo(clampView(zoomedAbout(current, scaleWithin(scale), px, py), drawing, box));
  };

  useEffect(() => {
    if (!viewport) return;
    const measure = () => setSize({ width: Math.max(0, viewport.clientWidth - insetRight), height: Math.max(0, viewport.clientHeight - insetBottom) });
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    measure();
    return () => observer.disconnect();
  }, [viewport, insetRight, insetBottom]);

  const hasContent = content !== null;
  useEffect(() => {
    if (!viewport || !hasContent) return;

    /** A pointer's position in the box. */
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left - viewport.clientLeft, y: event.clientY - rect.top - viewport.clientTop };
    };

    const pointers = new Map<number, { x: number; y: number }>();
    /** The view and the pointers' positions when the current gesture, or its latest change of fingers, began. */
    let gesture: { view: PanZoomView; points: { x: number; y: number }[] } | null = null;
    let moved = false;
    /** The most pointers down at once in the current gesture: a tap is one finger's. */
    let most = 0;
    let lastTap: { time: number; x: number; y: number } | null = null;

    const restart = () => {
      const current = viewRef.current;
      gesture = current && pointers.size > 0 ? { view: current, points: [...pointers.values()] } : null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      options.current.onPress?.(event.target);
      if (event.target instanceof Element && options.current.ignore?.(event.target)) return;
      stopAnimation();
      if (pointers.size === 0) {
        moved = false;
        most = 0;
      }
      pointers.set(event.pointerId, local(event));
      most = Math.max(most, pointers.size);
      restart();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, local(event));
      if (!gesture) return;
      const now = [...pointers.values()];
      const start = gesture.view;

      if (now.length === 1) {
        const dx = now[0].x - gesture.points[0].x;
        const dy = now[0].y - gesture.points[0].y;
        if (!moved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          moved = true;
          setDragging(true);
          viewport.setPointerCapture(event.pointerId);
        }
        moveTo({ ...start, x: start.x + dx, y: start.y + dy });
        return;
      }

      // Two fingers: the drawing's point under their midpoint follows the
      // midpoint, and the scale follows their spread.
      const [a0, b0] = gesture.points;
      const [a, b] = now;
      const spread0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
      if (spread0 === 0) return;
      moved = true;
      const scale = scaleWithin(start.scale * Math.hypot(b.x - a.x, b.y - a.y) / spread0);
      const px = ((a0.x + b0.x) / 2 - start.x) / start.scale;
      const py = ((a0.y + b0.y) / 2 - start.y) / start.scale;
      moveTo({ scale, x: (a.x + b.x) / 2 - px * scale, y: (a.y + b.y) / 2 - py * scale });
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      // A finger lifted from a pinch: the one left carries on dragging from here.
      restart();
      if (pointers.size > 0) return;
      setDragging(false);
      // The click a drag ends with comes before any timer; after it, a click is a click again.
      if (moved) setTimeout(() => (moved = false));

      // A tap on a link or a button is that control's, not the drawing's.
      const onControl = event.target instanceof Element && event.target.closest('a, button, input, [role="button"]');
      if (event.type !== 'pointerup' || moved || most !== 1 || onControl) {
        lastTap = null;
        return;
      }
      const tap = { time: event.timeStamp, ...local(event) };
      if (lastTap && tap.time - lastTap.time < DOUBLE_TAP_MS && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < DOUBLE_TAP_DISTANCE) {
        lastTap = null;
        zoomByTap(tap.x, tap.y, event.shiftKey);
        return;
      }
      lastTap = tap;
    };

    // Capturing, so the click that ends a drag never reaches what it began on.
    const onClick = (event: MouseEvent) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stopAnimation();
      const current = viewRef.current;
      if (!current) return;
      const pixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS : 1);
      const scale = scaleWithin(current.scale * Math.exp(-pixels * WHEEL_ZOOM_PER_PIXEL));
      if (scale === current.scale) return;
      const point = local(event);
      moveTo(zoomedAbout(current, scale, point.x, point.y));
    };

    // A picture or a name is a link the browser would otherwise drag away as a URL.
    const onDragStart = (event: DragEvent) => event.preventDefault();
    // Safari's own pinch, which would zoom the page rather than the drawing.
    const onGesture = (event: Event) => event.preventDefault();

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerEnd);
    viewport.addEventListener('pointercancel', onPointerEnd);
    viewport.addEventListener('click', onClick, true);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('dragstart', onDragStart);
    viewport.addEventListener('gesturestart', onGesture);
    return () => {
      stopAnimation();
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerEnd);
      viewport.removeEventListener('pointercancel', onPointerEnd);
      viewport.removeEventListener('click', onClick, true);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('dragstart', onDragStart);
      viewport.removeEventListener('gesturestart', onGesture);
    };
  }, [viewport, hasContent]);

  return {
    /** The box: give it to the element the drawing is moved in. */
    ref: setViewport,
    viewport,
    /** The room the drawing is placed in. */
    size,
    /** Null until the drawing is first placed. */
    view,
    fitted,
    dragging,
    /** The view now, read where a render's `view` may be behind it, as in a layout effect. */
    current: () => viewRef.current,
    isFitted: () => fittedRef.current,
    setView,
    animateTo,
    moveTo,
    /** The drawing's point under a pointer at (`clientX`, `clientY`). */
    toDrawing: (clientX: number, clientY: number): { x: number; y: number } | null => {
      const current = viewRef.current;
      if (!current || !viewport) return null;
      const rect = viewport.getBoundingClientRect();
      return toDrawing(current, clientX - rect.left - viewport.clientLeft, clientY - rect.top - viewport.clientTop);
    },
  };
};
