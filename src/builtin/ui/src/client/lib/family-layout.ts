/**
 * Where every card in a family tree goes.
 *
 * Pure geometry over the graph `person-graph` returns, kept out of the component
 * for the same reason `justified-layout.ts` is: a layout that cannot be asserted
 * on is a layout nobody can tell is broken. "Do two cards overlap" and "is a
 * child centred under its parents" are questions about numbers, and a screenshot
 * answers neither.
 *
 * The shape it draws is the one people expect from a family tree: generations as
 * rows, the person in the middle, ancestors above and descendants below, and a
 * couple side by side as one block their children hang from.
 *
 * Two passes, the classic ones — measure a subtree's width bottom-up, then location
 * it top-down — run twice from the person's own row: once downward through
 * children and once upward through parents. Because a parent edge always moves a
 * generation up and a child edge always moves one down, the two trees can only
 * ever meet on the row they both start from, which is what makes the whole
 * layout collision-free without a separation pass.
 */

/**
 * One person as the tree draws them. The kit's own view of a family graph, so the tree is a
 * display part any page can hand a graph to, `person-graph`'s answer among them.
 */
export type FamilyNode = {
  path: string;
  name: string;
  fullname?: string;
  gender?: string;
  born?: string;
  died?: string;
  /** Drawn parents — always a subset of `parentCount`. */
  parents: string[];
  children: string[];
  partners: FamilyPartner[];
  /** Every parent, including the ones outside the slice. */
  parentCount: number;
  childCount: number;
};

/** One partner tie. */
type FamilyPartner = { path: string; kind?: string; from?: string; to?: string };

export type FamilyGraph = { root: string; nodes: Record<string, FamilyNode> };

export const CARD_WIDTH = 188;
/** The portrait is a square this tall at the card's left edge. */
export const CARD_HEIGHT = 64;
/** Between two partners inside one couple: room for the bar and the years written over and under it. */
const COUPLE_GAP = 40;
/** Between neighbouring couples on the same row — wider than a couple's own gap, so a pair still reads as a pair. */
const UNIT_GAP = 48;
/** Vertical distance between one row's top and the next. */
const ROW_HEIGHT = CARD_HEIGHT + 72;
/**
 * How far below the parents their couple bar runs, and above the children their sibling bar: clear
 * of the expand bulges on the cards' edges, with a trunk between the two.
 */
const BAR_DROP = 24;
/** Margin around the whole drawing, so the outermost cards are not flush to the edge. */
const PADDING = 24;

type FamilyCard = {
  path: string;
  x: number;
  y: number;
  /** 0 is the person the tree is drawn for; negative is upward. */
  generation: number;
};

/**
 * The lines from one set of parents to their children on one row, drawn the way a family chart
 * draws them: a stem down from the middle of each parent's card to a couple bar between them, one
 * trunk down from the bar's middle to a sibling bar, and a drop from that into each child. A lone
 * parent has no couple bar, and their trunk starts at their own card. Drawn as one, a family's
 * lines meet at T-junctions instead of each line turning on its own and running across the others.
 */
export type FamilyLines = {
  key: string;
  /** The middle of each parent's card, left to right. */
  parents: number[];
  /** The parents' bottom edge. */
  fromY: number;
  /** Where the couple bar runs, with two parents or more. */
  coupleY?: number;
  /** Where the trunk comes down: between the parents, or under the only one. */
  trunkX: number;
  siblingY: number;
  /** The middle of each child's card, left to right. */
  children: number[];
  /** The children's top edge. */
  toY: number;
};

/** The bar joining two partners, and the years the partnership ran: `from` over it, `to` under it. */
type UnionEdge = { key: string; x1: number; x2: number; y: number; from?: string; to?: string };

type FamilyLayout = {
  cards: FamilyCard[];
  byPath: Record<string, FamilyCard>;
  families: FamilyLines[];
  unions: UnionEdge[];
  width: number;
  height: number;
};

/** A person and the partners drawn beside them — the block children hang from. */
type Unit = {
  key: string;
  members: string[];
  generation: number;
  width: number;
  /** Left edge, filled in by the placement pass. */
  x: number;
  down: Unit[];
  up: Unit[];
};

