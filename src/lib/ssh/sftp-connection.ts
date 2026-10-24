/**
 * The one SSH connection an `sftp` mount's store and file registry share.
 *
 * Opened lazily, and again after it drops — with a growing wait between failed
 * attempts, so an unreachable server is asked at most once a minute rather than
 * on every `ls`. Also holds a short-lived cache of what the server said about
 * paths, since one VFS operation asks about the same path several times.
 */

import * as posix from '@std/path/posix';
import type { Client, SFTP } from 'ssh2';
import { createLogger } from '../../managers/logger/mod.ts';

const logger = createLogger('sftp-mount');

export interface SftpAttrs {
  mode?: number;
  size?: number | bigint;
  atime?: number | Date;
  mtime?: number | Date;
}

interface SftpDirEntry {
  filename: string;
  attrs: SftpAttrs;
}

const MAX_BACKOFF_MS = 60_000;

/** Entries live this long; the store's own writes invalidate what they touch */
const CACHE_TTL_MS = 2_000;

class TtlCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

interface SftpConnectionConfig {
  /** Opens and authenticates a connection; never asks anyone anything */
  connect: () => Promise<Client>;
  /** Remote directory mirrored; a relative one starts in the login directory */
  path: string;
  /** `user@host:path`, for messages */
  label: string;
}

export class SftpConnection {
  private client?: Client;
  private sftp?: SFTP;
  private opening?: Promise<SFTP>;
  private failures = 0;
  private retryAt = 0;
  private lastError?: Error;
  private closed = false;

  /** Absolute remote path of the mount root, known once connected */
  root = '';

  readonly attrs = new TtlCache<SftpAttrs>();
  readonly dirs = new TtlCache<SftpDirEntry[]>();
  readonly links = new TtlCache<string>();

  constructor(private config: SftpConnectionConfig) {}

  get label(): string {
    return this.config.label;
  }

  /** The SFTP session, connecting first when there is none */
  async get(): Promise<SFTP> {
    if (this.closed) throw new Error(`${this.label}: unmounted`);
    if (this.sftp) return this.sftp;
    if (this.opening) return await this.opening;

    if (Date.now() < this.retryAt && this.lastError) {
      const secs = Math.ceil((this.retryAt - Date.now()) / 1000);
      throw new Error(`${this.label}: ${this.lastError.message} (next attempt in ${secs}s)`);
    }

    this.opening = this.open();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async open(): Promise<SFTP> {
    try {
      const client = await this.config.connect();
      client.on('error', (err: Error) => logger.warn('connection error', { mount: this.label, error: err.message }));
      client.on('close', () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.sftp = undefined;
        this.clearCache();
        if (!this.closed) logger.info('connection closed; reconnecting on next use', { mount: this.label });
      });

      const sftp = await client.sftp();
      this.root = await sftp.realpath(this.config.path || '.');
      this.client = client;
      this.sftp = sftp;
      this.failures = 0;
      this.lastError = undefined;
      if (this.closed) {
        client.end();
        throw new Error(`${this.label}: unmounted`);
      }
      return sftp;
    } catch (error) {
      this.failures++;
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.retryAt = Date.now() + Math.min(1000 * 2 ** this.failures, MAX_BACKOFF_MS);
      logger.warn('connect failed', { mount: this.label, error: this.lastError.message, failures: this.failures });
      throw this.lastError;
    }
  }

  /** The remote path for a path within the mount (`/a/b` or `a/b`) */
  remote(rel: string): string {
    return posix.join(this.root, rel.replace(/^\/+/, ''));
  }

  /** Forget what is known about a path, and the listing of its directory */
  invalidate(rel: string): void {
    const path = posix.join('/', rel);
    this.attrs.delete(path);
    this.links.delete(path);
    this.dirs.delete(path);
    this.dirs.delete(posix.dirname(path));
  }

  clearCache(): void {
    this.attrs.clear();
    this.dirs.clear();
    this.links.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearCache();
    this.client?.end();
    this.client = undefined;
    this.sftp = undefined;
  }
}
