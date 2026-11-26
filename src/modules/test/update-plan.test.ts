/**
 * What updating a module takes along: the dependents a new major leaves behind and the
 * dependencies a new release asks more of, when they have a newer version that accepts it, and
 * what holds the update when they have none; what is broken already is left out.
 */

import { assertEquals } from '@std/assert';
import { type Manifested, updatesTogether } from '../update-plan.ts';

const modules = (entries: Record<string, [string, Record<string, string>?]>): Map<string, Manifested> =>
  new Map(Object.entries(entries).map(([name, [version, dependencies]]) => [name, { version, dependencies: dependencies ?? {} }]));

const installed = modules({
  base: ['0.4.0'],
  keel: ['0.20.5', { base: '^0.4.0' }],
  mast: ['0.15.0', { keel: '^0.20.0' }],
  sail: ['0.16.2', { keel: '^0.20.0', base: '^0.4.0' }],
  flag: ['1.0.0'],
});

Deno.test('update-plan', async (t) => {
  await t.step('an update every installed range accepts goes alone', () => {
    assertEquals(updatesTogether('flag', installed, modules({ flag: ['1.1.0'] })), { with: [], held: [] });
    assertEquals(updatesTogether('keel', installed, modules({ keel: ['0.20.6', { base: '^0.4.0' }] })), { with: [], held: [] });
  });

  await t.step('a new major takes along the dependents whose newer versions accept it', () => {
    const newer = modules({ keel: ['0.21.0', { base: '^0.4.0' }], mast: ['0.16.0', { keel: '^0.21.0' }], sail: ['0.17.0', { keel: '^0.21.0', base: '^0.4.0' }] });
    assertEquals(updatesTogether('keel', installed, newer), { with: ['mast', 'sail'], held: [] });
    // From the dependent's side: it needs the new major, which needs its other dependent too.
    assertEquals(updatesTogether('mast', installed, newer), { with: ['keel', 'sail'], held: [] });
  });

  await t.step('a dependent with nothing newer that accepts it holds the update', () => {
    const newer = modules({ keel: ['0.21.0', { base: '^0.4.0' }], mast: ['0.16.0', { keel: '^0.21.0' }] });
    assertEquals(updatesTogether('keel', installed, newer), {
      with: ['mast'],
      held: ['sail 0.16.2 needs keel ^0.20.0, and nothing newer of sail takes keel 0.21.0'],
    });
  });

  await t.step('a dependency asked a newer version comes along, or holds it when it has none', () => {
    const asking: Record<string, [string, Record<string, string>]> = { keel: ['0.20.6', { base: '^0.5.0' }] };
    assertEquals(updatesTogether('keel', installed, modules({ ...asking, base: ['0.5.0'] })), {
      with: ['base'],
      // The dependency's new version leaves another of its dependents behind in turn.
      held: ['sail 0.16.2 needs base ^0.4.0, and nothing newer of sail takes base 0.5.0'],
    });
    assertEquals(updatesTogether('keel', installed, modules({ ...asking, base: ['0.5.0'], sail: ['0.17.0', { keel: '^0.20.0', base: '^0.5.0' }] })), {
      with: ['base', 'sail'],
      held: [],
    });
    assertEquals(updatesTogether('keel', installed, modules({ ...asking })), {
      with: [],
      held: ['keel 0.20.6 needs base ^0.5.0, and base 0.4.0 is installed, with nothing newer to update it to'],
    });
    // Its newest does not reach the range either.
    assertEquals(updatesTogether('keel', installed, modules({ ...asking, base: ['0.4.1'] })), {
      with: ['base'],
      held: ['keel 0.20.6 needs base ^0.5.0, and the newest of base is 0.4.1'],
    });
  });

  await t.step('a range broken already, or a dependency not installed, holds nothing', () => {
    const broken = modules({ ...Object.fromEntries([...installed].map(([name, m]) => [name, [m.version!, { ...m.dependencies }]])), flag: ['1.0.0', { keel: '^9.0.0' }] });
    assertEquals(updatesTogether('mast', broken, modules({ mast: ['0.15.1', { keel: '^0.20.0', anchor: '^1.0.0' }] })), { with: [], held: [] });
  });
});
