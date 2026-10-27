import { ActionIcon, Box, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconFocusCentered, IconMaximize, IconMinimize, IconZoomScan } from '@tabler/icons-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CARD_HEIGHT, CARD_WIDTH, type FamilyGraph, type FamilyLines, layoutFamily } from '../../lib/family-layout.ts';
import { layoutHatField } from '../../lib/hat-field.ts';
import { type FamilyDirection, FamilyTreeCard } from './FamilyTreeCard.tsx';
import { Dialog } from '../Surface/Dialog.tsx';

/** How tall the drawing's box gets inline. Tall enough for five rows at full zoom. */
const MAX_VIEWPORT_HEIGHT = 620;
/** Short enough for one row of cards, tall enough for the controls standing in its corner. */
const MIN_VIEWPORT_HEIGHT = 180;
const MAX_SCALE = 2;
/** Below this a fitted drawing is unreadable, so it stops shrinking and is dragged instead. */
const MIN_FIT_SCALE = 0.2;
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
/** The inline box's border, which `border-box` takes out of the height it is given. */
const VIEWPORT_BORDER = 2;
const CORNER_RADIUS = 10;
/** How strongly the hat tiles behind the drawing are outlined: a texture, not a picture. */
const HAT_GROUND_OPACITY = 0.07;
/** The map's control: a filled dark button standing on the drawing. */
const CONTROL_SIZE = 40;

const DIRECTIONS: readonly FamilyDirection[] = ['up', 'down'];

/** The drawing's scale, and where its top-left corner sits in the box. */
type View = { scale: number; x: number; y: number };
type Size = { width: number; height: number };
type Layout = ReturnType<typeof layoutFamily>;

const fitScaleFor = (layout: Layout, size: Size): number => Math.max(MIN_FIT_SCALE, Math.min(1, size.width / layout.width, size.height / layout.height));

/** The whole drawing, as large as fits, in the middle of the box. */
const fitView = (layout: Layout, size: Size): View => {
  const scale = fitScaleFor(layout, size);
  return { scale, x: (size.width - layout.width * scale) / 2, y: (size.height - layout.height * scale) / 2 };
};

/** `card` in the middle of the box at `scale`. */
const centredOn = (card: { x: number; y: number }, scale: number, size: Size): View => ({
  scale,
  x: size.width / 2 - (card.x + CARD_WIDTH / 2) * scale,
  y: size.height / 2 - (card.y + CARD_HEIGHT / 2) * scale,
});

/** The middle of the box stays on the drawing, so it cannot be dragged out of sight. */
const clampView = (view: View, layout: Layout, size: Size): View => ({
  scale: view.scale,
  x: Math.min(size.width / 2, Math.max(size.width / 2 - layout.width * view.scale, view.x)),
  y: Math.min(size.height / 2, Math.max(size.height / 2 - layout.height * view.scale, view.y)),
});

const sameView = (a: View, b: View): boolean => Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/** `view` at `scale`, with the drawing's point under box point (`px`, `py`) still under it. */
const zoomedAbout = (view: View, scale: number, px: number, py: number): View => ({
  scale,
  x: px - (px - view.x) * scale / view.scale,
  y: py - (py - view.y) * scale / view.scale,
});

/** A bar's tooth: a vertical line from the bar at `y` to `end`, above it or below it. */
type Tooth = { x: number; end: number };

/**
 * A horizontal bar at `y` with its teeth, as one SVG path.
 *
 * A tooth at either end of the bar turns into it round a corner; every other one meets it at a
 * plain T, so no two curves ever cross. An end with teeth both above and below is a line straight
 * through, and the bar meets it at a T as well. Teeth at one x (and a bar of no length) are straight
 * lines through `y`.
 */
