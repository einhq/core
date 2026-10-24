import { assert, assertEquals } from '@std/assert';
import { hatIdenticon, initialsOf } from '../hat-identicon.ts';
import { HAT_CLUSTER, HAT_POINTS } from '../hat.ts';

Deno.test('initials are the first letters of the first and last words', () => {
  assertEquals(initialsOf('Anna Andersson'), 'AA');
  assertEquals(initialsOf('Anna B Andersson-Berg'), 'AB');
  assertEquals(initialsOf('? Berg'), 'B');
  assertEquals(initialsOf('canon_eos_350d'), 'C3');
  assertEquals(initialsOf('   '), '');
});

Deno.test('one seed always draws the same identicon, and seeds vary', () => {
  assertEquals(hatIdenticon('/archive/people/anna'), hatIdenticon('/archive/people/anna'));
  const specs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((seed) => hatIdenticon(seed));
  assert(specs.every((spec) => spec.rotation % 60 === 0 && spec.rotation < 360 && spec.lit >= 0 && spec.lit < 4));
  assert(new Set(specs.map((spec) => `${spec.rotation}/${spec.mirror}/${spec.lit}`)).size >= 5);
});

Deno.test('every turn and mirror of the cluster fits inside its own box', () => {
  const hat = HAT_POINTS.split(' ').map((pair) => pair.split(',').map(Number));
  const cluster = HAT_CLUSTER.map((matrix) => matrix.slice('matrix('.length, -1).split(' ').map(Number));
  const seen = new Set<string>();
  for (let i = 0; seen.size < 12 && i < 2000; i++) {
    const spec = hatIdenticon(`seed-${i}`);
    const key = `${spec.rotation}/${spec.mirror}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The transform string, applied the way SVG does: the rightmost step first.
    const [, angle, cx, cy] = spec.transform.match(/rotate\((\S+) (\S+) (\S+)\)/)!.map(Number);
    const shift = Number(spec.transform.match(/translate\((\S+) 0\) scale\(-1 1\)/)?.[1] ?? NaN);
    const [left, top, width, height] = spec.viewBox.split(' ').map(Number);
    for (const [a, b, c, d, e, f] of cluster) {
      for (const [x, y] of hat) {
        let px = a * x + c * y + e;
        const py = b * x + d * y + f;
        if (spec.mirror) px = shift - px;
        const rad = (angle * Math.PI) / 180;
        const tx = cx + (px - cx) * Math.cos(rad) - (py - cy) * Math.sin(rad);
        const ty = cy + (px - cx) * Math.sin(rad) + (py - cy) * Math.cos(rad);
        assert(tx >= left && tx <= left + width && ty >= top && ty <= top + height, `${key}: (${tx}, ${ty}) outside ${spec.viewBox}`);
      }
    }
  }
  assertEquals(seen.size, 12);
});
