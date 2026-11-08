import type { LogRegistryIf, LogResourceOptions, LogStat } from '../log/types.ts';
import type { RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';

/**
 * A control's registry: a control's states, as the device reported them, are kept as a log's
 * entries are, in the log registry under the control's id, so reading one is reading a log (`cat`,
 * `tail -f`, `log-read`). Writing one is not appending: a write is a value for the device, which the
 * VFS hands its driver (`DeviceWriteHandle`), and only the driver's report of a state is appended,
 * opened `a`. So a writable open other than `a` never reaches this registry.
 */
export class ControlRegistry implements RegistryIf<LogResourceOptions, LogStat> {
  constructor(private readonly config: { log: LogRegistryIf }) {}

  async init(): Promise<void> {}

  async dispose(): Promise<void> {}

  async touch(id: string, opts: LogResourceOptions): Promise<boolean> {
    return await this.config.log.touch(id, opts);
  }

  async open(id: string, opts: LogResourceOptions, mode: ResourceMode = 'r'): Promise<ResourceHandleIf<LogResourceOptions, LogStat>> {
    if (mode !== 'r' && !mode.includes('a')) throw new Error(`a control's states are read or appended, not opened '${mode}'`);
    return await this.config.log.open(id, opts, mode);
  }

  async exists(id: string): Promise<boolean> {
    return await this.config.log.exists(id);
  }

  async stat(id: string): Promise<LogStat> {
    return await this.config.log.stat(id);
  }

  async statX(id: string): Promise<LogStat> {
    return await this.config.log.statX(id);
  }

  async delete(id: string): Promise<boolean> {
    return await this.config.log.delete(id);
  }

  async list(id?: string): Promise<AsyncIterable<string>> {
    return await this.config.log.list(id);
  }

  async count(id?: string): Promise<number> {
    return await this.config.log.count(id);
  }
}
