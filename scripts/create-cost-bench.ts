/**
 * create-cost-bench — what one VFS create costs postgres, statement by
 * statement.
 *
 * `vfs-churn-bench.sh` counts *transactions* against a running instance. This
 * counts the round trips inside one, which is the half a create pays for, and
 * times each statement shape so the split between "another round trip" and
 * "the commit" is visible rather than assumed. Run it against a local postgres
 * (`make db`); it uses its own table prefix and drops it again.
 *
 *   deno run -A scripts/create-cost-bench.ts       # ROUNDS=200 by default
 *   ROUNDS=500 deno run -A scripts/create-cost-bench.ts
 *
 * The `createTree` sections are skipped when the checkout has no `createTree`,
 * so the same script produces the before half of a before/after.
 */
import { Pool } from 'pg';
import { ulid } from '@std/ulid/ulid';
import { ADMIN_ACCESS } from '../src/lib/access/mod.ts';
import { RouterManager } from '../src/managers/router/mod.ts';
import { MemoryFileRegistry } from '../src/registries/file/mod.ts';
import { PgStore } from '../src/stores/pg/index.ts';
import { LocalNodeVFS } from '../src/vfs/mod.ts';

// Loose on purpose — see the note about older checkouts above.
// deno-lint-ignore no-explicit-any
type TreeSpec = any;

const PG_URL = Deno.env.get('POSTGRES_URL') ?? 'postgres://ein:ein@localhost:5432/ein';
const ROUNDS = Number(Deno.env.get('ROUNDS') ?? 200);

/** The statement's first non-blank line — enough to tell the shapes apart. */
const shapeOf = (sql: unknown, width: number) => String(sql).split('\n').map((line) => line.trim()).filter(Boolean)[0].slice(0, width);

const counted: string[] = [];
const elapsedByShape = new Map<string, number>();
let sqlMs = 0;
let counting = false;
let timing = false;

// The pool hands out pooled connections, so wrap each one once.
const pool = new Pool({ connectionString: PG_URL });
const realConnect = pool.connect.bind(pool);
const instrumented = new WeakSet<object>();

(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
  const conn = await realConnect() as { query: (...args: unknown[]) => Promise<unknown> };
  if (instrumented.has(conn)) return conn;

  instrumented.add(conn);
  const realQuery = conn.query.bind(conn);

  conn.query = async (...args: unknown[]) => {
    if (counting) counted.push(shapeOf(args[0], 64));
    const started = performance.now();
    try {
      return await realQuery(...args);
    } finally {
      if (timing) {
        const took = performance.now() - started;
        sqlMs += took;
        const shape = shapeOf(args[0], 48);
        elapsedByShape.set(shape, (elapsedByShape.get(shape) ?? 0) + took);
      }
    }
  };

  return conn;
};

const prefix = `b${ulid().toLowerCase()}`;
const routerManager = new RouterManager();
await routerManager.init();
routerManager.release();

const store = new PgStore({ pgPool: pool as never, name: prefix });
const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
await vfs.initialize();

await vfs.create(ADMIN_ACCESS, 'directory', '/', 'bench');

// deno-lint-ignore no-explicit-any
const createTree = (vfs as any).createTree?.bind(vfs) as
  | ((access: typeof ADMIN_ACCESS, parent: string, specs: TreeSpec[]) => Promise<unknown>)
  | undefined;

/** An instance in the shape the pipeline engine writes it. */
const instanceSpec = (id: string, steps: string[]): TreeSpec => ({
  type: 'directory',
  name: id,
  attrs: { status: 'running' },
  children: [{
    type: 'directory',
    name: 'steps',
    children: steps.map((name) => ({ type: 'directory', name, attrs: { status: 'pending' } })),
  }],
});

const count = async (label: string, fn: () => Promise<void>) => {
  counted.length = 0;
  counting = true;
  await fn();
  counting = false;

  console.log(`\n${label}: ${counted.length} statements`);
  for (const shape of counted) console.log('   ', shape);
};

const time = async (label: string, fn: (round: number) => Promise<void>) => {
  elapsedByShape.clear();
  sqlMs = 0;
  timing = true;
  const started = performance.now();
  for (let round = 0; round < ROUNDS; round++) await fn(round);
  const elapsed = performance.now() - started;
  timing = false;

  console.log(
    `\n${label}: ${(elapsed / ROUNDS).toFixed(2)} ms each over ${ROUNDS} rounds ` +
      `(${(sqlMs / ROUNDS).toFixed(2)} ms of it in postgres)`,
  );
  for (const [shape, ms] of [...elapsedByShape].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(ms / ROUNDS).toFixed(2)} ms  ${shape}`);
  }
};

await count('create (fresh name)', async () => {
  await vfs.create(ADMIN_ACCESS, 'directory', '/bench', 'a', { attrs: { x: 1 } });
});

await count('ensure (already there)', async () => {
  await vfs.ensure(ADMIN_ACCESS, 'directory', '/bench', 'a');
});

await count('unlink (leaf)', async () => {
  await vfs.unlink(ADMIN_ACCESS, '/bench/a', '/bench');
});

await count('instance with 4 steps, a create per node', async () => {
  await vfs.create(ADMIN_ACCESS, 'directory', '/bench', 'inst', { attrs: { status: 'running' } });
  await vfs.create(ADMIN_ACCESS, 'directory', '/bench/inst', 'steps');
  for (const name of ['s1', 's2', 's3', 's4']) {
    await vfs.create(ADMIN_ACCESS, 'directory', '/bench/inst/steps', name, { attrs: { status: 'pending' } });
  }
});

if (createTree) {
  await count('instance with 4 steps, createTree', async () => {
    await createTree(ADMIN_ACCESS, '/bench', [instanceSpec('inst4', ['s1', 's2', 's3', 's4'])]);
  });

  // All but one of the twelve shipped definitions declare a single step.
  await count('instance with 1 step, createTree', async () => {
    await createTree(ADMIN_ACCESS, '/bench', [instanceSpec('inst1', ['s1'])]);
  });
}

// Serial on purpose: that is how an instance is written.
await vfs.create(ADMIN_ACCESS, 'directory', '/bench', 'timed');
await time('one create', async (round) => {
  await vfs.create(ADMIN_ACCESS, 'directory', '/bench/timed', `n${round}`, { attrs: { status: 'pending' } });
});

await vfs.create(ADMIN_ACCESS, 'directory', '/bench', 'timed-serial');
await time('instance with 1 step, a create per node', async (round) => {
  await vfs.create(ADMIN_ACCESS, 'directory', '/bench/timed-serial', `t${round}`, { attrs: { status: 'running' } });
  await vfs.create(ADMIN_ACCESS, 'directory', `/bench/timed-serial/t${round}`, 'steps');
  await vfs.create(ADMIN_ACCESS, 'directory', `/bench/timed-serial/t${round}/steps`, 's1', { attrs: { status: 'pending' } });
});

if (createTree) {
  await vfs.create(ADMIN_ACCESS, 'directory', '/bench', 'timed-tree');
  await time('instance with 1 step, createTree', async (round) => {
    await createTree(ADMIN_ACCESS, '/bench/timed-tree', [instanceSpec(`t${round}`, ['s1'])]);
  });
}

const conn = await realConnect() as {
  query: (sql: string) => Promise<{ rows: { tablename: string }[] }>;
  release: () => void;
};
const tables = await conn.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '${prefix}%'`);
for (const row of tables.rows) await conn.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
conn.release();

await vfs.dispose();
await routerManager.dispose();
await pool.end();
