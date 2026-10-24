/** `stats-overview`: per-type archive growth. The life events beside it are people's (`person-stats`). */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';
import { EXCLUDED_NODE_TYPES, type StatsOverview } from '../system/stats-overview.ts';

const testCtx = createTestContext();

Deno.test({
  name: 'stats-overview command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mkperson = (slug: string, attrs: Record<string, unknown>, created = '2008-01-01T00:00:00Z') =>
    vfs.create(ADMIN_ACCESS, 'person', '/archive/people', slug, {
      props: { mode: 0o755, birthtime: { uid: 0, timestamp: Date.parse(created) } },
      attrs,
    });

  const mkevent = async (owner: string, slug: string, eventType: string, date: string) => {
    await vfs.ensure(ADMIN_ACCESS, 'directory', owner, 'events', { props: { mode: 0o775 } });
    return await vfs.create(ADMIN_ACCESS, 'file', `${owner}/events`, slug, {
      props: { mode: 0o644, tier: 'db' },
      attrs: { eventType, date, mimetype: 'text/markdown', size: 0 },
    });
  };

  try {
    await cmd.shouldSucceed(`mkdir -p /archive/people`);

    await t.step('does not depend on the metrics sampler', async () => {
      const overview = await client.execJson<StatsOverview>('stats-overview');
      assertEquals(overview.nodeTypes.some((series) => EXCLUDED_NODE_TYPES.has(series.type)), false);
    });

    await mkperson('january', { born: '1980-01-12', died: '2020-01' }, '2008-09-29T08:24:46Z');
    await mkperson('summer', { born: '1985-07-02' }, '2013-01-23T21:53:36Z');
    await mkperson('partial', { born: '1901', died: '1975' }, '2017-02-26T14:32:14Z');
    await mkevent(`/archive/people/january`, 'engaged', 'engagement', '2001-02-14');
    await mkevent(`/archive/people/january`, 'married', 'marriage', '2002-07-20T14:00');
    await mkevent(`/archive/people/summer`, 'unknown-wedding-month', 'marriage', '1950');
    await mkevent(`/archive/people/summer`, 'other', 'generic', '2002-07-20');

    await cmd.shouldSucceed('mkdir -p /files');
    await vfs.create(ADMIN_ACCESS, 'file', '/files', 'original.jpg', {
      props: { mode: 0o644, birthtime: { uid: 0, timestamp: Date.parse('2009-03-10T12:00:00Z') } },
      attrs: { mimetype: 'image/jpeg', size: 100 },
    });
    await vfs.create(ADMIN_ACCESS, 'file', '/files', 'derivative.avif', {
      props: { mode: 0o644, birthtime: { uid: 0, timestamp: Date.parse('2010-04-20T12:00:00Z') } },
      attrs: { mimetype: 'image/avif', size: 250, sourceId: 'original-node' },
    });
    await vfs.create(ADMIN_ACCESS, 'group', '/', 'excluded-group', {
      props: { mode: 0o755, birthtime: { uid: 0, timestamp: Date.parse('2007-01-01T00:00:00Z') } },
    });
    for (const type of ['softlink', 'exif', 'embedding']) {
      await vfs.create(ADMIN_ACCESS, type, '/', `excluded-${type}`, {
        props: { mode: 0o755, birthtime: { uid: 0, timestamp: Date.parse('2007-01-01T00:00:00Z') } },
      });
    }

    await t.step('groups every useful type by birthtime and includes derivative file bytes', async () => {
      const overview = await client.execJson<StatsOverview>('stats-overview');
      assertEquals(overview.nodeTypes[0].type, 'file');
      assertEquals(overview.nodeTypes.some((series) => EXCLUDED_NODE_TYPES.has(series.type)), false);

      const people = overview.nodeTypes.find((series) => series.type === 'person');
      assertEquals(people?.years.find((point) => point.year === '2008')?.count, 1);
      assertEquals(people?.years.find((point) => point.year === '2013')?.count, 1);
      assertEquals(people?.years.find((point) => point.year === '2017')?.count, 1);
      assertEquals(people?.months.every((point, index) => index === 0 || point.total >= people.months[index - 1].total), true);

      const files = overview.nodeTypes.find((series) => series.type === 'file');
      assertEquals(files?.years.find((point) => point.year === '2009')?.bytes, 100);
      assertEquals(files?.years.find((point) => point.year === '2010')?.bytes, 250);
      assertEquals((files?.totalBytes ?? 0) >= 350, true);
      assertEquals(files?.months.every((point, index) => index === 0 || point.totalBytes >= files.months[index - 1].totalBytes), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
