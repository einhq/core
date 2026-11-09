import { ActionIcon, Box, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { IconFocusCentered, IconMaximize, IconMinimize, IconZoomScan } from '@tabler/icons-react';
import { memo, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CARD_HEIGHT, CARD_WIDTH, type FamilyGraph, type FamilyLines, type FamilyNode, layoutFamily } from '../../lib/family-layout.ts';
import { layoutHatField } from '../../lib/hat-field.ts';
import { type FamilyDirection, FamilyTreeCard } from './FamilyTreeCard.tsx';
import { Dialog } from '../Surface/Dialog.tsx';
import { usePanZoom } from '../../hooks/usePanZoom.ts';
import { centredOn, clampView, fitScale, fitView, MIN_FIT_SCALE, type PanZoomSize, sameView } from '../../lib/pan-zoom.ts';

/** How tall the drawing's box gets inline. Tall enough for five rows at full zoom. */
const MAX_VIEWPORT_HEIGHT = 620;
/** Short enough for one row of cards, tall enough for the controls standing in its corner. */
const MIN_VIEWPORT_HEIGHT = 180;
/** The inline box's border, which `border-box` takes out of the height it is given. */
const VIEWPORT_BORDER = 2;
const CORNER_RADIUS = 10;
/** How strongly the hat tiles behind the drawing are outlined: a texture, not a picture. */
const HAT_GROUND_OPACITY = 0.07;
/** How wide a family's lines are to the pointer, wider than they are drawn. */
const LINE_HIT_WIDTH = 12;
/** A lit family's lines and the outline of its people's cards. */
const LIT = 'var(--mantine-color-marine-4)';
/** The map's control: a filled dark button standing on the drawing. */
const CONTROL_SIZE = 40;

const DIRECTIONS: readonly FamilyDirection[] = ['up', 'down'];

type Layout = ReturnType<typeof layoutFamily>;

/** `card` in the middle of the box at `scale`. */
const centredOnCard = (card: { x: number; y: number }, scale: number, size: PanZoomSize) =>
  centredOn({ x: card.x + CARD_WIDTH / 2, y: card.y + CARD_HEIGHT / 2 }, scale, size);

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
  /**
   * Draws the inside of a person's card, in place of the portrait, the name linking to their page
   * and the relations menu: for a tree of people who are not all the archive's. The card's box,
   * place and expand bulges stay the tree's.
   */
  renderCard?: (node: FamilyNode) => ReactNode;
  /**
   * Take the parent's whole height, edge to edge, rather than a box sized to the family: for a page
   * that is the tree, its parent a flex column. Full screen is then not offered.
   */
  fill?: boolean;
  /**
   * Room at the right and the bottom the drawing keeps clear, for a panel floating over it: fitting
   * and centring use the rest, and the controls stand left of the right inset.
   */
  inset?: { right?: number; bottom?: number };
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

  if (props.fill) return <FamilyDrawing {...props} fill />;
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
 * The drawing is moved with a transform rather than scrolled, by the gestures `usePanZoom` reads:
 * dragged, pinched, zoomed with the wheel and by a double tap, never smaller than fitting. A tap
 * on a card's name or buttons stays theirs.
 */
function FamilyDrawing(
  {
    graph,
    loading,
    expanded,
    expanding,
    onExpand,
    onCollapse,
    onAddRelation,
    onRemoveRelation,
    editable = true,
    emptyMessage,
    fit = false,
    renderCard,
    fill,
    inset,
    onScreen,
  }: FamilyDrawingProps,
) {
  const layout = useMemo(() => (graph ? layoutFamily(graph) : null), [graph]);
  const root = graph?.root;

  /** The family whose lines the pointer is on, or a finger last tapped. */
  const [lit, setLit] = useState<string | null>(null);
  // useId's colons are not valid in a selector.
  const scope = `mrx-family-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const insetRight = inset?.right ?? 0;
  const insetBottom = inset?.bottom ?? 0;

  const panZoom = usePanZoom({
    content: layout && layout.cards.length > 0 ? layout : null,
    // Zoomed out as far as fitting and no further: smaller than that is empty box.
    minScale: (box) => layout ? fitScale(layout, box) : MIN_FIT_SCALE,
    inset,
    onPress: (target) => {
      if (!(target instanceof Element && target.closest('[data-family]'))) setLit(null);
    },
  });
  const { size, view, fitted, dragging, setView, animateTo } = panZoom;

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

    if (placedFor.current !== root || !panZoom.current()) {
      placedFor.current = root;
      // A family that fits at full size is shown whole, wherever its person is in it.
      if (fit || !rootCard || fitScale(layout, size) >= 1) setView(fitView(layout, size), fit);
      else setView(clampView(centredOnCard(rootCard, 1, size), layout, size));
      return;
    }
    // A fitted drawing fits again, except round an expand: the card the reader
    // pressed stays under their finger, and the view is theirs from then on.
    if (panZoom.isFitted() && !(anchor && previous !== layout)) {
      setView(fitView(layout, size), true);
      return;
    }
    let next = panZoom.current()!;
    const kept = anchor ?? root;
    const before = previous?.byPath[kept];
    const after = layout.byPath[kept];
    if (previous !== layout && before && after) {
      next = { ...next, x: next.x + (before.x - after.x) * next.scale, y: next.y + (before.y - after.y) * next.scale };
    }
    setView(clampView({ ...next, scale: Math.max(next.scale, fitScale(layout, size)) }, layout, size));
  }, [layout, root, size, fit]);

  // The drawing itself depends on the graph and not on the view, so dragging
  // re-renders only the transform round it; a lit family is drawn on its own
  // between the lines and the cards, so lighting one re-renders neither.
  const lines = useMemo(() => {
    if (!layout) return null;
    return (
      <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden='true'>
        {/* One group's opacity, so where a family's lines meet they are no darker than one. */}
        <g opacity={0.55}>
          {layout.families.map((family) => (
            <path key={family.key} d={familyPath(family)} fill='none' stroke='var(--mantine-color-dimmed)' strokeWidth={1.5} strokeLinecap='round' />
          ))}
        </g>
        {
          /* A wider, unseen stroke along each family's lines, so a pointer finds
            one without having to land on a pixel and a half. */
        }
        <g fill='none' stroke='transparent' strokeWidth={LINE_HIT_WIDTH} style={{ pointerEvents: 'stroke', cursor: 'pointer' }}>
          {layout.families.map((family) => (
            <path
              key={family.key}
              data-family={family.key}
              d={familyPath(family)}
              onPointerEnter={(event) => event.pointerType === 'mouse' && setLit(family.key)}
              onPointerLeave={(event) => event.pointerType === 'mouse' && setLit((current) => (current === family.key ? null : current))}
              onClick={() => setLit(family.key)}
            />
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
    );
  }, [layout]);

  const drawing = useMemo(() => {
    if (!graph || !layout) return null;
    return (
      <>
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
              content={renderCard?.(node)}
            />
          );
        })}
      </>
    );
  }, [graph, layout, expanded, expanding, editable, onExpand, onCollapse, onAddRelation, onRemoveRelation, renderCard]);

  if (loading && !layout) {
    return <PageLoader label='Loading family tree…' />;
  }

  if (!layout || layout.cards.length === 0 || !graph) {
    return <Text c='dimmed' size='sm'>{emptyMessage ?? 'No family recorded yet.'}</Text>;
  }

  // Inline, a small family is a small box: reserving five rows of height for
  // two rows of cards is a box of empty space under them. Sized from the scale
  // the drawing starts at, not the current one, so zooming never moves the page.
  const startScale = fit ? fitScale(layout, { width: size.width, height: MAX_VIEWPORT_HEIGHT }) : 1;
  const inlineHeight = Math.max(MIN_VIEWPORT_HEIGHT, Math.min(MAX_VIEWPORT_HEIGHT, layout.height * startScale)) + VIEWPORT_BORDER;
  const rootCard = layout.byPath[graph.root];
  const litFamily = lit ? layout.families.find((family) => family.key === lit) : undefined;

  return (
    <Box style={fill ? { flex: 1, minHeight: 0, position: 'relative' } : { position: 'relative' }}>
      <Box
        ref={panZoom.ref}
        id={scope}
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
        <HatGround width={size.width + insetRight} height={size.height + insetBottom} seed={`family:${graph.root}`} />
        {litFamily && (
          <style>
            {`${litFamily.people.map((path) => `#${scope} [data-person="${CSS.escape(path)}"]`).join(', ')} { outline: 2px solid ${LIT}; outline-offset: 1px; }`}
          </style>
        )}
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
          {lines}
          {litFamily && (
            <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden='true'>
              <path d={familyPath(litFamily)} fill='none' stroke={LIT} strokeWidth={2.5} strokeLinecap='round' />
            </svg>
          )}
          {drawing}
        </Box>
      </Box>

      {
        /* The controls stand on the drawing in its corner, as a map's do, and
          outside the box's own listeners so pressing one never starts a drag. */
      }
      <Stack gap={8} style={{ position: 'absolute', top: 8, right: 8 + insetRight, zIndex: 2 }}>
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
              onClick={() => animateTo(clampView(centredOnCard(rootCard, view?.scale ?? 1, size), layout, size))}
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
