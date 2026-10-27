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
 * It is a layered drawing, laid out whole every time the graph changes, so
 * whatever was expanded — ancestors, their other children, cousins — takes its
 * place among the rest instead of being hung beside it. Rows are generations;
 * each row's couples are put in the order that crosses the fewest lines
 * (`orderRows`), and then given the x that best centres every couple over their
 * children and every child under their parents without two touching
 * (`placeRows`).
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

/** Rounds of reordering a drawing's rows before it settles for the order with the fewest crossings. */
const ORDER_ROUNDS = 24;
/** Most rounds of placing the rows, and the largest move in pixels at which a round counts as settled. */
const PLACE_ROUNDS = 400;
const SETTLED = 0.01;
/** How strongly a couple with no ties on the rows next to it stays where it is. */
const LOOSE = 0.001;

/** A person and the partners drawn beside them — the block children hang from. */
type Unit = {
  key: string;
  members: string[];
  generation: number;
  width: number;
  /** Left edge, filled in by the placement. */
  x: number;
  /** The units one row up holding a member's parent, and one row down holding a member's child. */
  parents: Unit[];
  children: Unit[];
};

const unitWidth = (members: number): number => members * CARD_WIDTH + (members - 1) * COUPLE_GAP;

/** How far right of its unit's left edge a member's card's middle is. */
const memberOffset = (unit: Unit, path: string): number => unit.members.indexOf(path) * (CARD_WIDTH + COUPLE_GAP) + CARD_WIDTH / 2;

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
  // about, so no row is more right than any other; it gets theirs, at the end
  // of it. Without this such a node has no generation at all and is
  // dropped from the drawing entirely.
  for (const path of Object.keys(graph.nodes)) {
    if (!generation.has(path)) generation.set(path, 0);
  }

  return generation;
}

/**
 * Couples, built root-first so the person the tree is about anchors their own. Somebody with two
 * partners or more on their row stands between them, so a bar can join them to each.
 */
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

    const partners: string[] = [];
    for (const partner of graph.nodes[path].partners) {
      // A partner on another row is somebody's parent or child as well, and
      // that tie is the one that decides where they are drawn.
      if (unitOf.has(partner.path) || generation.get(partner.path) !== own || partners.includes(partner.path)) continue;
      partners.push(partner.path);
    }
    const half = Math.floor(partners.length / 2);
    const members = [...partners.slice(0, half), path, ...partners.slice(half)];

    const unit: Unit = { key: path, members, generation: own, width: unitWidth(members.length), x: 0, parents: [], children: [] };
    for (const member of members) unitOf.set(member, unit);
    units.push(unit);
  }

  return { units, unitOf };
}

/** Ties between units: a member's parent one row up. A parent on any other row is not drawn as descent. */
function connect(units: Unit[], unitOf: Map<string, Unit>, graph: FamilyGraph): void {
  for (const unit of units) {
    for (const member of unit.members) {
      for (const parent of graph.nodes[member]?.parents ?? []) {
        const above = unitOf.get(parent);
        if (!above || above.generation !== unit.generation - 1 || unit.parents.includes(above)) continue;
        unit.parents.push(above);
        above.children.push(unit);
      }
    }
  }
}

/**
 * The units of each row in drawing order, top row first.
 *
 * A first order comes depth-first from the person the tree is about, which keeps every family's
 * children together and in the order they were born. The classic barycentre sweeps then move each
 * unit, down the rows and up again, towards the middle of the units it is tied to on the row
 * before, and the order with the fewest crossing ties wins. A unit with no ties that way keeps
 * its place, and those with equal pulls keep their order, so siblings stay in birth order.
 */
function orderRows(rootUnit: Unit, units: Unit[], graph: FamilyGraph): Unit[][] {
  // The member somebody is the child in is the one whose birth orders the unit among its siblings.
  const born = (unit: Unit): string => {
    const child = unit.members.find((member) => (graph.nodes[member]?.parents.length ?? 0) > 0) ?? unit.members[0];
    return graph.nodes[child]?.born ?? '\uffff';
  };
  const byBirth = (a: Unit, b: Unit) => born(a).localeCompare(born(b)) || a.key.localeCompare(b.key);

  const byRow = new Map<number, Unit[]>();
  const seen = new Set<Unit>();
  const visit = (unit: Unit) => {
    if (seen.has(unit)) return;
    seen.add(unit);
    byRow.set(unit.generation, [...(byRow.get(unit.generation) ?? []), unit]);
    for (const child of [...unit.children].sort(byBirth)) visit(child);
    for (const parent of unit.parents) visit(parent);
  };
  visit(rootUnit);
  for (const unit of units) visit(unit);

  const rows = [...byRow.keys()].sort((a, b) => a - b).map((generation) => byRow.get(generation)!);
  const index = new Map<Unit, number>();
  const reindex = (row: Unit[]) => row.forEach((unit, i) => index.set(unit, i));
  rows.forEach(reindex);

  const crossings = (): number => {
    let count = 0;
    for (const row of rows) {
      const ties = row.flatMap((unit) => unit.children.map((child) => [index.get(unit)!, index.get(child)!] as const));
      for (let i = 0; i < ties.length; i++) {
        for (let j = i + 1; j < ties.length; j++) {
          if ((ties[i][0] - ties[j][0]) * (ties[i][1] - ties[j][1]) < 0) count++;
        }
      }
    }
    return count;
  };

  const sweep = (row: Unit[], ties: (unit: Unit) => Unit[]) => {
    const pulls = row.map((unit, i) => {
      const others = ties(unit);
      return { unit, i, at: others.length > 0 ? others.reduce((sum, other) => sum + index.get(other)!, 0) / others.length : null };
    });
    const moving = pulls.filter((pull) => pull.at !== null).sort((a, b) => a.at! - b.at! || a.i - b.i);
    let next = 0;
    pulls.forEach((pull, i) => {
      if (pull.at !== null) row[i] = moving[next++].unit;
    });
    reindex(row);
  };

  let best = rows.map((row) => [...row]);
  let fewest = crossings();
  for (let round = 0; round < ORDER_ROUNDS && fewest > 0; round++) {
    for (let r = 1; r < rows.length; r++) sweep(rows[r], (unit) => unit.parents);
    for (let r = rows.length - 2; r >= 0; r--) sweep(rows[r], (unit) => unit.children);
    const now = crossings();
    if (now < fewest) {
      fewest = now;
      best = rows.map((row) => [...row]);
    }
  }
  return best;
}

