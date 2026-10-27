/**
 * The family tree's geometry.
 *
 * These are the properties a screenshot cannot check: that no two cards on a row
 * overlap, that a couple stays together, that a child hangs under the middle of
 * its parents, and that a graph which reaches the same person twice still
 * terminates.
 */

import { assert, assertEquals } from '@std/assert';
import { CARD_WIDTH, type FamilyGraph, type FamilyNode, layoutFamily } from '../family-layout.ts';

type Spec = {
  parents?: string[];
  children?: string[];
  partners?: string[];
  parentCount?: number;
  childCount?: number;
  born?: string;
};

/** A graph from a terse description; counts default to what is actually drawn. */
const graphOf = (root: string, spec: Record<string, Spec>): FamilyGraph => {
  const nodes: Record<string, FamilyNode> = {};
  for (const [name, entry] of Object.entries(spec)) {
    nodes[`/archive/people/${name}`] = {
      path: `/archive/people/${name}`,
      name,
      parents: (entry.parents ?? []).map((p) => `/archive/people/${p}`),
      children: (entry.children ?? []).map((c) => `/archive/people/${c}`),
      partners: (entry.partners ?? []).map((p) => ({ path: `/archive/people/${p}` })),
      parentCount: entry.parentCount ?? (entry.parents ?? []).length,
      childCount: entry.childCount ?? (entry.children ?? []).length,
      ...(entry.born ? { born: entry.born } : {}),
    };
  }
  return { root: `/archive/people/${root}`, nodes };
};

const centre = (layout: ReturnType<typeof layoutFamily>, name: string): number => layout.byPath[`/archive/people/${name}`].x + CARD_WIDTH / 2;

/** The families a person's card hangs from: their row, and a drop at their middle. */
const familiesOf = (layout: ReturnType<typeof layoutFamily>, name: string) => {
  const card = layout.byPath[`/archive/people/${name}`];
  return layout.families.filter((family) => family.toY === card.y && family.children.includes(card.x + CARD_WIDTH / 2));
};

/** Every pair of cards sharing a row, checked for overlap. */
const overlaps = (layout: ReturnType<typeof layoutFamily>): string[] => {
  const found: string[] = [];
  for (const a of layout.cards) {
    for (const b of layout.cards) {
      if (a.path >= b.path || a.y !== b.y) continue;
      if (a.x < b.x + CARD_WIDTH && b.x < a.x + CARD_WIDTH) found.push(`${a.path} / ${b.path}`);
    }
  }
  return found;
};

/** anna + erik, their children mia and edvin, mia's john, edvin's lisa, anna's parents. */
const family = () =>
  graphOf('anna', {
    eva: { children: ['anna'], partners: ['karl'] },
    karl: { children: ['anna'], partners: ['eva'] },
    anna: { parents: ['eva', 'karl'], children: ['mia', 'edvin'], partners: ['erik'] },
    erik: { children: ['mia', 'edvin'], partners: ['anna'], parentCount: 2 },
    mia: { parents: ['anna', 'erik'], children: ['john'] },
    edvin: { parents: ['anna', 'erik'], children: ['lisa'] },
    john: { parents: ['mia'] },
    lisa: { parents: ['edvin'] },
  });

Deno.test('family layout: rows, and nothing overlapping on them', () => {
  const layout = layoutFamily(family());

  assertEquals(overlaps(layout), []);

  // Ancestors above, descendants below, the person in the middle.
  assertEquals(layout.byPath[`/archive/people/anna`].generation, 0);
  assertEquals(layout.byPath[`/archive/people/erik`].generation, 0);
  assertEquals(layout.byPath[`/archive/people/eva`].generation, -1);
  assertEquals(layout.byPath[`/archive/people/mia`].generation, 1);
  assertEquals(layout.byPath[`/archive/people/john`].generation, 2);

  // A row is a row: same generation, same y.
  assertEquals(layout.byPath[`/archive/people/mia`].y, layout.byPath[`/archive/people/edvin`].y);
  assert(layout.byPath[`/archive/people/eva`].y < layout.byPath[`/archive/people/anna`].y);
  assert(layout.byPath[`/archive/people/anna`].y < layout.byPath[`/archive/people/mia`].y);
});

