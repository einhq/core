/**
 * VFS event emission — the foundation the pipeline engine trusts.
 * Events are also published on the system.vfs routing key.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { NodeEvent } from '../mod.ts';
import { mkdir, mkfile } from './helpers.ts';

Deno.test('VFS events', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, routerManager } = ctx;

  const events: NodeEvent[] = [];
  const routed: { routingKey: string; payload: unknown }[] = [];

  const sub = await vfs.subscribe!(() => ADMIN_ACCESS, async (event) => {
    events.push(event);
  });

  const unsubscribeRouter = routerManager.on(async (routingKey, payload) => {
    routed.push({ routingKey, payload });
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for event');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  try {
    await t.step('create emits created', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'watched');
      await mkfile(vfs, ADMIN_ACCESS, '/watched', 'f.txt', 'v1');

      await waitFor(() => events.some((e) => e.type === 'created' && e.path === '/watched/f.txt'));
    });

    // Membership events name the container, so a consumer that cares about one
    // kind of container binds `system.vfs.<that type>.child-attached` and sees
    // every way a child can arrive there — `create` here, `link` and `mv` below.
    await t.step('create emits child-attached on the parent', async () => {
      await waitFor(() => events.some((e) => e.type === 'child-attached' && e.path === '/watched'));

      const attached = events.find((e) => e.type === 'child-attached' && e.path === '/watched')!;
      assertEquals(attached.node.type, 'directory');
      await waitFor(() => routed.some((r) => r.routingKey === 'system.vfs.directory.child-attached'));
      assertEquals(routed.some((r) => r.routingKey === 'system.vfs.file.child-attached'), false);
    });

    await t.step('link emits child-attached on the new parent', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'linked');
      await vfs.link(ADMIN_ACCESS, '/watched/f.txt', '/linked', 'f.txt');

      await waitFor(() => events.some((e) => e.type === 'child-attached' && e.path === '/linked'));
      await vfs.unlink(ADMIN_ACCESS, '/linked/f.txt', '/linked');
    });

    await t.step('update emits updated with previous state', async () => {
      await vfs.update(ADMIN_ACCESS, '/watched/f.txt', { attrs: { mimetype: 'text/x-updated' } });

      // The content write may emit its own updated events; match the one
      // carrying this specific transition
      await waitFor(() =>
        events.some((e) =>
          e.type === 'updated' && e.node.attrs.mimetype === 'text/x-updated' &&
          e.previousNode?.attrs.mimetype === 'text/plain'
        )
      );
    });

    // The published form is slim — identity only — except for the one thing a
    // subscriber cannot recover by reading the node fresh: which attrs moved.
    await t.step('the published updated event names the attrs that changed', async () => {
      await waitFor(() => routed.some((r) => r.routingKey === 'system.vfs.file.updated' && (r.payload as { changedAttrs?: string[] }).changedAttrs?.includes('mimetype')));

      const payload = routed.find((r) => r.routingKey === 'system.vfs.file.updated' && (r.payload as { changedAttrs?: string[] }).changedAttrs?.includes('mimetype'))!
        .payload as { changedAttrs: string[] };
      assertEquals(payload.changedAttrs, ['mimetype']);
    });

    await t.step('mv across parents emits child-detached on the old parent and child-attached on the new', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'elsewhere');
      await vfs.rename(ADMIN_ACCESS, '/watched', 'f.txt', '/elsewhere', 'f.txt');

      await waitFor(() => events.some((e) => e.type === 'child-attached' && e.path === '/elsewhere'));
      assertEquals(events.some((e) => e.type === 'child-detached' && e.path === '/watched'), true);

      await vfs.rename(ADMIN_ACCESS, '/elsewhere', 'f.txt', '/watched', 'f.txt');
    });

    await t.step('rename emits moved, and says where from', async () => {
      await vfs.rename(ADMIN_ACCESS, '/watched', 'f.txt', '/watched', 'g.txt');

      await waitFor(() => events.some((e) => e.type === 'moved' && e.path === '/watched/g.txt'));
      assertEquals(events.find((e) => e.type === 'moved' && e.path === '/watched/g.txt')!.fromPath, '/watched/f.txt');
      const published = (r: { routingKey: string; payload: unknown }) => r.routingKey === 'system.vfs.file.moved' && (r.payload as { path: string }).path === '/watched/g.txt';
      await waitFor(() => routed.some(published));
      assertEquals((routed.find(published)!.payload as { fromPath?: string }).fromPath, '/watched/f.txt');
    });

    await t.step('unlink emits deleted', async () => {
      await vfs.unlink(ADMIN_ACCESS, '/watched/g.txt', '/watched');

      await waitFor(() => events.some((e) => e.type === 'deleted'));
    });

    await t.step('the published deleted event carries the attrs the node had', async () => {
      await waitFor(() => routed.some((r) => r.routingKey === 'system.vfs.file.deleted'));

      const deleted = events.find((e) => e.type === 'deleted')!;
      const payload = routed.find((r) => r.routingKey === 'system.vfs.file.deleted')!.payload as { attrs: Record<string, unknown> };
      assertEquals(payload.attrs, deleted.node.attrs);
      assertEquals(typeof payload.attrs.mimetype, 'string');
    });

    // Granular keys are what let a durable consumer bind only what it can act on: it binds the
    // handful it wants, or a pattern over them.
    await t.step('events are published on system.vfs.<nodeType>.<eventType>', async () => {
      await waitFor(() => routed.some((r) => r.routingKey === 'system.vfs.file.deleted'));

      assertEquals(routed.some((r) => r.routingKey === 'system.vfs.directory.created'), true);
      assertEquals(routed.some((r) => r.routingKey === 'system.vfs.file.created'), true);
      // The coarse key must be gone, or every consumer pays for every mutation
      assertEquals(routed.some((r) => r.routingKey === 'system.vfs'), false);
    });

    // What a pattern-bound router node is for: watching the mutation stream without knowing which
    // node types will show up in it.
    await t.step('a router node bound to system.vfs.# tails the whole stream', async () => {
      await vfs.create(ADMIN_ACCESS, 'router', '/', 'vfs-tail', { attrs: { routingKey: 'system.vfs.#' } });

      const handle = await vfs.open(ADMIN_ACCESS, '/vfs-tail', { mode: 'r' });
      const seen: { type: string; nodeType: string; path: string }[] = [];

      try {
        // A live tail, so it reads in a loop rather than once: the node's own creation is itself a
        // `system.vfs.router.created` the pattern covers, and it is already in flight.
        const collect = (async () => {
          while (!seen.some((line) => line.path === '/tailed')) {
            const data = await handle.read(1, AbortSignal.timeout(2000));

            if (data.length === 0) {
              break; // aborted — the assertions below report what did arrive
            }

            seen.push(JSON.parse(new TextDecoder().decode(data).trim()));
          }
        })();

        await mkdir(vfs, ADMIN_ACCESS, '/', 'tailed');
        await collect;

        const created = seen.find((line) => line.path === '/tailed');

        assertEquals(created?.type, 'created');
        assertEquals(created?.nodeType, 'directory');
        // Two node types down one binding is the whole point; an exact key gives one.
        assertEquals(seen.some((line) => line.nodeType === 'router'), true);
      } finally {
        await handle.close();
      }
    });
  } finally {
    await sub.unsubscribe();
    unsubscribeRouter();
    await ctx.dispose();
  }
});

/**
 * A handler may write to the VFS: it runs after the emitting mutation has left
 * its transaction and id-lock set. On the memory store only the lock half
 * applies — the store's transactions are no-ops — so this touches the *parent*,
 * whose lock the emitting create holds.
 */
Deno.test('VFS events: a handler may write to the VFS', async () => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  await mkdir(vfs, ADMIN_ACCESS, '/', 'watched');

  const sub = await vfs.subscribe!(() => ADMIN_ACCESS, async (event) => {
    await vfs.update(ADMIN_ACCESS, '/watched', { attrs: { seen: event.path } });
  }, { eventTypes: ['created'], pathPrefix: '/watched' });

  try {
    // A deadlock here is a hang, not a failure, so bound it
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('handler write deadlocked')), 5000);
    });

    try {
      await Promise.race([mkdir(vfs, ADMIN_ACCESS, '/watched', 'child'), stuck]);
    } finally {
      clearTimeout(timer);
    }

    // Handlers are awaited, so the mutation does not return until they are done
    const watched = await vfs.get(ADMIN_ACCESS, '/watched');
    assertEquals(watched.attrs.seen, '/watched/child');
  } finally {
    await sub.unsubscribe();
    await ctx.dispose();
  }
});
