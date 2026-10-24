/**
 * `createTree`: a subtree written as one transaction, announced after it
 * commits.
 *
 * The properties worth pinning are the two the pipeline engine depends on — a
 * subscriber never observes a partly-built tree, and a failure part-way leaves
 * nothing behind — plus the access and collision behaviour of `create`, which
 * runs through the same code.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { type Access, ADMIN_ACCESS, modeUnder } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError, NodeAlreadyExistsError, type NodeEvent, type NodeTreeSpec } from '../mod.ts';
import { mkdir } from './helpers.ts';

const dir = (name: string, children?: NodeTreeSpec[]): NodeTreeSpec => ({
  type: 'directory',
  name,
  attrs: { name },
  children,
});

/** An instance, in the shape the pipeline engine writes it. */
const instance = (id: string, steps: string[]): NodeTreeSpec => dir(id, [dir('steps', steps.map((step) => dir(step)))]);

Deno.test('VFS createTree', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'instances');

    await t.step('writes the whole subtree and returns its roots', async () => {
      const [root] = await vfs.createTree(ADMIN_ACCESS, '/instances', [instance('a', ['one', 'two'])]);

      assertEquals(root.attrs.name, 'a');
      assertEquals(root.props.count, 1);
      // `/instances` is 0755, so others keep read and traverse all the way down.
      assertEquals(root.props.mode, modeUnder(0o755));

      const steps = await vfs.children(ADMIN_ACCESS, '/instances/a/steps');
      assertEquals(steps.map((step) => step.name).sort(), ['one', 'two']);
      assertEquals(steps.map((step) => step.node.props.mode), [modeUnder(root.props.mode), modeUnder(root.props.mode)]);
    });

    await t.step('an explicit mode overrides the VFS default', async () => {
      const [root] = await vfs.createTree(ADMIN_ACCESS, '/instances', [{ ...dir('private'), props: { mode: 0o700 } }]);

      assertEquals(root.props.mode, 0o700);
    });

    await t.step('several roots, in spec order', async () => {
      const created = await vfs.createTree(ADMIN_ACCESS, '/instances', [dir('b'), dir('c')]);

      assertEquals(created.map((node) => node.attrs.name), ['b', 'c']);
    });

    await t.step('siblings are made in one store call, however many there are', async () => {
      const { store } = ctx;
      const calls = { createNode: 0, createNodes: 0 };
      let batching = false;
      const createNode = store.createNode.bind(store);
      const createNodes = store.createNodes.bind(store);
      // This store makes a batch one node at a time; only the VFS's own calls are counted.
      store.createNode = (...args) => {
        if (!batching) calls.createNode++;
        return createNode(...args);
      };
      store.createNodes = async (...args) => {
        calls.createNodes++;
        batching = true;
        try {
          return await createNodes(...args);
        } finally {
          batching = false;
        }
      };
      try {
        const files = Array.from({ length: 40 }, (_, i) => ({ type: 'file', name: `f${i}.jpg` }));
        await vfs.createTree(ADMIN_ACCESS, '/instances', [dir('wide', files)]);

        assertEquals(calls, { createNode: 1, createNodes: 1 });
        assertEquals((await vfs.children(ADMIN_ACCESS, '/instances/wide')).map((child) => child.name), files.map((file) => file.name));
      } finally {
        store.createNode = createNode;
        store.createNodes = createNodes;
      }
    });

    await t.step('an empty spec writes nothing', async () => {
      assertEquals(await vfs.createTree(ADMIN_ACCESS, '/instances', []), []);
    });

    // The engine advances a DAG on the instance node's own `created` event, so
    // that event must not arrive before the instance's steps exist.
    await t.step('the subtree is readable by the time its first event lands', async () => {
      const seen: { path: string; steps: string[] }[] = [];

      const sub = await vfs.subscribe!(() => ADMIN_ACCESS, async (event: NodeEvent) => {
        if (event.type !== 'created' || event.path !== '/instances/d') return;

        const steps = await vfs.children(ADMIN_ACCESS, '/instances/d/steps');
        seen.push({ path: event.path, steps: steps.map((step) => step.name) });
      });

      try {
        await vfs.createTree(ADMIN_ACCESS, '/instances', [instance('d', ['only'])]);

        const start = Date.now();
        while (seen.length === 0) {
          if (Date.now() - start > 2000) throw new Error('timed out waiting for the created event');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await sub.unsubscribe();
      }

      assertEquals(seen[0].steps, ['only']);
    });

    // Rolling the partial tree back needs a real transaction, which this store
    // does not have (`NO_OP_TRANSACTION`). What holds everywhere is that the
    // collision is raised rather than silently absorbed.
    await t.step('a name taken deeper in the tree is rejected', async () => {
      await vfs.createTree(ADMIN_ACCESS, '/instances', [instance('e', ['first'])]);

      await assertRejects(
        () => vfs.createTree(ADMIN_ACCESS, '/instances', [dir('fresh', [dir('steps'), dir('steps')])]),
        NodeAlreadyExistsError,
      );
    });

    await t.step('a taken root name is rejected', async () => {
      await assertRejects(
        () => vfs.createTree(ADMIN_ACCESS, '/instances', [dir('e')]),
        NodeAlreadyExistsError,
      );
    });

    await t.step('write access to the parent is required', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'locked', { props: { mode: 0o755, uid: 0, gid: 0 } });

      const stranger: Access = { uid: 4242, gid: 4242, gids: [4242] };

      await assertRejects(
        () => vfs.createTree(stranger, '/locked', [dir('nope')]),
        NodeAccessDeniedError,
      );
    });
  } finally {
    await ctx.dispose();
  }
});