Deno.test('family layout: partners sit side by side', () => {
  const layout = layoutFamily(family());

  for (const [a, b] of [['anna', 'erik'], ['eva', 'karl']] as const) {
    const gap = Math.abs(centre(layout, a) - centre(layout, b));
    // Touching distance plus the couple gap — closer than any other pair on the
    // row, which is what makes a couple read as one block.
    assert(gap < CARD_WIDTH * 1.5, `${a}/${b} drawn ${gap}px apart`);
  }

  // And the bar between them is drawn, in the gap rather than over a card.
  const union = layout.unions.find((u) => u.key === `/archive/people/anna~/archive/people/erik`);
  assert(union !== undefined);
  assert(union.x2 > union.x1);
});

Deno.test('family layout: a child hangs under the middle of its parents', () => {
  const layout = layoutFamily(family());

  const coupleMiddle = (centre(layout, 'anna') + centre(layout, 'erik')) / 2;
  const childrenMiddle = (centre(layout, 'mia') + centre(layout, 'edvin')) / 2;
  assert(Math.abs(coupleMiddle - childrenMiddle) < 1, `couple at ${coupleMiddle}, children at ${childrenMiddle}`);

  // One family: a stem from the middle of each parent's card to the couple
  // bar, the trunk from its middle, and a drop into each child.
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const theirs = familiesOf(layout, 'mia');
  assertEquals(theirs.length, 1);
  const [lines] = theirs;
  assertEquals(lines.parents, sorted([centre(layout, 'anna'), centre(layout, 'erik')]));
  assertEquals(lines.children, sorted([centre(layout, 'mia'), centre(layout, 'edvin')]));
  assert(Math.abs(lines.trunkX - coupleMiddle) < 1);
  // Downward, with the couple bar above the sibling bar, both between the rows.
  assert(lines.coupleY !== undefined);
  assert(lines.fromY < lines.coupleY && lines.coupleY < lines.siblingY && lines.siblingY < lines.toY);
});

Deno.test('family layout: a partnership carries its years', () => {
  const graph = family();
  const anna = graph.nodes['/archive/people/anna'];
  anna.partners = anna.partners.map((partner) => ({ ...partner, from: '1975-06-01', to: '2001-02-03' }));
  const union = layoutFamily(graph).unions.find((u) => u.key === `/archive/people/anna~/archive/people/erik`);
  assertEquals([union?.from, union?.to], ['1975', '2001']);
});

Deno.test('family layout: a single parent sources its own line', () => {
  const layout = layoutFamily(family());
  const toJohn = familiesOf(layout, 'john');
  assertEquals(toJohn.length, 1);
  assertEquals(toJohn[0].parents, [centre(layout, 'mia')]);
  assertEquals(toJohn[0].trunkX, centre(layout, 'mia'));
  assertEquals(toJohn[0].coupleY, undefined);
});

Deno.test('family layout: a person reached twice is drawn once, and it terminates', () => {
  // Cousins who married: fred descends from both of gustav's children, so the
  // walk reaches him by two routes.
  const layout = layoutFamily(graphOf('fred', {
    gustav: { children: ['hans', 'inga'] },
    hans: { parents: ['gustav'], children: ['fred'] },
    inga: { parents: ['gustav'], children: ['fred'] },
    fred: { parents: ['hans', 'inga'] },
  }));

  assertEquals(layout.cards.filter((card) => card.path === `/archive/people/fred`).length, 1);
  assertEquals(overlaps(layout), []);
  // Both ties are still drawn even though only one of them placed him.
  const toFred = familiesOf(layout, 'fred');
  assertEquals(toFred.length, 1);
  assertEquals(toFred[0].parents, [centre(layout, 'hans'), centre(layout, 'inga')].sort((a, b) => a - b));
});

Deno.test('family layout: a lone person is a drawing of one card', () => {
  const layout = layoutFamily(graphOf('solo', { solo: { parentCount: 2, childCount: 3 } }));

  assertEquals(layout.cards.length, 1);
  assertEquals(layout.families, []);
  assertEquals(layout.unions, []);
  assert(layout.width > CARD_WIDTH);
  assert(layout.height > 0);
});

Deno.test('family layout: an unknown root draws nothing rather than throwing', () => {
  assertEquals(layoutFamily({ root: `/archive/people/ghost`, nodes: {} }).cards, []);
});

