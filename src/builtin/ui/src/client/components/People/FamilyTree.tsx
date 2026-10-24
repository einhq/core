import { ActionIcon, Box, Group, Loader, Text, Tooltip } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { useElementSize } from '@mantine/hooks';
import { IconArrowsMaximize, IconFocusCentered, IconZoomIn, IconZoomOut, IconZoomScan } from '@tabler/icons-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CARD_HEIGHT, CARD_WIDTH, type DescentEdge, type FamilyGraph, layoutFamily } from '../../lib/family-layout.ts';
import { FamilyTreeCard } from './FamilyTreeCard.tsx';
import { Dialog } from '../Surface/Dialog.tsx';

/** How tall the drawing's viewport gets inline. Tall enough for five rows at full zoom. */
const MAX_VIEWPORT_HEIGHT = 620;
const MAX_SCALE = 1.5;
/** Below this a fitted drawing is unreadable, so it stops shrinking and scrolls instead. */
const MIN_FIT_SCALE = 0.2;
const ZOOM_FACTOR = 1.25;
/**
 * Scale change per pixel of Ctrl+wheel. A mouse notch is about 100px, so a
 * notch is close to one button press; a trackpad pinch arrives as Ctrl+wheel
 * in small deltas and so zooms smoothly.
 */
const WHEEL_ZOOM_PER_PIXEL = 0.002;
/** Line-mode wheels (Firefox with some mice) report lines, about 16px each. */
const WHEEL_LINE_PIXELS = 16;
/** The viewport's border, which `border-box` takes out of the height it is given. */
const VIEWPORT_BORDER = 2;
const CORNER_RADIUS = 10;

/** Fitting to the box, or a fixed scale the reader zoomed to. */
type Zoom = 'fit' | number;

/**
 * A descent line as an SVG path: down out of the parents, across the gap, down
 * into the child.
 *
 * Right angles, softened at the two turns, and the horizontal run shared by
 * every sibling at the same `busY` — which is what makes a set of siblings read
 * as one family rather than as unrelated lines converging. The radius shrinks
 * to fit a short run, and a child straight below its parents gets no turns.
 */
const descentPath = ({ fromX, fromY, toX, toY, busY }: DescentEdge): string => {
  const dx = toX - fromX;
  const r = Math.min(CORNER_RADIUS, Math.abs(dx) / 2, busY - fromY, toY - busY);
  if (r < 0.5) return `M ${fromX} ${fromY} V ${busY} H ${toX} V ${toY}`;
  const sx = Math.sign(dx);
  return `M ${fromX} ${fromY} V ${busY - r} Q ${fromX} ${busY} ${fromX + sx * r} ${busY} H ${toX - sx * r} Q ${toX} ${busY} ${toX} ${busY + r} V ${toY}`;
};

export type FamilyTreeProps = {
  graph: FamilyGraph | null;
  loading: boolean;
  expanded: ReadonlySet<string>;
  expanding: string | null;
  onExpand: (path: string) => void;
  /** Relation edits are an administrator action on a person's detail page. */
  editable?: boolean;
  onAddRelation: (path: string, kind: 'parent' | 'partner' | 'child') => void;
  onRemoveRelation: (path: string) => void;
  emptyMessage?: string;
  /** Start zoomed so the whole family fits the box, instead of at full size centred on the person. */
  fit?: boolean;
  /** Offer a button that opens the tree full screen. */
  expandable?: boolean;
};

/**
 * The family, drawn — inline, and when `expandable`, full screen on request.
 *
 * The full-screen view is a second drawing of the same graph in a dialog rather
 * than the inline one moved there: each keeps its own zoom, and closing the
 * dialog leaves the inline tree exactly as the reader left it.
 */
