/**
 * Creates a PostgreSQL extension unless the database has it.
 *
 * `CREATE EXTENSION IF NOT EXISTS` is not safe against itself: two sessions running it at once on
 * a database without the extension both insert it, and one fails on `pg_extension_name_index`.
 * The stores and registries that need an extension start side by side, so the statement runs
 * under a transaction-scoped advisory lock: the second session waits for the first to commit, and
 * then finds the extension there. Both statements go in one query, which PostgreSQL runs as one
 * transaction, so the lock is released with it whether the creation succeeds or fails.
 */

/** A pool or a connection: whatever runs a statement without parameters. */
interface ExtensionQueryable {
  query(sql: string): Promise<unknown>;
}

export const createExtension = async (db: ExtensionQueryable, name: string): Promise<void> => {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtext('ein:create-extension'));
     CREATE EXTENSION IF NOT EXISTS "${name.replaceAll('"', '""')}"`,
  );
};
