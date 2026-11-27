/**
 * A pg mount's schema, versioned part by part.
 *
 * Each part of a mount that keeps tables — the node store and each registry — has a numbered list
 * of migrations, and `<mount>_schema` holds the version each part's tables are at: the number of
 * the last migration they have had. `migrate` runs the ones a part has not had, in order, each in
 * a transaction of its own together with the version it brings, so a start that fails part way
 * leaves the part at the last migration that finished and the next start goes on from there.
 * A part that is up to date costs one read and takes no lock.
 *
 * A migration that has shipped is never edited: a change to a part's tables is a new migration at
 * the end of its list. Each one tolerates the tables as every earlier migration left them, and,
 * since a database from before versions were recorded runs a part's list from the first, as the
 * code before that left them.
 *
 * Old migrations are deleted by raising the part's `floor`: its baseline makes a new database's
 * tables as the deleted migrations would have, and a database below the floor is refused with the
 * release to update through first. Tables a newer EiN migrated are used as they are, with a
 * warning: an update whose new EiN does not come up goes back to the image before it, which has
 * to start on what the new one already migrated.
 */

import type { Pool, PoolClient } from 'pg';
import { createLogger } from '../../managers/logger/mod.ts';

const logger = createLogger('pg-schema');

/** One step of a part's schema. It runs in a transaction, which also records its number. */
export type Migration = {
  /** What it does, for the log. */
  name: string;
  run(conn: PoolClient): Promise<void>;
};

/** Where a part's list starts once the migrations below it are deleted. */
type SchemaFloor = {
  /** The last deleted migration's number: the list continues at the one after it. */
  version: number;
  /** The EiN release that still has the deleted migrations, named to the database below the floor. */
  release: string;
  /** Makes a new database's tables as the deleted migrations would have left them. */
  baseline: Migration;
};

export type SchemaPart = {
  /** The pg mount's name: its parts' versions are in `<mount>_schema`. */
  mount: string;
  /** The part, such as `nodes` or `pool`: the row it has there. */
  part: string;
  /**
   * A table the part's first migration (or baseline) makes. When the part has no recorded version
   * its existence tells a database from before versions were recorded from a new one.
   */
  table: string;
  /** Numbered from `floor.version + 1`, or from 1 without a floor. */
  migrations: Migration[];
  floor?: SchemaFloor;
};

/** The table of a mount's part versions. */
export const schemaTable = (mount: string): string => `${mount}_schema`;

/** The version a part's code brings its tables to. */
const latestVersion = (part: SchemaPart): number => (part.floor?.version ?? 0) + part.migrations.length;

/** Runs the migrations `part` has not had yet; answers the version its tables are at. */
export const migrate = async (pool: Pool, part: SchemaPart): Promise<number> => {
  const table = schemaTable(part.mount);
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid schema table: ${table}`);
  const latest = latestVersion(part);
  const conn = await pool.connect();
  try {
    if (!(await exists(conn, table))) {
      // Under a lock, as `createExtension` does: the parts of a mount start side by side, and two
      // `CREATE TABLE IF NOT EXISTS` racing for one name fail on the catalogue's unique index.
      await conn.query(`
        SELECT pg_advisory_xact_lock(hashtext('ein:schema'));
        CREATE TABLE IF NOT EXISTS ${table} (
          part TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    }
    const recorded = await versionOf(conn, table, part.part);
    if (recorded !== undefined && recorded >= latest) {
      if (recorded > latest) logger.warn('schema newer than this EiN', { mount: part.mount, part: part.part, version: recorded, known: latest });
      return recorded;
    }

    const floor = part.floor?.version ?? 0;
    for (;;) {
      await conn.query('BEGIN');
      try {
        // Whoever holds the lock migrates; the others find the version moved when they get it.
        await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ein:schema:${table}:${part.part}`]);
        const version = await from(conn, table, part);
        if (version >= latest) {
          await conn.query('COMMIT');
          return version;
        }
        const [step, to] = version < floor ? [part.floor!.baseline, floor] : [part.migrations[version - floor], version + 1];
        const started = Date.now();
        await step.run(conn);
        await conn.query(
          `INSERT INTO ${table} (part, version) VALUES ($1, $2)
           ON CONFLICT (part) DO UPDATE SET version = EXCLUDED.version, migrated_at = now()`,
          [part.part, to],
        );
        await conn.query('COMMIT');
        logger.info('schema migrated', { mount: part.mount, part: part.part, version: to, migration: step.name, ms: Date.now() - started });
      } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
  } finally {
    conn.release();
  }
};

const exists = async (conn: PoolClient, table: string): Promise<boolean> => {
  const result = await conn.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [table]);
  return result.rows[0].t !== null;
};

const versionOf = async (conn: PoolClient, table: string, part: string): Promise<number | undefined> => {
  const result = await conn.query<{ version: number }>(`SELECT version FROM ${table} WHERE part = $1`, [part]);
  return result.rows[0]?.version;
};

/**
 * The version `part` is at, under its lock: 0 for a new database, and for one from before versions
 * were recorded while its first migration is still in the list. Throws for one the list cannot
 * take further.
 */
const from = async (conn: PoolClient, table: string, part: SchemaPart): Promise<number> => {
  const floor = part.floor?.version ?? 0;
  const recorded = await versionOf(conn, table, part.part);
  if (recorded === undefined) {
    if (floor > 0 && await exists(conn, part.table)) {
      throw new Error(
        `the ${part.part} tables of ${part.mount} have no recorded schema version: update through EiN ${part.floor!.release} first, then to this one`,
      );
    }
    return 0;
  }
  if (recorded < floor) {
    throw new Error(
      `the ${part.part} tables of ${part.mount} are at schema version ${recorded}, which this EiN no longer updates from: update through EiN ${
        part.floor!.release
      } first, then to this one`,
    );
  }
  return recorded;
};