Deno.test('family layout: many children stay on their row without overlapping', () => {
  const kids = Array.from({ length: 9 }, (_, i) => `kid${i}`);
  const layout = layoutFamily(graphOf('parent', {
    parent: { children: kids },
    ...Object.fromEntries(kids.map((kid) => [kid, { parents: ['parent'] }])),
  }));

  assertEquals(overlaps(layout), []);
  // The parent ends up over the middle of the row it spawned.
  const xs = kids.map((kid) => centre(layout, kid));
  const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  assert(Math.abs(centre(layout, 'parent') - middle) < 1);
  // And the drawing is wide enough to hold them all.
  assert(layout.width >= 9 * CARD_WIDTH);
});

Deno.test('family layout: a fragment with no route to the root is parked, not stacked', () => {
  // `person-graph` cannot produce this — it only answers with nodes reachable
  // from its root — but the layout must not draw one card on top of another if
  // it ever sees one. Hanging the fragment off the root would do exactly that on
  // the root's own row, since the root is centred over its children.
  const layout = layoutFamily(graphOf('anna', {
    anna: { children: ['mia'] },
    mia: { parents: ['anna'] },
    loner: {},
    stranger: {},
  }));

  assertEquals(layout.cards.length, 4);
  assertEquals(overlaps(layout), []);
  // Parked to the right of everything that was placed.
  const placed = Math.max(centre(layout, 'anna'), centre(layout, 'mia'));
  assert(centre(layout, 'loner') > placed);
  assert(centre(layout, 'stranger') > placed);
});

Deno.test('family layout: no union bar between two people who are not partners', () => {
  // Anna has two partners and both are drawn, so all three share a block. Erik
  // and Lars are each her partner and not each other's; a bar between them would
  // say otherwise.
  const layout = layoutFamily(graphOf('anna', {
    anna: { partners: ['erik', 'lars'] },
    erik: { partners: ['anna'] },
    lars: { partners: ['anna'] },
  }));

  assertEquals(layout.cards.length, 3);
  assertEquals(overlaps(layout), []);
  for (const union of layout.unions) {
    assert(union.key.includes(`/archive/people/anna`), `bar drawn between non-partners: ${union.key}`);
  }
});

Deno.test('family layout: relatives reached sideways take their place among the rest', () => {
  // mia's siblings, her mother's brother and both sets of grandparents: none of
  // them is mia's ancestor or descendant, and each must still stand by its own
  // family, with no family's lines crossing another's.
  const layout = layoutFamily(graphOf('mia', {
    gustav: { children: ['anna', 'nils'], partners: ['hedda'] },
    hedda: { children: ['anna', 'nils'], partners: ['gustav'] },
    karl: { children: ['erik'], partners: ['eva'] },
    eva: { children: ['erik'], partners: ['karl'] },
    nils: { parents: ['gustav', 'hedda'], born: '1952' },
    anna: { parents: ['gustav', 'hedda'], children: ['mia', 'edvin', 'olle'], partners: ['erik'], born: '1950' },
    erik: { parents: ['karl', 'eva'], children: ['mia', 'edvin', 'olle'], partners: ['anna'] },
    olle: { parents: ['anna', 'erik'], born: '1982' },
    mia: { parents: ['anna', 'erik'], born: '1975' },
    edvin: { parents: ['anna', 'erik'], born: '1978' },
  }));

  assertEquals(overlaps(layout), []);
  // Siblings in the order they were born, under the middle of their parents.
  assert(centre(layout, 'mia') < centre(layout, 'edvin') && centre(layout, 'edvin') < centre(layout, 'olle'));
  assert(Math.abs(centre(layout, 'edvin') - (centre(layout, 'anna') + centre(layout, 'erik')) / 2) < 1);
  // Nils stands on his own parents' side of his sister's couple.
  const gustavHedda = (centre(layout, 'gustav') + centre(layout, 'hedda')) / 2;
  const karlEva = (centre(layout, 'karl') + centre(layout, 'eva')) / 2;
  assert(Math.sign(centre(layout, 'nils') - centre(layout, 'erik')) === Math.sign(gustavHedda - karlEva));
  // Each row's sibling bars, trunk included, run side by side, never over one another.
  const spans = layout.families.map((family) => ({
    y: family.siblingY,
    from: Math.min(family.trunkX, ...family.children),
    to: Math.max(family.trunkX, ...family.children),
  }));
  for (const a of spans) {
    for (const b of spans) {
      if (a === b || a.y !== b.y) continue;
      assert(a.to < b.from || b.to < a.from, `sibling bars overlap: ${JSON.stringify([a, b])}`);
    }
  }
});
