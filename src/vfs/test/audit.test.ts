/**
 * The VFS audit trail: every node write leaves a record naming who did it, in the write's own
 * transaction; the trail reads back through the router-only root production mounts the data at.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { type Access, ADMIN_ACCESS, modeUnder } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { AUDIT_VALUE_MAX_BYTES } from '../audit.ts';
import type { NodeEvent } from '../types.ts';
import { mkdir, mkfile } from './helpers.ts';

const ANNA: Access = { uid: 1003, gid: 1003, gids: [1003], sid: 'session-anna' };

Deno.test('VFS audit trail', async (t) => {
  const ctx = await createTestVfs({ rootMount: true });
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'shared', 0o777);

    await t.step('records a create with who, session, path and attrs', async () => {
      await vfs.create(ANNA, 'directory', '/shared', 'trip', { attrs: { title: 'A sailboat' } });

      const [record] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/shared/trip', op: 'create' });
      assertEquals(record.uid, ANNA.uid);
      assertEquals(record.sid, 'session-anna');
      assertEquals(record.path, '/shared/trip');
      assertEquals(record.nodeType, 'directory');
      assertEquals(record.attrs, { title: { to: 'A sailboat' } });
    });

    await t.step('records an update with the values it changed', async () => {
      await vfs.update(ANNA, '/shared/trip', { attrs: { title: 'Two sailboats', note: 'x' }, props: { mode: 0o700 } });

      const [record] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/shared/trip', op: 'update' });
      assertEquals(record.attrs, {
        title: { from: 'A sailboat', to: 'Two sailboats' },
        note: { to: 'x' },
      });
      const created = modeUnder((await vfs.get(ADMIN_ACCESS, '/shared')).props.mode);
      assertEquals(record.props, { mode: { from: created, to: 0o700 } });
    });

    await t.step('replaces an oversized value by its size', async () => {
      const big = 'x'.repeat(AUDIT_VALUE_MAX_BYTES + 1);
      await vfs.update(ANNA, '/shared/trip', { attrs: { note: big } });

      const [record] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/shared/trip', op: 'update', limit: 1 });
      assertEquals(record.attrs!.note, { from: 'x', to: { truncated: true, bytes: AUDIT_VALUE_MAX_BYTES + 3 } });
    });

    await t.step('records a move with both paths, found under either', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'archive', 0o777);
      await vfs.rename(ADMIN_ACCESS, '/shared', 'trip', '/archive', 'trip');

      const [fromOld] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/shared', op: 'move' });
      const [fromNew] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/archive', op: 'move' });
      assertEquals(fromOld.id, fromNew.id);
      assertEquals(fromOld.fromPath, '/shared/trip');
      assertEquals(fromOld.path, '/archive/trip');
      assertEquals(fromOld.uid, ADMIN_ACCESS.uid);
    });

    await t.step('tells a dropped name from a deleted node', async () => {
      const node = await mkfile(vfs, ADMIN_ACCESS, '/archive', 'a.txt', 'data');
      await vfs.link(ADMIN_ACCESS, '/archive/a.txt', '/shared', 'b.txt');
      await vfs.unlink(ADMIN_ACCESS, '/archive/a.txt', '/archive');
      await vfs.unlink(ADMIN_ACCESS, '/shared/b.txt', '/shared');

      const ops = (await vfs.audit(ADMIN_ACCESS, { nodeId: node.id })).map((r) => `${r.op} ${r.path}`).reverse();
      assertEquals(ops, [
        'create /archive/a.txt',
        // The content write lands as the size/sha256 update.
        'update /archive/a.txt',
        'link /shared/b.txt',
        'unlink /archive/a.txt',
        'delete /shared/b.txt',
      ]);

      const [deleted] = await vfs.audit(ADMIN_ACCESS, { nodeId: node.id, op: 'delete' });
      assertEquals((deleted.attrs!.name as { from: unknown }).from, 'a.txt');
    });

    await t.step('filters by user and newest first with a limit', async () => {
      const mine = await vfs.audit(ADMIN_ACCESS, { uid: ANNA.uid });
      assertEquals(mine.every((r) => r.uid === ANNA.uid), true);
      assertEquals(mine.length, 3);

      const [latest] = await vfs.audit(ADMIN_ACCESS, { limit: 1 });
      assertEquals(latest.op, 'delete');
    });

    await t.step('reads forward after an id, oldest first, by node type', async () => {
      const [mark] = await vfs.audit(ADMIN_ACCESS, { limit: 1 });
      await mkdir(vfs, ADMIN_ACCESS, '/archive', 'forward', 0o777);
      await mkfile(vfs, ADMIN_ACCESS, '/archive/forward', 'one.txt', 'one');
      await mkfile(vfs, ADMIN_ACCESS, '/archive/forward', 'two.txt', 'two');

      const after = await vfs.audit(ADMIN_ACCESS, { after: mark.id, pathPrefix: '/archive/forward' });
      assertEquals(after.map((r) => r.id), after.map((r) => r.id).toSorted());
      assertEquals(after[0].path, '/archive/forward');
      assertEquals(after.every((r) => r.id > mark.id), true);

      const files = await vfs.audit(ADMIN_ACCESS, { after: mark.id, nodeTypes: ['file'], op: 'create' });
      assertEquals(files.map((r) => r.path), ['/archive/forward/one.txt', '/archive/forward/two.txt']);
      // Following the trail: the last id read is where the next read starts.
      const [first] = await vfs.audit(ADMIN_ACCESS, { after: mark.id, nodeTypes: ['file'], op: 'create', limit: 1 });
      const rest = await vfs.audit(ADMIN_ACCESS, { after: first.id, nodeTypes: ['file'], op: 'create' });
      assertEquals([first.path, ...rest.map((r) => r.path)], ['/archive/forward/one.txt', '/archive/forward/two.txt']);
      assertEquals(await vfs.audit(ADMIN_ACCESS, { after: rest[rest.length - 1].id, nodeTypes: ['file'], op: 'create' }), []);
    });

    await t.step('an update that changes nothing leaves no record', async () => {
      const node = await vfs.get(ADMIN_ACCESS, '/archive/trip');
      const before = (await vfs.audit(ADMIN_ACCESS, { nodeId: node.id })).length;
      await vfs.update(ADMIN_ACCESS, '/archive/trip', { props: { mode: node.props.mode } });
      assertEquals((await vfs.audit(ADMIN_ACCESS, { nodeId: node.id })).length, before);
    });

    await t.step('records a softlink retarget', async () => {
      const link = await vfs.create(ADMIN_ACCESS, 'softlink', '/archive', 'pointer', { props: { mode: 0o777, softlink: '/archive/trip' } });
      await vfs.update(ADMIN_ACCESS, '/archive/pointer', { readlink: true, props: { softlink: '/shared' } });

      const [record] = await vfs.audit(ADMIN_ACCESS, { nodeId: link.id, op: 'update' });
      assertEquals(record.props, { softlink: { from: '/archive/trip', to: '/shared' } });
    });

    await t.step('records a change of who else has access', async () => {
      const node = await vfs.update(ADMIN_ACCESS, '/archive/trip', { props: { acl: [{ gid: 1003, mode: 0o5 }] } });

      const [record] = await vfs.audit(ADMIN_ACCESS, { nodeId: node.id, op: 'update', limit: 1 });
      assertEquals(record.props, { acl: { to: [{ gid: 1003, mode: 0o5 }] } });
    });

    await t.step('a failed write leaves no record', async () => {
      const before = (await vfs.audit(ADMIN_ACCESS, { limit: 1 }))[0].id;
      await assertRejects(() => vfs.create(ANNA, 'directory', '/archive', 'trip'));
      assertEquals((await vfs.audit(ADMIN_ACCESS, { limit: 1 }))[0].id, before);
    });

    await t.step('is for administrators only', async () => {
      await assertRejects(() => vfs.audit(ANNA, {}));
    });

    await t.step('an event names the record its write left', async () => {
      const events: NodeEvent[] = [];
      const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
        events.push(event);
      });
      try {
        const node = await vfs.create(ANNA, 'directory', '/shared', 'upload');
        const [record] = await vfs.audit(ADMIN_ACCESS, { nodeId: node.id });
        const created = events.find((e) => e.type === 'created' && e.node.id === node.id);
        assertEquals(created?.auditId, record.id);
      } finally {
        await sub.unsubscribe();
      }
    });

    await t.step('records the run and cause a write came from, and finds by both', async () => {
      const [upload] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/shared/upload', op: 'create' });
      const step: Access = { ...ADMIN_ACCESS, sid: 'pipeline:derive/n1', cause: upload.id };
      await vfs.create(step, 'directory', '/shared/upload', 'thumbnail');

      const [derived] = await vfs.audit(ADMIN_ACCESS, { cause: upload.id });
      assertEquals([derived.path, derived.sid, derived.cause], ['/shared/upload/thumbnail', 'pipeline:derive/n1', upload.id]);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { id: upload.id })).map((r) => r.path), ['/shared/upload']);
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test('VFS audit trail skips the unaudited subtrees', async () => {
  const ctx = await createTestVfs({ rootMount: true, unaudited: ['/var'] });
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'var', 0o777);
    await mkdir(vfs, ADMIN_ACCESS, '/', 'archive', 0o777);
    const step = await vfs.create(ADMIN_ACCESS, 'directory', '/var', 'step', { attrs: { status: 'running' } });
    await vfs.update(ADMIN_ACCESS, '/var/step', { attrs: { status: 'done' } });
    assertEquals(await vfs.audit(ADMIN_ACCESS, { nodeId: step.id }), []);

    // Leaving the subtree is a write to what the trail covers.
    await vfs.rename(ADMIN_ACCESS, '/var', 'step', '/archive', 'step');
    const ops = (await vfs.audit(ADMIN_ACCESS, { nodeId: step.id })).map((r) => `${r.op} ${r.fromPath} ${r.path}`);
    assertEquals(ops, ['move /var/step /archive/step']);

    const [archive] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/archive', op: 'create' });
    assertEquals(archive.path, '/archive');
  } finally {
    await ctx.dispose();
  }
});
