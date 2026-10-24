/**
 * `completion-entity`: the name lookup behind the search box's `@`-mentions.
 *
 * The behaviour that matters here is ranking and scope — a completion inserts a
 * label, so it must offer the thing actually *called* that, and must not offer
 * something that merely lives under an entity root.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';
import { registerContributions } from '../../../../lib/contributions/registry.ts';
import type { EntityCompleteResult } from '../../../../lib/api/mod.ts';

const testCtx = createTestContext({ boot: true });

type Result = EntityCompleteResult;

const names = (r: Result) => r.results.map((hit) => hit.name);

Deno.test({
  name: 'completion-entity',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    // What archive declares (`mod.json` `nodeTypes` with a root); this test is that module.
    registerContributions('test-entities', {
      nodeTypes: [
        { type: 'person', root: '/archive/people' },
        { type: 'location', root: '/archive/locations' },
        { type: 'album', root: '/archive/albums' },
        { type: 'device', root: '/archive/devices' },
      ],
    });
    await cmd.shouldSucceed(`mkdir -p /archive/people && mkdir -p /archive/locations && mkdir -p /archive/albums && mkdir -p /archive/devices`);

    await vfs.create(ADMIN_ACCESS, 'person', '/archive/people', 'Erik_J_Strand', { attrs: { name: 'Erik J Strand-Berg' } });
    await vfs.create(ADMIN_ACCESS, 'person', '/archive/people', 'anna', { attrs: { name: 'Anna Lindberg' } });
    await vfs.create(ADMIN_ACCESS, 'person', '/archive/people', 'matilda', { attrs: { name: 'Matilda Berg' } });
    await vfs.create(ADMIN_ACCESS, 'location', '/archive/locations', 'grebbestad', { attrs: { name: 'Grebbestad' } });
    await vfs.create(ADMIN_ACCESS, 'album', '/archive/albums', 'mat-och-dryck', { attrs: { name: 'Mat och dryck' } });

    await t.step('a prefix offers the names that start with it, best first', async () => {
      const out = await client.execJson<Result>('completion-entity mat');
      // "Mat och dryck" and "Matilda Berg" both start with it; "Erik J
      // Strand-Berg" and "Grebbestad" do not.
      assertEquals(out.results.every((hit) => hit.score > 0), true);
      assertEquals(names(out).includes('Matilda Berg'), true);
      assertEquals(names(out).includes('Mat och dryck'), true);
    });

    await t.step('an exact name is the top hit', async () => {
      const out = await client.execJson<Result>('completion-entity grebbestad');
      assertEquals(out.results[0].name, 'Grebbestad');
      assertEquals(out.results[0].score, 1);
      assertEquals(out.results[0].kind, 'location');
    });

    await t.step('a surname is found by its word, not only by the full name', async () => {
      // How people actually search: the label starts with a first name, but the
      // word typed is the family name.
      const out = await client.execJson<Result>('completion-entity strand');
      assertEquals(out.results[0].name, 'Erik J Strand-Berg');
    });

    await t.step('a name is found by its words in order, a middle one left out', async () => {
      const person = await client.execJson<Result>('completion-entity erik strand --kind person');
      assertEquals(person.results[0].name, 'Erik J Strand-Berg');
      assertEquals(person.results[0].score, 0.9);
      // From a later word, the words still in order: a word prefix.
      assertEquals((await client.execJson<Result>('completion-entity j berg --kind person')).results[0].score, 0.7);
      // Out of order, the words are no match of that kind.
      const reversed = await client.execJson<Result>('completion-entity strand erik --kind person');
      assertEquals((reversed.results[0]?.score ?? 0) < 0.7, true);
    });

    await t.step('--kind narrows to one root', async () => {
      const out = await client.execJson<Result>('completion-entity mat --kind album');
      assertEquals(names(out), ['Mat och dryck']);
    });

    await t.step('an unnamed node falls back to its slug, which is then its label', async () => {
      await vfs.create(ADMIN_ACCESS, 'person', '/archive/people', 'bosse_karlsson');
      const out = await client.execJson<Result>('completion-entity bosse --kind person');
      assertEquals(names(out), ['bosse_karlsson']);
    });

    await t.step('both the stored name and attrs.name find the displayed entity', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', '/archive/albums', 'M', { attrs: { name: 'Realskolan' } });
      assertEquals(names(await client.execJson<Result>('completion-entity m --kind album')).includes('Realskolan'), true);
      assertEquals(names(await client.execJson<Result>('completion-entity realskolan --kind album')), ['Realskolan']);
    });

    await t.step('a compact fuzzy match finds a name with omitted characters', async () => {
      assertEquals(names(await client.execJson<Result>('completion-entity mtlb --kind person')), ['Matilda Berg']);
    });

    await t.step('one populous kind cannot fill the list', async () => {
      // Many albums and one person matching the same word: the person is still offered.
      for (let i = 0; i < 12; i++) {
        await vfs.create(ADMIN_ACCESS, 'album', '/archive/albums', `zeta-${i}`, { attrs: { name: `Zeta ${i}` } });
      }
      await vfs.create(ADMIN_ACCESS, 'person', '/archive/people', 'zeta_person', { attrs: { name: 'Zeta Persson' } });
      const out = await client.execJson<Result>('completion-entity zeta -l 6');
      assertEquals(out.results.some((hit) => hit.kind === 'person'), true, 'the person was crowded out');
    });

    await t.step('a name with a word left out is not crowded out by names it starts', async () => {
      // Albums called after the person, which "erik strand" is a plain prefix of.
      for (let i = 0; i < 8; i++) {
        await vfs.create(ADMIN_ACCESS, 'album', '/archive/albums', `erik-strand-${i}`, { attrs: { name: `Erik Strand i Grebbestad ${i}` } });
      }
      const out = await client.execJson<Result>('completion-entity erik strand -l 6');
      assertEquals(names(out).includes('Erik J Strand-Berg'), true, 'the person was crowded out');
    });

    await t.step('only the top level of a root is an entity', async () => {
      // A person's events live under them; none of that is a person.
      await cmd.shouldSucceed(`mkdir -p /archive/people/anna/events`);
      await vfs.create(ADMIN_ACCESS, 'person', `/archive/people/anna/events`, 'anna-jr', { attrs: { name: 'Anna Junior' } });
      const out = await client.execJson<Result>('completion-entity anna --kind person');
      assertEquals(names(out), ['Anna Lindberg']);
    });

    await t.step('no match is an empty list, not an error', async () => {
      assertEquals((await client.execJson<Result>('completion-entity kajakpaddling')).results, []);
    });

    await t.step('a hit carries who may change it, with its access list', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', '/archive/albums', 'segling', {
        attrs: { name: 'Segling' },
        props: { mode: 0o750, uid: 7, gid: 8, acl: [{ uid: 9, mode: 0o7 }] },
      });
      const out = await client.execJson<Result>('completion-entity segling --kind album');
      assertEquals(out.results[0].ownership, { mode: 0o750, uid: 7, gid: 8, acl: [{ uid: 9, mode: 0o7 }] });
    });

    await t.step('an empty query asks for nothing rather than everything', async () => {
      assertEquals((await client.execJson<Result>('completion-entity')).results, []);
    });

    await t.step('an unknown kind is rejected rather than ignored', async () => {
      await cmd.shouldFailWith('completion-entity mat --kind unicorn', "unknown kind 'unicorn'");
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