export function FamilyTree({ expandable = false, ...props }: FamilyTreeProps) {
  const [screen, setScreen] = useState(false);
  const rootName = props.graph ? props.graph.nodes[props.graph.root]?.name : undefined;

  return (
    <>
      <FamilyDrawing
        {...props}
        fill={false}
        toolbarEnd={expandable && (
          <Tooltip label='Full screen'>
            <ActionIcon variant='default' size='sm' onClick={() => setScreen(true)} aria-label='Show the family tree full screen'>
              <IconArrowsMaximize size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      />
      {expandable && (
        <Dialog
          opened={screen}
          onClose={() => setScreen(false)}
          fullScreen
          title={rootName ? `Family of ${rootName}` : 'Family'}
          icon='sitemap'
          pattern='person'
        >
          <FamilyDrawing {...props} fit fill />
        </Dialog>
      )}
    </>
  );
}

type FamilyDrawingProps = Omit<FamilyTreeProps, 'expandable'> & {
  /** Take the parent's whole height and fit both ways, rather than growing to the drawing's own height. */
  fill: boolean;
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
};

/**
 * One drawing of the family.
 *
 * Geometry comes from `layoutFamily`, which is pure and tested; this places the
 * cards it was given and draws the lines between them. The connectors are one
 * `<svg>` behind the cards rather than borders on them, because a line from a
 * couple to a child crosses the gap between two rows and belongs to neither.
 *
 * It scrolls in its own box instead of on the page: zoomed in, the drawing is
 * wider than the column at almost any real family size, and a page that
 * scrolls sideways would take the rest of the person's page with it. Fitted,
 * it is scaled to the box's width and height so nothing needs scrolling — down
 * to `MIN_FIT_SCALE`, past which it would be too small to read.
 *
 * The controls sit in a row above the box rather than over it: fitted, the
 * drawing reaches the box's corners, and a button floating there would sit on
 * a card.
 */
function FamilyDrawing(
  { graph, loading, expanded, expanding, onExpand, onAddRelation, onRemoveRelation, editable = true, emptyMessage, fit = false, fill, toolbarStart, toolbarEnd }:
    FamilyDrawingProps,
) {
  const [zoom, setZoom] = useState<Zoom>(fit ? 'fit' : 1);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastZoom = useRef<Zoom>(zoom);
  const { ref: frameRef, width: frameWidth, height: frameHeight } = useElementSize();

  const layout = useMemo(() => (graph ? layoutFamily(graph) : null), [graph]);
  const rootCard = graph && layout ? layout.byPath[graph.root] : undefined;

  const measured = frameWidth > 0 && (!fill || frameHeight > 0);
  const fitScale = useMemo(() => {
    if (!layout || !measured) return 1;
    const width = frameWidth - VIEWPORT_BORDER;
    const height = (fill ? frameHeight : MAX_VIEWPORT_HEIGHT) - VIEWPORT_BORDER;
    return Math.max(MIN_FIT_SCALE, Math.min(1, width / layout.width, height / layout.height));
  }, [layout, measured, frameWidth, frameHeight, fill]);
  const scale = zoom === 'fit' ? fitScale : zoom;

  const drawingRef = useRef<HTMLDivElement | null>(null);
  // The wheel listener is attached once, so it reads the scale through refs.
  const scaleRef = useRef(scale);
  const fitScaleRef = useRef(fitScale);
  scaleRef.current = scale;
  fitScaleRef.current = fitScale;
  /** The drawing point under the cursor when a wheel zoom began, and where on screen it must stay. */
  const wheelAnchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  /** The scale wheel events have asked for but a render has not yet drawn. */
  const wheelTarget = useRef<number | null>(null);

  const zoomIn = () => setZoom(Math.min(MAX_SCALE, scale * ZOOM_FACTOR));
  // Out as far as fitting and no further: smaller than that is empty box.
  const zoomOut = () => {
    const next = scale / ZOOM_FACTOR;
    setZoom(next <= fitScale ? 'fit' : next);
  };

  const centreOnRoot = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !rootCard) return;
    viewport.scrollTo({
      left: (rootCard.x + CARD_WIDTH / 2) * scale - viewport.clientWidth / 2,
      top: (rootCard.y + CARD_HEIGHT / 2) * scale - viewport.clientHeight / 2,
      behavior: 'instant',
    });
  }, [rootCard, scale]);

  // Ctrl+wheel zooms about the cursor, as a map does. Native and non-passive,
  // because React's `onWheel` is passive and cannot stop the browser zooming
  // the whole page instead.
  const hasDrawing = Boolean(layout && layout.cards.length > 0);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const drawing = drawingRef.current;
      if (!drawing) return;
      const fit = fitScaleRef.current;
      const current = wheelTarget.current ?? scaleRef.current;
      const pixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS : 1);
      const next = Math.min(MAX_SCALE, Math.max(fit, current * Math.exp(-pixels * WHEEL_ZOOM_PER_PIXEL)));
      if (next === current) return;
      // Several events can land before a render; the first one's anchor holds
      // for all of them, measured against the scale actually drawn.
      if (!wheelAnchor.current) {
        const rect = drawing.getBoundingClientRect();
        wheelAnchor.current = {
          x: (event.clientX - rect.left) / scaleRef.current,
          y: (event.clientY - rect.top) / scaleRef.current,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      }
      wheelTarget.current = next;
      const zoomTo: Zoom = next <= fit ? 'fit' : next;
      // Already accounted for, so the centring below leaves the view alone.
      lastZoom.current = zoomTo;
      setZoom(zoomTo);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [hasDrawing]);

  // Before paint, scroll so the anchored point is back under the cursor.
  useLayoutEffect(() => {
    const anchor = wheelAnchor.current;
    wheelAnchor.current = null;
    wheelTarget.current = null;
    const viewport = viewportRef.current;
    const drawing = drawingRef.current;
    if (!anchor || !viewport || !drawing) return;
    const rect = drawing.getBoundingClientRect();
    viewport.scrollLeft += rect.left + anchor.x * scale - anchor.clientX;
    viewport.scrollTop += rect.top + anchor.y * scale - anchor.clientY;
  }, [scale]);

  // On the first drawing of a person, and on a zoom change: at any real family
  // size the person the tree is about is not where the scroll box happens to
  // start. Deliberately *not* on every graph change — expanding a
  // great-grandparent must leave the reader looking at what they just opened,
  // not snap them back to the middle.
  const centred = useRef<string | null>(null);
  useEffect(() => {
    if (!graph) return;
    if (centred.current === graph.root && zoom === lastZoom.current) return;
    centred.current = graph.root;
    lastZoom.current = zoom;
    centreOnRoot();
  }, [graph, zoom, centreOnRoot]);

  if (loading && !layout) {
    return <PageLoader label='Loading family tree…' />;
  }

  if (!layout || layout.cards.length === 0) {
    return <Text c='dimmed' size='sm'>{emptyMessage ?? 'No family recorded yet.'}</Text>;
  }

  return (
    <Box style={fill ? { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } : undefined}>
      <Group gap={4} mb={fill ? 'sm' : 4} wrap='nowrap'>
        <Box style={{ flex: 1, minWidth: 0 }}>{toolbarStart}</Box>
        {loading && <Loader size='xs' mr={4} />}
        {zoom !== 'fit' && (
          <Tooltip label='Centre on this person'>
            <ActionIcon variant='default' size='sm' onClick={centreOnRoot} aria-label='Centre on this person'>
              <IconFocusCentered size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label='Fit the whole family'>
          <ActionIcon variant='default' size='sm' disabled={zoom === 'fit'} onClick={() => setZoom('fit')} aria-label='Fit the whole family'>
            <IconZoomScan size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label='Zoom out (Ctrl + scroll)'>
          <ActionIcon variant='default' size='sm' disabled={scale <= fitScale} onClick={zoomOut} aria-label='Zoom out'>
            <IconZoomOut size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label='Zoom in (Ctrl + scroll)'>
          <ActionIcon variant='default' size='sm' disabled={scale >= MAX_SCALE} onClick={zoomIn} aria-label='Zoom in'>
            <IconZoomIn size={14} />
          </ActionIcon>
        </Tooltip>
        {toolbarEnd}
      </Group>

      {
        /* The frame is what gets measured: the viewport's own size follows the
          scale, so measuring it would chase its own tail. */
      }
      <Box ref={frameRef} style={fill ? { flex: 1, minHeight: 0, position: 'relative' } : undefined}>
        <Box
          ref={viewportRef}
          style={{
            // A small family is a small drawing; reserving three rows of height
            // for two rows of cards is a box of empty space under them.
            height: fill ? '100%' : Math.min(MAX_VIEWPORT_HEIGHT, layout.height * scale + VIEWPORT_BORDER),
            ...(fill && { position: 'absolute', inset: 0 }),
            overflow: 'auto',
            display: 'flex',
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-md)',
            background: 'var(--mrx-surface-base)',
            // One frame at full size before the box is measured would be a
            // flash of a huge tree, then a jump.
            visibility: zoom === 'fit' && !measured ? 'hidden' : undefined,
          }}
        >
          {
            /* Scaling the drawing rather than the box: the wrapper carries the
              scaled size so the scrollbars still describe what is inside it,
              which a bare `transform` on the content would not. */
          }
          {
            /* `margin: auto` on a flex item centres a drawing smaller than the
              box both ways and does nothing to a larger one — auto margins only
              ever take free space, never go negative — so a wide drawing
              overflows to the end and its start stays in reach, which
              `justify-content: center` would not allow. */
          }
          <Box ref={drawingRef} style={{ flex: 'none', width: layout.width * scale, height: layout.height * scale, position: 'relative', margin: 'auto' }}>
            <Box style={{ width: layout.width, height: layout.height, position: 'relative', transformOrigin: 'top left', transform: `scale(${scale})` }}>
              <svg
                width={layout.width}
                height={layout.height}
                style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                aria-hidden='true'
              >
                {layout.descent.map((edge) => (
                  <path
                    key={edge.key}
                    d={descentPath(edge)}
                    fill='none'
                    stroke='var(--mantine-color-dimmed)'
                    strokeWidth={1.5}
                    strokeLinecap='round'
                    opacity={0.55}
                  />
                ))}
                {layout.unions.map((union) => (
                  <g key={union.key}>
                    <line x1={union.x1} y1={union.y} x2={union.x2} y2={union.y} stroke='var(--mantine-color-dimmed)' strokeWidth={2} />
                    {
                      /* The years the partnership ran, where there are any; imported
                        relations carry none (ein/core#66). */
                    }
                    {union.label && (
                      <text x={(union.x1 + union.x2) / 2} y={union.y - 6} textAnchor='middle' fontSize={9} fill='var(--mantine-color-dimmed)'>
                        {union.label}
                      </text>
                    )}
                  </g>
                ))}
              </svg>

              {layout.cards.map((card) => {
                const node = graph!.nodes[card.path];
                if (!node) return null;
                // What the graph knows exists minus what is on screen. Expanding
                // a card once answers both directions, so it stops offering.
                const hidden = expanded.has(card.path)
                  ? { parents: 0, children: 0 }
                  : { parents: node.parentCount - node.parents.length, children: node.childCount - node.children.length };

                return (
                  <FamilyTreeCard
                    key={card.path}
                    node={node}
                    x={card.x}
                    y={card.y}
                    isRoot={card.path === graph!.root}
                    moreParents={hidden.parents}
                    moreChildren={hidden.children}
                    busy={expanding === card.path}
                    onExpand={() => onExpand(card.path)}
                    editable={editable}
                    onAddRelation={(kind) => onAddRelation(card.path, kind)}
                    onRemoveRelation={() => onRemoveRelation(card.path)}
                  />
                );
              })}
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
