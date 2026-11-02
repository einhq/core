/**
 * PG tier: sessions creating the same extension at once on a database without it all succeed.
 * Gated by EIN_TEST_PG; needs a role that may create databases.
 */

import { assertEquals } from '@std/assert';
import { Client } from 'pg';
import { PG_URL, pgTest } from '../../../testing/gates.ts';
import { createExtension } from '../create-extension.ts';

const SESSIONS = 8;

pgTest('sessions creating an extension at once on a fresh database all succeed', async () => {
  const database = `ein_create_extension_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${database}`;
    const clients = Array.from({ length: SESSIONS }, () => new Client({ connectionString: url.href }));
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await Promise.all(clients.map((client) => createExtension(client, 'pg_trgm')));
      const installed = await clients[0].query(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
      assertEquals(installed.rows.length, 1);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
