/**
 * Shared stored-reach conformance: a store's `reachable` agrees with the rule it stands for — a
 * node is reachable when some path from the root to it has execute, as `verifyAccess` grants it,
 * on every node above it — after every kind of write; a query for a reader returns the reachable
 * nodes it may read; and `countReadableChildren` counts the children it may read.
 *
 * A seeded random sequence of writes builds a tree with hard links, modes, owners, groups and
 * access lists naming accounts, groups and share links. The test keeps its own copy of the
 * hierarchy, and after each write compares the store's answer for every node and caller with a
 * walk of that copy. Parameterized over a store factory, so the memory store (fast tier) and
 * PgStore (PG tier) are held to the same answers.
 */

import { assertEquals } from '@std/assert';
import { type Access, LINK_UID_BASE, verifyAccess } from '../../lib/access/mod.ts';
import type { ModeACL, Ownership } from '../../lib/mode/mod.ts';
import type { NodeId, NodeStore, Transaction } from '../../vfs/mod.ts';

export type ReachStoreFactory = () => Promise<{ store: NodeStore; dispose: () => Promise<void> }>;

/** A small deterministic generator, so a failing sequence can be replayed by its seed. */
const random = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
  };
};

const USERS = [2001, 2002, 2003];
const GROUPS = [3001, 3002, 3003];
const LIVE_LINK = LINK_UID_BASE + 1;
const DEAD_LINK = LINK_UID_BASE + 2;

/** Every kind of caller the grantees tell apart: owners, group members, outsiders, links live and expired. */
const CALLERS: Access[] = [
  { uid: 2001, gid: 2001, gids: [2001, 3001] },
  { uid: 2002, gid: 2002, gids: [2002, 3001, 3002] },
  { uid: 2003, gid: 2003, gids: [2003] },
  { uid: 2004, gid: 2004, gids: [2004, 3003] },
  { uid: LIVE_LINK, gid: LIVE_LINK, gids: [], link: { id: 'live' } },
  { uid: DEAD_LINK, gid: DEAD_LINK, gids: [], link: { id: 'dead', expiresAt: 1 } },
];

const MODES = [0o755, 0o750, 0o700, 0o711, 0o701, 0o710, 0o775, 0o770, 0o751, 0o644, 0o600, 0o705];

type Model = {
  rootId: NodeId;
  owners: Map<NodeId, Ownership>;
  /** Child → its parent edges, one per edge. */
  parents: Map<NodeId, { parentId: NodeId; name: string }[]>;
};

const children = (model: Model, id: NodeId): NodeId[] => [...model.parents].filter(([, edges]) => edges.some((edge) => edge.parentId === id)).map(([child]) => child);

/** Whether `id` is `ancestor` or below it: linking `ancestor` under `id` would make a cycle. */
const isUnder = (model: Model, id: NodeId, ancestor: NodeId): boolean => {
  if (id === ancestor) return true;
  return (model.parents.get(id) ?? []).some((edge) => isUnder(model, edge.parentId, ancestor));
};

/** The rule itself: the root, or a parent the caller reaches and may pass through. */
const walkReachable = (model: Model, access: Access, id: NodeId, memo = new Map<NodeId, boolean>()): boolean => {
  if (id === model.rootId) return true;
  const known = memo.get(id);
  if (known !== undefined) return known;
  const result = (model.parents.get(id) ?? []).some((edge) =>
    verifyAccess(access, model.owners.get(edge.parentId)!, 'x') && walkReachable(model, access, edge.parentId, memo)
  );
  memo.set(id, result);
  return result;
};