const barPath = (y: number, teeth: Tooth[]): string => {
  const left = Math.min(...teeth.map((tooth) => tooth.x));
  const right = Math.max(...teeth.map((tooth) => tooth.x));
  const at = (x: number) => teeth.filter((tooth) => Math.abs(tooth.x - x) < 0.5);
  const turns = (x: number) => right - left >= 1 && at(x).length === 1;
  const radius = (tooth: Tooth) => Math.min(CORNER_RADIUS, (right - left) / 2, Math.abs(tooth.end - y));

  const parts: string[] = [];
  for (const tooth of teeth) {
    const end = Math.abs(tooth.x - left) < 0.5 ? left : Math.abs(tooth.x - right) < 0.5 ? right : null;
    if (end === null || !turns(end)) {
      parts.push(`M ${tooth.x} ${tooth.end} V ${y}`);
      continue;
    }
    const r = radius(tooth);
    const dy = Math.sign(tooth.end - y);
    const dx = end === left ? 1 : -1;
    parts.push(`M ${tooth.x} ${tooth.end} V ${y + dy * r} Q ${tooth.x} ${y} ${tooth.x + dx * r} ${y}`);
  }
  const from = turns(left) ? left + radius(at(left)[0]) : left;
  const to = turns(right) ? right - radius(at(right)[0]) : right;
  if (to > from) parts.push(`M ${from} ${y} H ${to}`);
  return parts.join(' ');
};

/**
 * A family's lines as one SVG path: the parents' stems into the couple bar, the trunk from its
 * middle down to the sibling bar, and the drops into the children. The trunk is a tooth of both
 * bars, so either bar turns into it where it is the bar's end.
 */
const familyPath = ({ parents, fromY, coupleY, trunkX, siblingY, children, toY }: FamilyLines): string => {
  const trunkTop = coupleY ?? fromY;
  return [
    coupleY !== undefined ? barPath(coupleY, [...parents.map((x) => ({ x, end: fromY })), { x: trunkX, end: siblingY }]) : '',
    barPath(siblingY, [{ x: trunkX, end: trunkTop }, ...children.map((x) => ({ x, end: toY }))]),
  ].join(' ');
};

/**
 * The ground behind the drawing: the hat tiling the page headers are cut from, outlined only and
 * barely, so the box reads as a surface without the tiles competing with the cards. It stays put
 * while the drawing is dragged over it, so it is laid out once per box size, not once per frame.
 */
const HatGround = memo(function HatGround({ width, height, seed }: { width: number; height: number; seed: string }) {
  const tiles = useMemo(() => (width > 0 && height > 0 ? layoutHatField(width, height, seed, 'backdrop').tiles : []), [width, height, seed]);
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden='true'>
      <g fill='none' stroke='var(--mantine-color-text)' strokeWidth={1} opacity={HAT_GROUND_OPACITY}>
        {tiles.map((tile, index) => <path key={index} d={tile.d} />)}
      </g>
    </svg>
  );
});

export type FamilyTreeProps = {
  graph: FamilyGraph | null;
  loading: boolean;
  /** The cards each direction was expanded from: those stop offering to expand that way. */
  expanded: Readonly<Record<FamilyDirection, ReadonlySet<string>>>;
  /** The card and direction being fetched, so its bulge can say so. */
  expanding: { path: string; direction: FamilyDirection } | null;
  /** Pull in the generation above (`up`) or below (`down`) a card. */
  onExpand: (path: string, direction: FamilyDirection) => void;
  /** Given, a card expanded one way offers to fold those relatives away again, and this does it. */
  onCollapse?: (path: string, direction: FamilyDirection) => void;
  /** Relation edits are an administrator action on a person's detail page. */
  editable?: boolean;
  onAddRelation: (path: string, kind: 'parent' | 'partner' | 'child') => void;
  onRemoveRelation: (path: string) => void;
  emptyMessage?: string;
  /** Start zoomed so the whole family fits the box, instead of at full size centred on the person. */
  fit?: boolean;
};

/**
 * The family, drawn — inline, and full screen on request.
 *
 * The full-screen view is a second drawing of the same graph in a dialog rather
 * than the inline one moved there: each keeps its own view, and closing the
 * dialog leaves the inline tree exactly as the reader left it.
 */
export function FamilyTree(props: FamilyTreeProps) {
  const [screen, setScreen] = useState(false);
  const rootName = props.graph ? props.graph.nodes[props.graph.root]?.name : undefined;

  return (
    <>
      <FamilyDrawing {...props} fill={false} onScreen={() => setScreen(true)} />
      <Dialog
        opened={screen}
        onClose={() => setScreen(false)}
        fullScreen
        bleed
        title={rootName ? `Family of ${rootName}` : 'Family'}
        icon='sitemap'
        pattern='person'
      >
        <FamilyDrawing {...props} fit fill onScreen={() => setScreen(false)} />
      </Dialog>
    </>
  );
}