/**
 * Every unit's x, keeping each row in the order given.
 *
 * A unit is pulled to where its ties want it: each member who is somebody's child under the
 * middle of their parents, and the parents of each child over that child. Each row then takes the
 * positions nearest those wishes that keep its order with a gap between neighbours — isotonic
 * regression once every unit is shifted by the room the ones before it need, solved by pooling
 * adjacent violators. Sweeping down the rows and up again until nothing moves is coordinate
 * descent on one convex sum of squares, so it settles on one balanced drawing.
 */
function placeRows(rows: Unit[][], unitOf: Map<string, Unit>, graph: FamilyGraph): void {
  /** A person's parents drawn one row up, as their cards' middles. */
  const parentsAbove = (path: string, generation: number): number[] =>
    (graph.nodes[path]?.parents ?? []).flatMap((parent) => {
      const unit = unitOf.get(parent);
      return unit && unit.generation === generation - 1 ? [unit.x + memberOffset(unit, parent)] : [];
    });
  const trunk = (xs: number[]) => (Math.min(...xs) + Math.max(...xs)) / 2;

  const wish = (unit: Unit): { x: number; weight: number } => {
    let sum = 0;
    let weight = 0;
    for (const member of unit.members) {
      const above = parentsAbove(member, unit.generation);
      if (above.length === 0) continue;
      sum += trunk(above) - memberOffset(unit, member);
      weight++;
    }
    const seen = new Set<string>();
    for (const member of unit.members) {
      for (const child of graph.nodes[member]?.children ?? []) {
        const below = unitOf.get(child);
        if (!below || below.generation !== unit.generation + 1 || seen.has(child)) continue;
        seen.add(child);
        const mine = (graph.nodes[child]?.parents ?? []).filter((parent) => unitOf.get(parent) === unit);
        const offset = trunk(mine.map((parent) => memberOffset(unit, parent)));
        sum += below.x + memberOffset(below, child) - offset;
        weight++;
      }
    }
    return weight > 0 ? { x: sum / weight, weight } : { x: unit.x, weight: LOOSE };
  };

  const settle = (row: Unit[]): number => {
    const room: number[] = [];
    let used = 0;
    for (const unit of row) {
      room.push(used);
      used += unit.width + UNIT_GAP;
    }
    const blocks: { sum: number; weight: number; count: number }[] = [];
    row.forEach((unit, i) => {
      const { x, weight } = wish(unit);
      blocks.push({ sum: (x - room[i]) * weight, weight, count: 1 });
      while (blocks.length > 1) {
        const last = blocks[blocks.length - 1];
        const before = blocks[blocks.length - 2];
        if (before.sum / before.weight <= last.sum / last.weight) break;
        blocks.pop();
        before.sum += last.sum;
        before.weight += last.weight;
        before.count += last.count;
      }
    });
    let moved = 0;
    let i = 0;
    for (const block of blocks) {
      for (let k = 0; k < block.count; k++, i++) {
        const x = block.sum / block.weight + room[i];
        moved = Math.max(moved, Math.abs(x - row[i].x));
        row[i].x = x;
      }
    }
    return moved;
  };

  for (let round = 0; round < PLACE_ROUNDS; round++) {
    let moved = 0;
    for (const row of rows) moved = Math.max(moved, settle(row));
    for (const row of [...rows].reverse()) moved = Math.max(moved, settle(row));
    if (moved < SETTLED) break;
  }
}

/**
 * A couple drawn the other way round when that brings their cards nearer their own parents: a
 * daughter-in-law whose parents are drawn stands on their side of her husband, not across him.
 */
function faceParents(units: Unit[], unitOf: Map<string, Unit>, graph: FamilyGraph): boolean {
  const reach = (unit: Unit): number =>
    unit.members.reduce((sum, member) => {
      const above = (graph.nodes[member]?.parents ?? []).flatMap((parent) => {
        const owner = unitOf.get(parent);
        return owner && owner.generation === unit.generation - 1 ? [owner.x + memberOffset(owner, parent)] : [];
      });
      if (above.length === 0) return sum;
      return sum + Math.abs(unit.x + memberOffset(unit, member) - (Math.min(...above) + Math.max(...above)) / 2);
    }, 0);

  let turned = false;
  for (const unit of units) {
    if (unit.members.length !== 2) continue;
    const before = reach(unit);
    unit.members.reverse();
    if (reach(unit) < before - 1) turned = true;
    else unit.members.reverse();
  }
  return turned;
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

  connect(units, unitOf, graph);
  const order = orderRows(rootUnit, units, graph);
  placeRows(order, unitOf, graph);
  if (faceParents(units, unitOf, graph)) placeRows(order, unitOf, graph);

  const rows = [...new Set(units.map((unit) => unit.generation))];
  const topRow = Math.min(...rows);
  const y = (row: number) => PADDING + (row - topRow) * ROW_HEIGHT;

  // The placement has no origin of its own: everything moves so the leftmost
  // card starts at the padding.
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
