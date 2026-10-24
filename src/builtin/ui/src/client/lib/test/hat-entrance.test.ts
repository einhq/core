import { assert, assertEquals } from '@std/assert';
import { HAT_ENTRANCES, hatEntrance, isHatEntrance } from '../hat-entrance.ts';
import { layoutHatField } from '../hat-field.ts';

const width = 1160, height = 182;
const { tiles, hatSize } = layoutHatField(width, height, 'album:/albums', 'band');
const origin = [90, 80] as const;
const delays = (animation: string): number[] => [...animation.matchAll(/ (\d+)ms both/g)].map((match) => Number(match[1]));

Deno.test('every entrance gives every tile an animation that holds its end, and is over in the time it is given', () => {
  for (const entrance of HAT_ENTRANCES) {
    const { tiles: entering, ends } = hatEntrance(entrance, 450, tiles, width, height, hatSize, origin);
    assertEquals(entering.length, tiles.length, entrance);
    assertEquals(ends, 450, entrance);
    const last = Math.max(
      ...entering.flatMap((tile) => [tile.style, tile.flash].filter((style) => style !== undefined)).flatMap((style) =>
        [...style.animation.matchAll(/ (\d+)ms \S+ (\d+)ms both/g)].map((match) => Number(match[1]) + Number(match[2]))
      ),
    );
    assert(Math.abs(last - 450) <= 2, `${entrance} ends at ${last} ms`);
    for (const tile of entering) {
      assert(tile.style.animation.includes(' both'), `${entrance}: ${tile.style.animation}`);
      assert(Math.max(...delays(tile.style.animation)) < ends, entrance);
    }
  }
});

Deno.test('drawn starts at the foot and works up', () => {
  const { tiles: entering } = hatEntrance('drawn', 450, tiles, width, height, hatSize, origin);
  const start = (i: number) => delays(entering[i].style.animation)[0];
  const foot = tiles.map((tile, i) => [tile, i] as const).filter(([tile]) => tile.y > 150).map(([, i]) => start(i));
  const top = tiles.map((tile, i) => [tile, i] as const).filter(([tile]) => tile.y < 50).map(([, i]) => start(i));
  assert(Math.max(...foot) < Math.min(...top), 'a tile at the top is drawn before one at the foot');
  assert(entering.every((tile) => tile.pathLength === 1 && tile.style['--mrx-hat-fill'] !== undefined));
});

Deno.test('sweep runs left to right, one tile after another', () => {
  const { tiles: entering } = hatEntrance('sweep', 450, tiles, width, height, hatSize, origin);
  const order = tiles.map((tile, i) => ({ x: tile.x, delay: delays(entering[i].style.animation)[0] })).sort((a, b) => a.delay - b.delay || a.x - b.x);
  for (let i = 1; i < order.length; i++) assert(order[i].x >= order[i - 1].x - 1, 'a tile to the left comes later');
});

Deno.test('sliding starts every tile past the right edge, the left ones first', () => {
  const { tiles: entering } = hatEntrance('sliding', 2000, tiles, width, height, hatSize, origin);
  for (const [i, tile] of tiles.entries()) {
    assert(tile.x - hatSize / 2 + Number.parseInt(entering[i].style['--mrx-hat-slide']) > width, 'a tile starts inside the field');
  }
  const mean = (picked: (x: number) => boolean) => {
    const starts = tiles.flatMap((tile, i) => picked(tile.x) ? [delays(entering[i].style.animation)[0]] : []);
    return starts.reduce((sum, start) => sum + start, 0) / starts.length;
  };
  assert(mean((x) => x < width / 4) < mean((x) => x > width * 3 / 4), 'the right slides in before the left');
});

Deno.test('the setting is one of the entrances, or not', () => {
  assert(isHatEntrance('drawn') && isHatEntrance('wave'));
  assert(!isHatEntrance('none') && !isHatEntrance('') && !isHatEntrance(undefined) && !isHatEntrance('pen'));
});
