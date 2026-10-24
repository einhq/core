import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { type HatFieldKind, layoutHatField } from '../hat-field.ts';
import type { LuminanceMap } from '../image-luminance.ts';

type Point = [number, number];

const polygons = (d: string): Point[][] => d.split('M').filter(Boolean).map((hat) => hat.replace('Z', '').split('L').map((pair) => pair.split(' ').map(Number) as Point));

const contains = (corners: Point[], [x, y]: Point): boolean => {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, yi] = corners[i];
    const [xj, yj] = corners[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Every hat a field draws, as its corners. */
const hatsOf = (width: number, height: number, seed: string, kind: HatFieldKind): Point[][] =>
  polygons(layoutHatField(width, height, seed, kind).tiles.map((tile) => tile.d).join(''));

Deno.test('a band is covered edge to edge: its hats run on past every edge and leave no gap', () => {
  const width = 1160, height = 184;
  const hats = hatsOf(width, height, 'album:/albums', 'band');
  const corners = hats.flat();
  assert(corners.some(([x]) => x < 0) && corners.some(([x]) => x > width), 'the hats stop short of a side');
  assert(corners.some(([, y]) => y < 0) && corners.some(([, y]) => y > height), 'the hats stop short of the top or the foot');
  for (let i = 0; i < 400; i++) {
    const point: Point = [(i * 37.3) % width, (i * 13.7) % height];
    assertEquals(hats.filter((hat) => contains(hat, point)).length, 1, `${point} is in no hat or in two`);
  }
  for (const point of [[1, 1], [width - 1, 1]] as Point[]) {
    assertEquals(hats.filter((hat) => contains(hat, point)).length, 1, `the corner ${point} is bare`);
  }
});

Deno.test('a band lights only tiles above its foot and clear of its title, and a cover none', () => {
  const width = 1160;
  const glints = layoutHatField(width, 184, 'album:/albums', 'band').tiles.filter((tile) => tile.glint);
  assert(glints.length > 50);
  for (const tile of glints) {
    assert(tile.x > .3 * width, 'a tile behind the title may light');
    assert(tile.y < .55 * 184, 'a tile in the dark foot may light');
  }
  assertEquals(layoutHatField(width, 184, 'album:/albums/a', 'cover').tiles.filter((tile) => tile.glint), []);
});

Deno.test('a backdrop runs past every edge', () => {
  const backdrop = hatsOf(390, 844, 'mixed:/login', 'backdrop').flat();
  assert(backdrop.some(([x]) => x < 0) && backdrop.some(([, y]) => y < 0) && backdrop.some(([x]) => x > 390));
});

Deno.test('one seed always cuts the same field, and seeds differ', () => {
  assertEquals(layoutHatField(800, 180, 'label:/labels', 'band'), layoutHatField(800, 180, 'label:/labels', 'band'));
  assertNotEquals(hatsOf(800, 180, 'label:/labels', 'band'), hatsOf(800, 180, 'album:/albums', 'band'));
});

Deno.test("a band's tiles darken towards its foot, outline and fill; a backdrop's do not", () => {
  const { tiles } = layoutHatField(1000, 200, 'media:/media', 'band');
  const top = tiles.filter((tile) => tile.y < 60);
  const foot = tiles.filter((tile) => tile.y > 170);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert(mean(foot.map((tile) => tile.shade)) < mean(top.map((tile) => tile.shade)) - .4);
  assert(mean(foot.map((tile) => tile.fill)) < mean(top.map((tile) => tile.fill)));
  assert(layoutHatField(1000, 200, 'mixed:/login', 'backdrop').tiles.every((tile) => tile.shade === 1));
});

Deno.test('over a cover the field is outlines that leave no gap', () => {
  const width = 800, height = 300;
  const { tiles } = layoutHatField(width, height, 'album:/albums/a', 'cover');
  assert(tiles.every((tile) => tile.fill === 0));
  const hats = polygons(tiles.map((tile) => tile.d).join(''));
  for (let i = 0; i < 400; i++) {
    const point: Point = [(i * 37.3) % width, (i * 13.7) % height];
    assertEquals(hats.filter((hat) => contains(hat, point)).length, 1, `${point} is in no hat or in two`);
  }
});

Deno.test("a cover's hats know whether the picture under them is light, as it fills the band", () => {
  // A 4 × 1 picture, white on its left half and black on its right, covering a band of its own shape.
  const halves: LuminanceMap = { width: 4, height: 1, values: new Float32Array([1, 1, 0, 0]) };
  const width = 800, height = 200;
  const { tiles } = layoutHatField(width, height, 'album:/albums/a', 'cover', halves);
  const left = tiles.filter((tile) => tile.x < width / 2 - 40);
  const right = tiles.filter((tile) => tile.x > width / 2 + 40);
  assert(left.length > 10 && left.every((tile) => tile.onLight === 1));
  assert(right.length > 10 && right.every((tile) => tile.onLight === 0));
  assert(layoutHatField(width, height, 'album:/albums/a', 'cover').tiles.every((tile) => tile.onLight === 0));
});

Deno.test('a wedge covers the left of a band and fades hat by hat across a slanted edge, widest at its foot', () => {
  const width = 1000, height = 200;
  const { tiles, hatSize } = layoutHatField(width, height, 'album:/albums/a', 'wedge');
  const whole = tiles.filter((tile) => tile.ground === 1);
  const hats = polygons(whole.map((tile) => tile.d).join(''));
  for (let i = 0; i < 300; i++) {
    const point: Point = [(i * 37.3) % (.08 * width), (i * 13.7) % height];
    assertEquals(hats.filter((hat) => contains(hat, point)).length, 1, `${point} is in no whole hat or in two`);
  }
  const fading = tiles.filter((tile) => tile.ground < 1);
  const meanX = (from: number, to: number) => {
    const xs = fading.filter((tile) => tile.y >= from && tile.y < to).map((tile) => tile.x);
    return xs.reduce((sum, x) => sum + x, 0) / xs.length;
  };
  assert(meanX(150, 200) > meanX(0, 50) + 60, 'the edge does not lean');
  assert(fading.length > 10, 'the wedge ends abruptly');
  assert(fading.every((tile) => tile.ground > 0 && tile.fill < .3 * tile.ground + .01));
  assert(Math.max(...tiles.map((tile) => tile.x)) < .34 * width + height / 2 * .65 + 4.5 * hatSize, 'the fade runs on too far');
  assert(tiles.every((tile) => tile.glint === (tile.y < .45 * height && tile.ground === 1)));
  assert(layoutHatField(width, height, 'album:/albums', 'band').tiles.every((tile) => tile.ground === 0));
});

Deno.test('a field larger than the patch grows its hats to fill it', () => {
  const width = 4000, height = 2400;
  const corners = hatsOf(width, height, 'mixed:/login', 'backdrop').flat();
  assert(corners.some(([x, y]) => x > width - 120 && y > height - 120), 'the bottom-right corner is bare');
});
