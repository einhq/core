import { RegistryIf, ResourceOptions } from '../types.ts';

/** Synchronous get/set IO pair used by in-memory handles. */
export interface FileIO {
  get: () => Uint8Array;
  set: (data: Uint8Array) => void;
}

export type FileStat = {
  size: number;
  mtime?: number;
  birthtime?: number;
  path?: string;
  mode?: number;
  uid?: number;
  gid?: number;
};

export type FileStatX = FileStat & {
  mimetype: string;
  sha256: string;
};

/**
 * Physical storage tier a file's bytes live on:
 * - `disk`: durable slow store (originals, RAW versions) — e.g. RAIDed NAS/NFS.
 * - `volatile`: fast regenerable store (thumbnails, crops, transcodes).
 * - `db`: PostgreSQL large object (small content: comments, events, secrets).
 */
export type FileTier = 'disk' | 'volatile' | 'db';

export interface FileRegistryIf extends RegistryIf<ResourceOptions, FileStat, FileStatX> {}