const unitWidth = (members: number): number => members * CARD_WIDTH + (members - 1) * COUPLE_GAP;

const centreOf = (unit: Unit): number => unit.x + unit.width / 2;

/**
 * Which row each person sits on.
 *
 * Breadth-first from the person the tree is about, so someone reachable by two
 * routes — cousins who married, an ancestor who is also an in-law — lands on the
 * row of the shortest one and stays there. Any other rule would need a person to
 * be in two rows at once.
 */
function generations(graph: FamilyGraph): Map<string, number> {
  const generation = new Map<string, number>([[graph.root, 0]]);
  let frontier = [graph.root];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const path of frontier) {
      const node = graph.nodes[path];
      if (!node) continue;
      const own = generation.get(path)!;

      const step = (neighbour: string, delta: number) => {
        if (!graph.nodes[neighbour] || generation.has(neighbour)) return;
        generation.set(neighbour, own + delta);
        next.push(neighbour);
      };

      for (const parent of node.parents) step(parent, -1);
      for (const child of node.children) step(child, 1);
      for (const partner of node.partners) step(partner.path, 0);
    }
    frontier = next;
  }

  // Anything the walk never reached has no relation to the person the tree is
  // about, so no row is more right than any other; it gets theirs and is parked
  // to one side later. Without this such a node has no generation at all and is
  // dropped from the drawing entirely.
  for (const path of Object.keys(graph.nodes)) {
    if (!generation.has(path)) generation.set(path, 0);
  }

  return generation;
}

/** Couples, built root-first so the person the tree is about anchors their own. */
function buildUnits(graph: FamilyGraph, generation: Map<string, number>): { units: Unit[]; unitOf: Map<string, Unit> } {
  const unitOf = new Map<string, Unit>();
  const units: Unit[] = [];

  // Root first, then the rest by path: the order decides who anchors a couple,
  // and a stable order is what makes the whole layout reproducible.
  const order = [graph.root, ...Object.keys(graph.nodes).filter((path) => path !== graph.root).sort()];

  for (const path of order) {
    if (unitOf.has(path) || !graph.nodes[path]) continue;
    const own = generation.get(path);
    if (own === undefined) continue;

    const members = [path];
    for (const partner of graph.nodes[path].partners) {
      // A partner on another row is somebody's parent or child as well, and
      // that tie is the one that decides where they are drawn.
      if (unitOf.has(partner.path) || generation.get(partner.path) !== own) continue;
      members.push(partner.path);
    }

    const unit: Unit = { key: members[0], members, generation: own, width: unitWidth(members.length), x: 0, down: [], up: [] };
    for (const member of members) unitOf.set(member, unit);
    units.push(unit);
  }

  return { units, unitOf };
}

/**
 * Turn the unit graph into two trees.
 *
 * A unit can descend from more than one drawn couple — a child of a first
 * marriage whose both households are on screen — and a tree needs exactly one
 * parent. The first one reached breadth-first wins the *placement*; the other
 * tie is still drawn, it just does not move anybody.
 *
 * Returns whatever neither walk reached, for the caller to park.
 */
function link(rootUnit: Unit, units: Unit[], unitOf: Map<string, Unit>, graph: FamilyGraph): Unit[] {
  const claimed = new Set<Unit>([rootUnit]);

  const neighbours = (unit: Unit, dir: 'down' | 'up'): Unit[] => {
    const found: Unit[] = [];
    for (const member of unit.members) {
      const node = graph.nodes[member];
      if (!node) continue;
      for (const path of dir === 'down' ? node.children : node.parents) {
        const other = unitOf.get(path);
        if (other && other !== unit && !found.includes(other)) found.push(other);
      }
    }
    return found;
  };

  for (const dir of ['down', 'up'] as const) {
    let frontier = [rootUnit];
    const seen = new Set<Unit>([rootUnit]);

    while (frontier.length > 0) {
      const next: Unit[] = [];
      for (const unit of frontier) {
        for (const other of neighbours(unit, dir)) {
          if (seen.has(other) || claimed.has(other)) continue;
          seen.add(other);
          claimed.add(other);
          unit[dir].push(other);
          next.push(other);
        }
      }
      frontier = next;
    }
  }

  // Anything the two walks never reached is returned rather than attached. It
  // cannot be hung off the root: a fragment on the root's *own* row would be
  // laid out as one of its children, and the root is centred over its children,
  // so the two would be drawn on top of each other. `person-graph` only ever
  // answers with nodes reachable from its root, so this should stay empty — it
  // is here so that a graph which somehow is not connected still draws every
  // card instead of silently losing some.
  return units.filter((unit) => !claimed.has(unit));
}

