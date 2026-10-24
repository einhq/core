import { assertEquals } from '@std/assert';
import { CARD_GAP, CARD_TEXT_HEIGHT, cardLayout, cardPosition, cardRangeForVerticalWindow, cardTextHeight, columnsForWidth, textPartsOf } from '../card-layout.ts';

Deno.test('columns fit the width without letting a card get too narrow', () => {
  assertEquals(columnsForWidth(0), 1);
  // 210 + 16 + 210 = 436
  assertEquals(columnsForWidth(436), 2);
  assertEquals(columnsForWidth(1200), 5);
  // Above two, the phone floor plays no part: 3 × 210 + 2 × 16 = 662.
  assertEquals(columnsForWidth(662), 3);
  assertEquals(columnsForWidth(661), 2);
  // Capped, however wide the window gets.
  assertEquals(columnsForWidth(100000), 6);
});

Deno.test('a phone keeps two narrower cards before it drops to one', () => {
  // 390px screen, 16px padding each side.
  assertEquals(columnsForWidth(358), 2);
  // 320px screen: 130 + 16 + 130 = 276 is the floor.
  assertEquals(columnsForWidth(288), 2);
  assertEquals(columnsForWidth(276), 2);
  assertEquals(columnsForWidth(275), 1);
  assertEquals(columnsForWidth(200), 1);
});

Deno.test('cards divide the width evenly, with gaps only between them', () => {
  const layout = cardLayout(10, 1000);
  assertEquals(layout.columns, 4);
  // 1000 - 3 gaps of 16 = 952, over 4 columns
  assertEquals(layout.cardWidth, 238);
  assertEquals(layout.rows, 3);
  // Three rows of card height plus the two gaps between them.
  assertEquals(layout.height, 3 * layout.cardHeight + 2 * CARD_GAP);
});

Deno.test('an empty grid has no rows and no height', () => {
  const layout = cardLayout(0, 1000);
  assertEquals(layout.rows, 0);
  assertEquals(layout.height, 0);
  assertEquals(cardRangeForVerticalWindow(0, layout, { top: 0, bottom: 800 }), { start: 0, end: 0 });
});

Deno.test('a card sits at its row and column offset', () => {
  const layout = cardLayout(10, 1000);
  assertEquals(cardPosition(0, layout), { top: 0, left: 0 });
  assertEquals(cardPosition(1, layout), { top: 0, left: layout.cardWidth + CARD_GAP });
  assertEquals(cardPosition(4, layout), { top: layout.cardHeight + CARD_GAP, left: 0 });
  assertEquals(cardPosition(9, layout).top, 2 * (layout.cardHeight + CARD_GAP));
});

Deno.test('the window selects whole rows, and nothing before it is measured', () => {
  const layout = cardLayout(100, 1000);
  const stride = layout.cardHeight + CARD_GAP;

  // The first pass has no window: mount nothing rather than all 100.
  assertEquals(cardRangeForVerticalWindow(100, layout, undefined), { start: 0, end: 0 });

  // A band inside the first row takes exactly that row.
  assertEquals(cardRangeForVerticalWindow(100, layout, { top: 0, bottom: 1 }), { start: 0, end: 4 });

  // A band starting inside row 2 and ending inside row 4 covers rows 2..4.
  const window = { top: stride * 2 + 5, bottom: stride * 4 + 5 };
  assertEquals(cardRangeForVerticalWindow(100, layout, window), { start: 8, end: 20 });
});

Deno.test('the last row is partial and never runs past the item count', () => {
  const layout = cardLayout(10, 1000);
  const range = cardRangeForVerticalWindow(10, layout, { top: 0, bottom: layout.height });
  assertEquals(range, { start: 0, end: 10 });
});

Deno.test('a band past the end of the grid selects nothing', () => {
  const layout = cardLayout(10, 1000);
  const past = { top: layout.height + 500, bottom: layout.height + 1500 };
  assertEquals(cardRangeForVerticalWindow(10, layout, past), { start: 0, end: 0 });
});

Deno.test('a card reserves only the lines it draws', () => {
  const titleOnly = cardTextHeight({});
  // 11 above the title, two 24px title lines, 15 of card padding.
  assertEquals(titleOnly, 74);
  assertEquals(cardTextHeight({ badges: true }), 74 + 22);
  assertEquals(cardTextHeight({ date: true, description: true, badges: true }), CARD_TEXT_HEIGHT);
});

Deno.test('a grid reserves what its fullest card draws', () => {
  const people = [{ fullname: '' }, { fullname: 'Anna Maria Andersson' }, { fullname: '' }];
  assertEquals(textPartsOf(people, (person) => ({ description: Boolean(person.fullname) })), { description: true });
  assertEquals(textPartsOf([], () => ({ badges: true })), {});
});

Deno.test('a reported height grows every card, and only grows', () => {
  const reserved = cardLayout(10, 1000, CARD_GAP, cardTextHeight({}));
  const grown = cardLayout(10, 1000, CARD_GAP, cardTextHeight({}), reserved.cardHeight + 20);
  assertEquals(grown.cardHeight, reserved.cardHeight + 20);
  assertEquals(grown.height, 3 * grown.cardHeight + 2 * CARD_GAP);
  assertEquals(cardLayout(10, 1000, CARD_GAP, cardTextHeight({}), 10).cardHeight, reserved.cardHeight);
});

Deno.test('a card is a whole number of pixels tall, so a repeated row does not drift', () => {
  for (const width of [375, 1000, 1337.5]) assertEquals(Number.isInteger(cardLayout(10, width).cardHeight), true);
});
