/**
 * PgBlobRegistry - PostgreSQL large object storage backend
 *
 * File content is stored as PostgreSQL large objects. A mapping table
 * ${prefix}_blobs tracks node_id -> OID associations.
 *
 * Large object operations (lo_*) must occur within a transaction.
 */

import { createSha256 } from '../../lib/hash/mod.ts';
import { Buffer } from 'node:buffer';
import type { Pool } from 'pg';
import { getMimeFromBuffer, MIME_SAMPLE_BYTES } from '../../lib/media/mod.ts';
import { ensureResource, type ResourceMode, type ResourceOptions } from '../types.ts';
import { PgBlobHandle } from './pg-blob-handle.ts';
import type { BlobRegistryIf, BlobStat, BlobStatX } from './types.ts';

// PostgreSQL large object mode flags
const INV_READ = 0x00040000;

type PgBlobRegistryConfig = {
  pool: Pool;
  prefix: string;
};

export class PgBlobRegistry implements BlobRegistryIf {
  private initialized = false;

  constructor(private config: PgBlobRegistryConfig) {}

  private get lobTable(): string {
    return `${this.config.prefix}_blobs`;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const client = await this.config.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.lobTable} (
          node_id TEXT PRIMARY KEY,
          loid OID NOT NULL
        )
      `);
    } finally {
      client.release();
    }

    this.initialized = true;
  }

  async dispose(): Promise<void> {}

  async touch(id: string, _opts: ResourceOptions): Promise<boolean> {
    if (await this.exists(id)) return false;

    const client = await this.config.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT lo_create(0) AS oid');
      const oid = result.rows[0].oid;
      await client.query(
        `INSERT INTO ${this.lobTable} (node_id, loid) VALUES ($1, $2)`,
        [id, oid],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

  async open(
    id: string,
    opts: ResourceOptions,
    mode?: ResourceMode,
  ): Promise<PgBlobHandle> {
    await ensureResource(this, id, opts, mode);

    const rh = new PgBlobHandle(
      id,
      opts,
      mode || 'r',
      this,
      this.config.pool,
      this.lobTable,
    );
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    const client = await this.config.pool.connect();
    try {
      const result = await client.query(
        `SELECT 1 FROM ${this.lobTable} WHERE node_id = $1`,
        [id],
      );
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  async stat(id: string): Promise<BlobStat> {
    const client = await this.config.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(
        `SELECT loid FROM ${this.lobTable} WHERE node_id = $1`,
        [id],
      );
      if (row.rows.length === 0) {
        await client.query('COMMIT');
        throw new Error(`resource not found: ${id}`);
      }
      const oid = row.rows[0].loid;
      const fdResult = await client.query(
        'SELECT lo_open($1, $2) AS fd',
        [oid, INV_READ],
      );
      const fd = fdResult.rows[0].fd;
      const sizeResult = await client.query(
        'SELECT lo_lseek64($1, 0, 2) AS size',
        [fd],
      );
      await client.query('SELECT lo_close($1)', [fd]);
      await client.query('COMMIT');
      return { size: Number(sizeResult.rows[0].size) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async statX(id: string): Promise<BlobStatX> {
    const client = await this.config.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(
        `SELECT loid FROM ${this.lobTable} WHERE node_id = $1`,
        [id],
      );
      if (row.rows.length === 0) {
        await client.query('COMMIT');
        throw new Error(`resource not found: ${id}`);
      }
      const oid = row.rows[0].loid;
      const fdResult = await client.query(
        'SELECT lo_open($1, $2) AS fd',
        [oid, INV_READ],
      );
      const fd = fdResult.rows[0].fd;

      const hasher = createSha256();
      const chunkSize = 64 * 1024;
      let size = 0;
      let firstBytes = new Uint8Array(0);

      while (true) {
        const result = await client.query(
          'SELECT loread($1, $2) AS data',
          [fd, chunkSize],
        );
        const chunk = result.rows[0].data as Buffer;
        if (!chunk || chunk.length === 0) break;

        const bytes = new Uint8Array(chunk);
        hasher.update(bytes);
        size += bytes.length;

        if (firstBytes.byteLength < MIME_SAMPLE_BYTES) {
          const remaining = MIME_SAMPLE_BYTES - firstBytes.byteLength;
          const slice = bytes.subarray(0, remaining);
          const tmp = new Uint8Array(firstBytes.byteLength + slice.byteLength);
          tmp.set(firstBytes);
          tmp.set(slice, firstBytes.byteLength);
          firstBytes = tmp;
        }
      }

      await client.query('SELECT lo_close($1)', [fd]);
      await client.query('COMMIT');

      return {
        size,
        sha256: hasher.hex(),
        mimetype: await getMimeFromBuffer(firstBytes),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const client = await this.config.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(
        `SELECT loid FROM ${this.lobTable} WHERE node_id = $1`,
        [id],
      );
      if (row.rows.length === 0) {
        await client.query('COMMIT');
        return false;
      }
      await client.query('SELECT lo_unlink($1)', [row.rows[0].loid]);
      await client.query(
        `DELETE FROM ${this.lobTable} WHERE node_id = $1`,
        [id],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async list(_id?: string): Promise<AsyncIterable<string>> {
    const client = await this.config.pool.connect();
    try {
      const result = await client.query(
        `SELECT node_id FROM ${this.lobTable} ORDER BY node_id`,
      );
      const ids = result.rows.map((r: { node_id: string }) => r.node_id);
      return (async function* () {
        for (const id of ids) {
          yield id;
        }
      })();
    } finally {
      client.release();
    }
  }

  async count(_id?: string): Promise<number> {
    const client = await this.config.pool.connect();
    try {
      const result = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${this.lobTable}`,
      );
      return result.rows[0].count;
    } finally {
      client.release();
    }
  }
}