/** Subtree width: its own block, or everything below it, whichever is wider. */
function measure(unit: Unit, dir: 'down' | 'up', widths: Map<Unit, number>): number {
  const cached = widths.get(unit);
  if (cached !== undefined) return cached;

  const children = unit[dir];
  const spread = children.reduce((sum, child) => sum + measure(child, dir, widths), 0) +
    Math.max(0, children.length - 1) * UNIT_GAP;

  const width = Math.max(unit.width, spread);
  widths.set(unit, width);
  return width;
}

/**
 * Give every unit an x, working outward from the root's row.
 *
 * Both the block and the row beneath it are centred inside the subtree's box, so
 * a couple sits over the middle of their children whichever is wider.
 */
function location(unit: Unit, dir: 'down' | 'up', left: number, widths: Map<Unit, number>): void {
  const box = measure(unit, dir, widths);
  unit.x = left + (box - unit.width) / 2;

  const children = unit[dir];
  if (children.length === 0) return;

  const spread = children.reduce((sum, child) => sum + measure(child, dir, widths), 0) +
    (children.length - 1) * UNIT_GAP;

  let cursor = left + (box - spread) / 2;
  for (const child of children) {
    location(child, dir, cursor, widths);
    cursor += measure(child, dir, widths) + UNIT_GAP;
  }
}

/**
 * The union bars inside each couple, and what the relation says about them.
 *
 * A bar is drawn only where the two adjacent people really are partners. With
 * three in a block — somebody whose two partners are both on screen — the
 * outer two are each partners of the middle one and not of each other, and a bar
 * between them would assert a relationship that does not exist.
 */
function unionEdges(units: Unit[], graph: FamilyGraph, y: (generation: number) => number): UnionEdge[] {
  const edges: UnionEdge[] = [];

  for (const unit of units) {
    for (let i = 0; i + 1 < unit.members.length; i++) {
      const left = unit.members[i];
      const right = unit.members[i + 1];
      // Either direction: the pair is stored on both people, but a half-written
      // relation should still draw rather than silently vanish.
      const tie = graph.nodes[left]?.partners.find((partner) => partner.path === right) ??
        graph.nodes[right]?.partners.find((partner) => partner.path === left);
      if (!tie) continue;

      edges.push({
        key: `${left}~${right}`,
        x1: unit.x + i * (CARD_WIDTH + COUPLE_GAP) + CARD_WIDTH,
        x2: unit.x + (i + 1) * (CARD_WIDTH + COUPLE_GAP),
        y: y(unit.generation) + CARD_HEIGHT / 2,
        ...(tie.from ? { from: tie.from.slice(0, 4), ...(tie.to ? { to: tie.to.slice(0, 4) } : {}) } : {}),
      });
    }
  }

  return edges;
}

/**
 * The families' lines: the children on a row grouped by which of their parents are drawn on one
 * row above them. A child whose parents are on two different rows belongs to a family on each.
 */
