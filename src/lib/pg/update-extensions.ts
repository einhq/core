/**
 * Brings the database's extensions up to the versions its server offers.
 *
 * A database keeps an extension's SQL objects at the version it was created with until it is
 * updated, so a new PostgreSQL image brings new libraries but not their functions or catalog
 * fixes. Run once at startup, before anything uses the database. TimescaleDB's update has to be
 * the first statement of its session, so it gets a connection of its own.
 *
 * Updating needs the extension's owner or a superuser. A role that may not is told so in the log
 * and the system starts anyway: the old version keeps working until someone with the rights
 * updates it.
 */

import { Client } from 'pg';
import { createLogger } from '../../managers/logger/mod.ts';

const logger = createLogger('pg-extensions');

/** Each installed extension whose version is older than the server's, by name. */
const outdated = async (connectionString: string): Promise<string[]> => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      `SELECT name FROM pg_available_extensions
        WHERE installed_version IS NOT NULL AND installed_version <> default_version
        ORDER BY name = 'timescaledb' DESC, name`,
    );
    return result.rows.map((row) => row.name);
  } finally {
    await client.end();
  }
};

/** Updates every outdated extension; answers the ones it updated. */
export const updateExtensions = async (connectionString: string): Promise<string[]> => {
  const updated: string[] = [];
  for (const name of await outdated(connectionString)) {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(`ALTER EXTENSION "${name.replaceAll('"', '""')}" UPDATE`);
      updated.push(name);
      logger.info('extension updated', { extension: name });
    } catch (error) {
      logger.warn('extension not updated', { extension: name, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await client.end();
    }
  }
  return updated;
};