export async function runReachConformance(t: Deno.TestContext, factory: ReachStoreFactory, seed = 674, steps = 160) {
  const { store, dispose } = await factory();
  const rand = random(seed);
  let named = 0;
  const name = () => `n${++named}`;

  const ownership = (): Ownership => {
    const acl: ModeACL[] = [];
    for (let i = rand.int(3); i > 0; i--) {
      const mode = rand.int(8);
      const who = rand.int(3);
      acl.push(who === 0 ? { uid: rand.pick(USERS), mode } : who === 1 ? { gid: rand.pick(GROUPS), mode } : { uid: rand.pick([LIVE_LINK, DEAD_LINK]), mode });
    }
    return { mode: rand.pick(MODES), uid: rand.pick(USERS), gid: rand.pick(GROUPS), ...(acl.length > 0 ? { acl } : {}) };
  };

  const write = async (fn: (tx: Transaction) => Promise<unknown>) => {
    const tx = await store.beginTransaction();
    try {
      await fn(tx);
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  };

  try {
    const rootId = store.rootId;
    const rootOwner = (await store.getOwnership!([rootId])).get(rootId)!;
    const model: Model = { rootId, owners: new Map([[rootId, rootOwner]]), parents: new Map() };
    const ids = () => [...model.owners.keys()];
    const nonRoot = () => ids().filter((id) => id !== rootId);

    const check = async (op: string, step: number) => {
      for (const access of CALLERS) {
        const reached = await store.reachable!(access, ids());
        const memo = new Map<NodeId, boolean>();
        const want = ids().filter((id) => walkReachable(model, access, id, memo)).sort();
        assertEquals([...reached.keys()].sort(), want, `seed ${seed}, step ${step} (${op}), uid ${access.uid}`);
        const rows = await store.queryNodes!({ reader: access, limit: model.owners.size + 1 });
        const readable = want.filter((id) => verifyAccess(access, model.owners.get(id)!, 'r'));
        assertEquals(rows.map((row) => row.node.id).sort(), readable, `seed ${seed}, step ${step} (${op}), query for uid ${access.uid}`);
        const counts = new Map<NodeId, number>();
        for (const [child, edges] of model.parents) {
          if (!verifyAccess(access, model.owners.get(child)!, 'r')) continue;
          for (const edge of edges) counts.set(edge.parentId, (counts.get(edge.parentId) ?? 0) + 1);
        }
        const counted = await store.countReadableChildren!(access, ids());
        assertEquals([...counted].sort(), [...counts].sort(), `seed ${seed}, step ${step} (${op}), readable children for uid ${access.uid}`);
      }
    };

    const ops: Record<string, () => Promise<void>> = {
      create: async () => {
        const parentId = rand.pick(ids());
        const props = ownership();
        const nm = name();
        await write(async (tx) => {
          const node = await store.createNode!(0, 'directory', parentId, nm, props, {}, tx);
          model.owners.set(node.id, props);
          model.parents.set(node.id, [{ parentId, name: nm }]);
        });
      },
      createMany: async () => {
        const parentId = rand.pick(ids());
        const kids = Array.from({ length: 1 + rand.int(3) }, () => ({ type: 'directory', name: name(), props: ownership() }));
        await write(async (tx) => {
          const made = await store.createNodes!(0, parentId, kids, tx);
          made.forEach((node, i) => {
            model.owners.set(node.id, kids[i].props);
            model.parents.set(node.id, [{ parentId, name: kids[i].name }]);
          });
        });
      },
      chmod: async () => {
        const targets = [...new Set(Array.from({ length: 1 + rand.int(3) }, () => rand.pick(ids())))];
        const props = ownership();
        await write(async (tx) => await store.updateNodes!(0, targets, { mode: props.mode, uid: props.uid, gid: props.gid, acl: props.acl ?? [] }, undefined, tx));
        for (const id of targets) model.owners.set(id, { ...props, ...(props.acl ? {} : { acl: [] }) });
      },
      chmodEach: async () => {
        const targets = [...new Set(Array.from({ length: 1 + rand.int(3) }, () => rand.pick(ids())))];
        const changes = targets.map((id) => ({ id, props: { mode: rand.pick(MODES) } }));
        await write(async (tx) => await store.updateNodesEach!(0, changes, tx));
        for (const change of changes) model.owners.set(change.id, { ...model.owners.get(change.id)!, mode: change.props.mode });
      },
      attrsOnly: async () => {
        const id = rand.pick(ids());
        await write(async (tx) => await store.updateNodes!(0, [id], undefined, { label: name() }, tx));
      },
      link: async () => {
        const childId = rand.pick(nonRoot());
        const parentId = rand.pick(ids().filter((id) => !isUnder(model, id, childId)));
        if (!childId || !parentId) return;
        const nm = name();
        await write(async (tx) => await store.linkChild!(0, parentId, childId, nm, tx));
        model.parents.get(childId)!.push({ parentId, name: nm });
      },
      unlink: async () => {
        // Only a second edge: the last one goes with the node (`delete`).
        const linked = nonRoot().filter((id) => model.parents.get(id)!.length > 1);
        if (linked.length === 0) return;
        const childId = rand.pick(linked);
        const edges = model.parents.get(childId)!;
        const edge = rand.pick(edges);
        await write(async (tx) => await store.unlinkChild!(0, edge.parentId, childId, edge.name, tx));
        edges.splice(edges.indexOf(edge), 1);
      },
      unlinkMany: async () => {
        const linked = nonRoot().filter((id) => model.parents.get(id)!.length > 1);
        if (linked.length === 0) return;
        const picked = [...new Set([rand.pick(linked), rand.pick(linked)])];
        const edges = picked.map((id) => ({ id, ...model.parents.get(id)![0] }));
        await write(async (tx) => await store.unlinkChildren!(0, edges, tx));
        for (const id of picked) model.parents.get(id)!.shift();
      },
      move: async () => {
        const childId = rand.pick(nonRoot());
        if (!childId) return;
        const edges = model.parents.get(childId)!;
        const edge = rand.pick(edges);
        const parentId = rand.pick(ids().filter((id) => !isUnder(model, id, childId)));
        const nm = name();
        await write(async (tx) => await store.moveChild!(0, edge.parentId, edge.name, parentId, nm, tx));
        edges[edges.indexOf(edge)] = { parentId, name: nm };
      },
      moveMany: async () => {
        const childId = rand.pick(nonRoot());
        if (!childId) return;
        const edges = model.parents.get(childId)!;
        const edge = edges[0];
        const parentId = rand.pick(ids().filter((id) => !isUnder(model, id, childId)));
        const nm = name();
        await write(async (tx) => await store.moveChildren!(0, [{ from: edge, to: { parentId, name: nm } }], tx));
        edges[0] = { parentId, name: nm };
      },
      delete: async () => {
        const leaves = nonRoot().filter((id) => children(model, id).length === 0);
        if (leaves.length === 0) return;
        const id = rand.pick(leaves);
        await write(async (tx) => {
          await store.unlinkChildren!(0, model.parents.get(id)!.map((edge) => ({ id, ...edge })), tx);
          await store.deleteNodes!(0, [id], tx);
        });
        model.owners.delete(id);
        model.parents.delete(id);
      },
      release: async () => {
        const kind = rand.int(2) === 0 ? 'uid' as const : 'gid' as const;
        const id = kind === 'uid' ? rand.pick([...USERS, LIVE_LINK]) : rand.pick(GROUPS);
        const to = kind === 'uid' ? rand.pick(USERS.filter((uid) => uid !== id)) : rand.pick(GROUPS.filter((gid) => gid !== id));
        await store.releaseOwner!({ kind, id, to } as never, 0);
        for (const [node, owner] of model.owners) {
          const acl = owner.acl?.filter((entry) => entry[kind] !== id);
          model.owners.set(node, { ...owner, [kind]: owner[kind] === id ? to : owner[kind], ...(owner.acl ? { acl } : {}) });
        }
      },
    };

    // Grow a tree first, then mix every kind of write in.
    const weights: [string, number][] = [
      ['create', 6],
      ['createMany', 2],
      ['chmod', 3],
      ['chmodEach', 2],
      ['attrsOnly', 1],
      ['link', 3],
      [
        'unlink',
        2,
      ],
      ['unlinkMany', 1],
      ['move', 2],
      ['moveMany', 1],
      ['delete', 2],
      ['release', 1],
    ];
    const bag = weights.flatMap(([op, weight]) => Array<string>(weight).fill(op));

    await t.step(`seed ${seed}: ${steps} random writes agree with a walk after each`, async () => {
      for (let step = 0; step < steps; step++) {
        const op = step < 12 ? 'create' : rand.pick(bag);
        await ops[op]();
        await check(op, step);
      }
    });
  } finally {
    await dispose();
  }
}
