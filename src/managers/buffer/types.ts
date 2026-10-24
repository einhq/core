import type { ManagerIf } from '../types.ts';
import type { ResourceHandleIf, ResourceMode, ResourceOptions } from '../../registries/types.ts';

export type BufferStat = {
  capacity: number;
  size: number;
};

export type BufferResourceOptions = ResourceOptions & {
  capacity?: number;
};

export interface BufferManagerIf extends ManagerIf {
  touch(id: string, opts: BufferResourceOptions): Promise<boolean>;
  open(id: string, opts: BufferResourceOptions, mode?: ResourceMode): Promise<ResourceHandleIf<BufferResourceOptions, BufferStat>>;
  exists(id: string): Promise<boolean>;
  stat(id: string): Promise<BufferStat>;
  delete(id: string): Promise<boolean>;
  /** Close a buffer for reading: a write to it from here on fails with a `BrokenPipeError`. */
  closeRead(id: string): Promise<void>;
  list(id?: string): Promise<AsyncIterable<string>>;
  count(id?: string): Promise<number>;
}
