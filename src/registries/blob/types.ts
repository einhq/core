import { RegistryIf, ResourceOptions } from '../types.ts';

/** Synchronous get/set IO pair used by in-memory handles. */
export interface BlobIO {
  get: () => Uint8Array;
  set: (data: Uint8Array) => void;
}

export type BlobStat = {
  size: number;
  mtime?: number;
  birthtime?: number;
};

export type BlobStatX = BlobStat & {
  mimetype: string;
  sha256: string;
};

export interface BlobRegistryIf extends RegistryIf<ResourceOptions, BlobStat, BlobStatX> {}