type FamilyDrawingProps = FamilyTreeProps & {
  /** Take the parent's whole height, edge to edge, rather than a box sized to the drawing. */
  fill: boolean;
  /** Given, a button in the corner calls it: into full screen inline, out of it when `fill`. */
  onScreen?: () => void;
};

/**
 * One drawing of the family, in a box it is dragged and zoomed in, as a map is.
 *
 * Geometry comes from `layoutFamily`, which is pure and tested; this places the
 * cards it was given and draws the lines between them. The connectors are one
 * `<svg>` behind the cards rather than borders on them, because a line from a
 * parent to a child crosses the gap between two rows and belongs to neither.
 *
 * The drawing is moved with a transform rather than scrolled: one finger or the
 * mouse drags it, two fingers pinch it, and the wheel zooms it about the
 * cursor. A double click or tap on the ground zooms in about that point, with
 * Shift out, and at full zoom back to the whole family, as on a map; on a card
 * it stays the card's. A press that moves less than `DRAG_THRESHOLD` is a click, so a card's
 * name and buttons still work; one that moves further swallows the click that
 * ends it. The listeners are native rather than React's: the wheel's must not
 * be passive, and React's events would also arrive from a card's menu, which is
 * portalled outside the box.
 */
function FamilyDrawing(
  { graph, loading, expanded, expanding, onExpand, onCollapse, onAddRelation, onRemoveRelation, editable = true, emptyMessage, fit = false, fill, onScreen }:
    FamilyDrawingProps,
) {
  const layout = useMemo(() => (graph ? layoutFamily(graph) : null), [graph]);
  const root = graph?.root;

  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [view, setViewState] = useState<View | null>(null);
  const [fitted, setFitted] = useState(fit);
  const [dragging, setDragging] = useState(false);

  // The gesture listeners are attached once per box, so they read through refs.
  const viewRef = useRef(view);
  const layoutRef = useRef(layout);
  const sizeRef = useRef(size);
  layoutRef.current = layout;
  sizeRef.current = size;
  const fittedRef = useRef(fitted);
  fittedRef.current = fitted;

  const setView = (next: View, isFit = false) => {
    viewRef.current = next;
    setViewState(next);
    setFitted(isFit);
  };

  /** Zoomed out as far as fitting and no further: smaller than that is empty box. */
  const scaleWithin = (scale: number): number => {
    const current = layoutRef.current;
    const min = current ? fitScaleFor(current, sizeRef.current) : MIN_FIT_SCALE;
    return Math.min(MAX_SCALE, Math.max(min, scale));
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
  const animateTo = (to: View, isFit = false) => {
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

  /** A double tap at box point (`px`, `py`): in about it, with `out` out, and from full zoom back to the whole family. */
  const zoomByTap = (px: number, py: number, out: boolean) => {
    const current = viewRef.current;
    const drawing = layoutRef.current;
    if (!current || !drawing) return;
    const size = sizeRef.current;
    const whole = fitView(drawing, size);
    const scale = out ? current.scale / DOUBLE_TAP_ZOOM : current.scale * DOUBLE_TAP_ZOOM;
    if ((out && scale <= whole.scale) || (!out && current.scale >= MAX_SCALE - 1e-6)) {
      animateTo(whole, true);
      return;
    }
    animateTo(clampView(zoomedAbout(current, scaleWithin(scale), px, py), drawing, size));
  };

  /** A view the reader moved to, kept on the drawing. */
  const moveTo = (next: View) => {
    const current = layoutRef.current;
    if (current) setView(clampView(next, current, sizeRef.current));
  };

  useEffect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => setSize({ width: viewport.clientWidth, height: viewport.clientHeight }));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  /** The card whose expand was asked for last, which stays put while the drawing grows round it. */
  const anchorPath = useRef<string | null>(null);
  const placedFor = useRef<string | null>(null);
  const placedLayout = useRef<Layout | null>(null);

  // Before paint: a new person is shown fitted or centred on them; a resized
  // fitted drawing fits again; and a drawing that grew keeps the card the
  // reader expanded where it was on screen, rather than letting the new
  // origin throw it somewhere else, while the rest is laid out afresh round it.
  useLayoutEffect(() => {
    if (!layout || !root || size.width === 0 || size.height === 0 || layout.cards.length === 0) return;
    const previous = placedLayout.current;
    placedLayout.current = layout;
    const rootCard = layout.byPath[root];

    const anchor = anchorPath.current;
    anchorPath.current = null;

    if (placedFor.current !== root || !viewRef.current) {
      placedFor.current = root;
      // A family that fits at full size is shown whole, wherever its person is in it.
      if (fit || !rootCard || fitScaleFor(layout, size) >= 1) setView(fitView(layout, size), fit);
      else setView(clampView(centredOn(rootCard, 1, size), layout, size));
      return;
    }
    // A fitted drawing fits again, except round an expand: the card the reader
    // pressed stays under their finger, and the view is theirs from then on.
    if (fittedRef.current && !(anchor && previous !== layout)) {
      setView(fitView(layout, size), true);
      return;
    }
    let next = viewRef.current;
    const kept = anchor ?? root;
    const before = previous?.byPath[kept];
    const after = layout.byPath[kept];
    if (previous !== layout && before && after) {
      next = { ...next, x: next.x + (before.x - after.x) * next.scale, y: next.y + (before.y - after.y) * next.scale };
    }
    setView(clampView({ ...next, scale: Math.max(next.scale, fitScaleFor(layout, size)) }, layout, size));
  }, [layout, root, size, fit]);

  const hasDrawing = Boolean(layout && layout.cards.length > 0);
  useEffect(() => {
    if (!viewport || !hasDrawing) return;

    /** A pointer's position in the box. */
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left - viewport.clientLeft, y: event.clientY - rect.top - viewport.clientTop };
    };

    const pointers = new Map<number, { x: number; y: number }>();
    /** The view and the pointers' positions when the current gesture, or its latest change of fingers, began. */
    let gesture: { view: View; points: { x: number; y: number }[] } | null = null;
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

      // A tap on a card's name or button is that control's, not the drawing's.
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

    // Capturing, so the click that ends a drag never reaches the card it began on.
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

    // A portrait or a name is a link the browser would otherwise drag away as a URL.
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
  }, [viewport, hasDrawing]);

  // The drawing itself depends on the graph and not on the view, so dragging
  // re-renders only the transform round it.
  const drawing = useMemo(() => {
    if (!graph || !layout) return null;
    return (
      <>
        <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden='true'>
          {/* One group's opacity, so where a family's lines meet they are no darker than one. */}
          <g opacity={0.55}>
            {layout.families.map((family) => (
              <path key={family.key} d={familyPath(family)} fill='none' stroke='var(--mantine-color-dimmed)' strokeWidth={1.5} strokeLinecap='round' />
            ))}
          </g>
          {layout.unions.map((union) => {
            const middle = (union.x1 + union.x2) / 2;
            return (
              <g key={union.key}>
                <line x1={union.x1} y1={union.y} x2={union.x2} y2={union.y} stroke='var(--mantine-color-dimmed)' strokeWidth={2} />
                {
                  /* The years the partnership ran, where there are any; imported
                    relations carry none (ein/core#66). */
                }
                {union.from && <text x={middle} y={union.y - 5} textAnchor='middle' fontSize={10} fill='var(--mantine-color-dimmed)'>{union.from}</text>}
                {union.to && <text x={middle} y={union.y + 13} textAnchor='middle' fontSize={10} fill='var(--mantine-color-dimmed)'>{union.to}</text>}
              </g>
            );
          })}
        </svg>

        {layout.cards.map((card) => {
          const node = graph.nodes[card.path];
          if (!node) {
            return null;
          }
          // What the graph knows exists minus what is on screen. Once a
          // direction is expanded it offers to fold back instead, even if a
          // relation there could not be read.
          const parents = expanded.up.has(card.path) ? 0 : node.parentCount - node.parents.length;
          const children = expanded.down.has(card.path) ? 0 : node.childCount - node.children.length;

          return (
            <FamilyTreeCard
              key={card.path}
              node={node}
              x={card.x}
              y={card.y}
              isRoot={card.path === graph.root}
              moreParents={parents}
              moreChildren={children}
              expanding={expanding?.path === card.path ? expanding.direction : null}
              onExpand={(direction) => {
                anchorPath.current = card.path;
                onExpand(card.path, direction);
              }}
              collapsible={DIRECTIONS.filter((direction) => expanded[direction].has(card.path))}
              onCollapse={onCollapse && ((direction) => {
                anchorPath.current = card.path;
                onCollapse(card.path, direction);
              })}
              editable={editable}
              onAddRelation={(kind) => onAddRelation(card.path, kind)}
              onRemoveRelation={() => onRemoveRelation(card.path)}
            />
          );
        })}
      </>
    );
  }, [graph, layout, expanded, expanding, editable, onExpand, onCollapse, onAddRelation, onRemoveRelation]);

  if (loading && !layout) {
    return <PageLoader label='Loading family tree…' />;
  }

  if (!layout || layout.cards.length === 0 || !graph) {
    return <Text c='dimmed' size='sm'>{emptyMessage ?? 'No family recorded yet.'}</Text>;
  }

  // Inline, a small family is a small box: reserving five rows of height for
  // two rows of cards is a box of empty space under them. Sized from the scale
  // the drawing starts at, not the current one, so zooming never moves the page.
  const startScale = fit ? fitScaleFor(layout, { width: size.width, height: MAX_VIEWPORT_HEIGHT }) : 1;
  const inlineHeight = Math.max(MIN_VIEWPORT_HEIGHT, Math.min(MAX_VIEWPORT_HEIGHT, layout.height * startScale)) + VIEWPORT_BORDER;
  const rootCard = layout.byPath[graph.root];

  return (
    <Box style={fill ? { flex: 1, minHeight: 0, position: 'relative' } : { position: 'relative' }}>
      <Box
        ref={setViewport}
        style={{
          height: fill ? undefined : inlineHeight,
          ...(fill ? { position: 'absolute', inset: 0 } : {
            position: 'relative',
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-md)',
          }),
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
          background: 'var(--mrx-surface-base)',
        }}
      >
        <HatGround width={size.width} height={size.height} seed={`family:${graph.root}`} />
        {
          /* Hidden until the box is measured and the view placed: one frame at
            full size first would be a flash of a huge tree, then a jump. */
        }
        <Box
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: layout.width,
            height: layout.height,
            transformOrigin: '0 0',
            transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
            visibility: view ? undefined : 'hidden',
          }}
        >
          {drawing}
        </Box>
      </Box>

      {
        /* The controls stand on the drawing in its corner, as a map's do, and
          outside the box's own listeners so pressing one never starts a drag. */
      }
      <Stack gap={8} style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}>
        {onScreen && (
          <Tooltip label={fill ? 'Leave full screen' : 'Full screen'} position='left'>
            <ActionIcon variant='filled' color='dark' size={CONTROL_SIZE} onClick={onScreen} aria-label={fill ? 'Leave full screen' : 'Show the family tree full screen'}>
              {fill ? <IconMinimize size={20} /> : <IconMaximize size={20} />}
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label='Fit the whole family' position='left'>
          <ActionIcon
            variant='filled'
            color='dark'
            size={CONTROL_SIZE}
            disabled={fitted || (view !== null && sameView(view, fitView(layout, size)))}
            onClick={() => animateTo(fitView(layout, size), true)}
            aria-label='Fit the whole family'
          >
            <IconZoomScan size={20} />
          </ActionIcon>
        </Tooltip>
        {rootCard && !fitted && (
          <Tooltip label='Centre on this person' position='left'>
            <ActionIcon
              variant='filled'
              color='dark'
              size={CONTROL_SIZE}
              onClick={() => animateTo(clampView(centredOn(rootCard, view?.scale ?? 1, size), layout, size))}
              aria-label='Centre on this person'
            >
              <IconFocusCentered size={20} />
            </ActionIcon>
          </Tooltip>
        )}
        {loading && <Loader size='sm' style={{ alignSelf: 'center' }} />}
      </Stack>
    </Box>
  );
}
