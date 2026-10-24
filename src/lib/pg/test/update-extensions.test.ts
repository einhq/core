/**
 * PG tier: extensions already at the server's version are left alone. Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { Client } from 'pg';
import { PG_URL, pgTest } from '../../../testing/gates.ts';
import { updateExtensions } from '../update-extensions.ts';

pgTest('an up-to-date database has nothing to update', async () => {
  await updateExtensions(PG_URL!);
  assertEquals(await updateExtensions(PG_URL!), []);

  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    const behind = await client.query(
      `SELECT name FROM pg_available_extensions WHERE installed_version IS NOT NULL AND installed_version <> default_version`,
    );
    assertEquals(behind.rows, []);
  } finally {
    await client.end();
  }
});