function familyLines(graph: FamilyGraph, cards: Map<string, FamilyCard>): FamilyLines[] {
  const families = new Map<string, { parents: FamilyCard[]; children: FamilyCard[] }>();

  for (const card of cards.values()) {
    const node = graph.nodes[card.path];
    if (!node) continue;
    const byRow = new Map<number, FamilyCard[]>();
    for (const parent of node.parents) {
      const from = cards.get(parent);
      // A child drawn on or above its parent's row is not descent as this
      // chart reads it — it is the same tie seen from the other end, and
      // drawing it would put a line through the row between them.
      if (!from || from.generation >= card.generation) continue;
      byRow.set(from.generation, [...(byRow.get(from.generation) ?? []), from]);
    }
    for (const parents of byRow.values()) {
      parents.sort((a, b) => a.x - b.x);
      const key = `${parents.map((parent) => parent.path).join('+')}>${card.generation}`;
      const family = families.get(key);
      if (family) family.children.push(card);
      else families.set(key, { parents, children: [card] });
    }
  }

  return [...families].map(([key, { parents, children }]) => {
    const xs = parents.map((parent) => parent.x + CARD_WIDTH / 2);
    const fromY = parents[0].y + CARD_HEIGHT;
    const toY = children[0].y;
    return {
      key,
      parents: xs,
      fromY,
      ...(xs.length > 1 ? { coupleY: fromY + BAR_DROP } : {}),
      trunkX: (xs[0] + xs[xs.length - 1]) / 2,
      siblingY: toY - BAR_DROP,
      children: children.map((child) => child.x + CARD_WIDTH / 2).sort((a, b) => a - b),
      toY,
    };
  });
}

/**
 * Lay out a family graph.
 *
 * Coordinates start at 0 and the returned `width`/`height` are the drawing's
 * own, padding included — the caller sizes its canvas from them rather than
 * guessing.
 */
export function layoutFamily(graph: FamilyGraph): FamilyLayout {
  const empty: FamilyLayout = { cards: [], byPath: {}, families: [], unions: [], width: 0, height: 0 };
  if (!graph.nodes[graph.root]) return empty;

  const generation = generations(graph);
  const { units, unitOf } = buildUnits(graph, generation);
  const rootUnit = unitOf.get(graph.root);
  if (!rootUnit) return empty;

  const stranded = link(rootUnit, units, unitOf, graph);

  // Each direction is measured on its own, so a wide ancestry does not pay for
  // a wide descent; the two are then aligned on the root's own centre.
  const downWidths = new Map<Unit, number>();
  const upWidths = new Map<Unit, number>();
  location(rootUnit, 'down', 0, downWidths);
  const anchor = centreOf(rootUnit);
  location(rootUnit, 'up', anchor - measure(rootUnit, 'up', upWidths) / 2, upWidths);
  // The upward pass moved the root; the downward tree was placed against where
  // it used to be, so put it back and re-place it from the same anchor.
  const settled = centreOf(rootUnit);
  location(rootUnit, 'down', settled - measure(rootUnit, 'down', downWidths) / 2, downWidths);
  location(rootUnit, 'up', settled - measure(rootUnit, 'up', upWidths) / 2, upWidths);

  // Parked off to the right of everything placed, one column per row, so a
  // stranded fragment is visible and cannot land on top of anybody.
  if (stranded.length > 0) {
    const right = Math.max(...units.filter((unit) => !stranded.includes(unit)).map((unit) => unit.x + unit.width));
    const nextX = new Map<number, number>();
    for (const unit of stranded) {
      const x = nextX.get(unit.generation) ?? right + UNIT_GAP * 2;
      unit.x = x;
      nextX.set(unit.generation, x + unit.width + UNIT_GAP);
    }
  }

  const rows = [...new Set(units.map((unit) => unit.generation))];
  const topRow = Math.min(...rows);
  const y = (row: number) => PADDING + (row - topRow) * ROW_HEIGHT;

  // Everything so far is relative to wherever the root landed, which can be
  // negative; shifting once here is cheaper than threading an origin through
  // both passes.
  const originX = Math.min(...units.map((unit) => unit.x)) - PADDING;

  const cards = new Map<string, FamilyCard>();
  for (const unit of units) {
    unit.x -= originX;
    unit.members.forEach((path, index) => {
      cards.set(path, { path, x: unit.x + index * (CARD_WIDTH + COUPLE_GAP), y: y(unit.generation), generation: unit.generation });
    });
  }

  const width = Math.max(...units.map((unit) => unit.x + unit.width)) + PADDING;
  const height = y(Math.max(...rows)) + CARD_HEIGHT + PADDING;

  return {
    cards: [...cards.values()],
    byPath: Object.fromEntries(cards),
    families: familyLines(graph, cards),
    unions: unionEdges(units, graph, y),
    width,
    height,
  };
}
