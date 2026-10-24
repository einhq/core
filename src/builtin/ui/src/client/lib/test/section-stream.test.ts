import { assertEquals } from '@std/assert';
import { holdOffset, sectionAt, sectionHeight, sectionsInBand, sectionTop, streamHeight, streamLayout } from '../section-stream.ts';

const CLOSED = 300;
const GAP = 12;
const STRIDE = CLOSED + GAP;

Deno.test('with nothing open, offsets are the index times the closed height and the gap', () => {
  const layout = streamLayout(10, CLOSED, GAP, new Map());
  assertEquals([0, 1, 9].map((index) => sectionTop(layout, index)), [0, STRIDE, 9 * STRIDE]);
  assertEquals(streamHeight(layout), 10 * STRIDE - GAP);
  assertEquals(sectionHeight(layout, 4), CLOSED);
});

Deno.test('one open section moves only the sections below it', () => {
  const layout = streamLayout(10, CLOSED, GAP, new Map([[3, 1200]]));
  assertEquals(sectionTop(layout, 3), 3 * STRIDE);
  assertEquals(sectionHeight(layout, 3), 1200);
  assertEquals(sectionTop(layout, 4), 3 * STRIDE + 1200 + GAP);
  assertEquals(sectionTop(layout, 9), 9 * STRIDE + 900);
  assertEquals(streamHeight(layout), 10 * STRIDE - GAP + 900);
});

Deno.test('three open sections add up, whatever order they were given in', () => {
  const layout = streamLayout(20, CLOSED, GAP, new Map([[15, 500], [2, 1000], [7, 100]]));
  assertEquals(layout.openIndexes, [2, 7, 15]);
  assertEquals(sectionTop(layout, 2), 2 * STRIDE);
  assertEquals(sectionTop(layout, 7), 7 * STRIDE + 700);
  assertEquals(sectionTop(layout, 8), 8 * STRIDE + 700 - 200);
  assertEquals(sectionTop(layout, 16), 16 * STRIDE + 700 - 200 + 200);
  assertEquals(streamHeight(layout), 20 * STRIDE - GAP + 700);
  // An index past the end is left out.
  assertEquals(streamLayout(3, CLOSED, GAP, new Map([[5, 900]])).openIndexes, []);
});

Deno.test('a band names the sections it crosses, gaps and edges included', () => {
  const layout = streamLayout(10, CLOSED, GAP, new Map([[2, 1000]]));
  assertEquals(sectionsInBand(layout, 0, 10), { start: 0, end: 1 });
  // From inside section 0 to inside the open section 2.
  assertEquals(sectionsInBand(layout, 100, 2 * STRIDE + 900), { start: 0, end: 3 });
  // A band inside one gap touches the section that starts at its lower edge only once it reaches it.
  assertEquals(sectionsInBand(layout, CLOSED + 1, CLOSED + GAP - 1), { start: 1, end: 1 });
  assertEquals(sectionsInBand(layout, CLOSED + 1, STRIDE), { start: 1, end: 2 });
  // Past the end, and before the start.
  assertEquals(sectionsInBand(layout, streamHeight(layout) + 1, streamHeight(layout) + 500), { start: 10, end: 10 });
  assertEquals(sectionsInBand(layout, -500, -1), { start: 0, end: 0 });
  assertEquals(sectionsInBand(streamLayout(0, CLOSED, GAP, new Map()), 0, 1000), { start: 0, end: 0 });
});

Deno.test('the section across a line is the one it falls in, or the next after a gap', () => {
  const layout = streamLayout(4, CLOSED, GAP, new Map());
  assertEquals(sectionAt(layout, 0), 0);
  assertEquals(sectionAt(layout, CLOSED + 2), 1);
  assertEquals(sectionAt(layout, STRIDE + 5), 1);
  assertEquals(sectionAt(layout, 10_000), undefined);
});

Deno.test('a section above the held one that grows, or goes, moves it by exactly that', () => {
  const closed = streamLayout(10, CLOSED, GAP, new Map());
  // Section 2, above the held section 5, opens to 900 px: hold by scrolling down 600.
  const opened = streamLayout(10, CLOSED, GAP, new Map([[2, 900]]));
  assertEquals(holdOffset(closed, 5, opened, 5), 600);
  // The held section itself growing moves nothing above it.
  const heldOpen = streamLayout(10, CLOSED, GAP, new Map([[5, 900]]));
  assertEquals(holdOffset(closed, 5, heldOpen, 5), 0);
  // Section 1 leaves the stream: the held section is one index earlier and one stride higher.
  const removed = streamLayout(9, CLOSED, GAP, new Map());
  assertEquals(holdOffset(closed, 5, removed, 4), -STRIDE);
  // An open section above goes: its whole height and gap.
  const removedOpen = streamLayout(9, CLOSED, GAP, new Map());
  assertEquals(holdOffset(opened, 5, removedOpen, 4), -(900 + GAP));
  // Something below changes nothing.
  assertEquals(holdOffset(closed, 5, streamLayout(10, CLOSED, GAP, new Map([[8, 2000]])), 5), 0);
});
