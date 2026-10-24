import type { RelayEventUnsubscriber, RouterManagerIf } from '../../managers/router/mod.ts';
import { routingKeysMatch } from '../routing-key-match.ts';
import { ensureResource, ResourceMode, ResourceSeekMode } from '../types.ts';
import { LogHandle } from './log-handle.ts';
import { LogEntry, LogEntryId, LogIO, LogRegistryIf, LogResourceOptions, LogStat, ParsedRetention, parseRetention } from './types.ts';

type MemoryLogRegistryConfig = {
  router: RouterManagerIf;
};

type LogMeta = {
  retention: string;
  parsed: ParsedRetention;
  routingKeys: string[];
  createdAt: Date;
};

export class MemoryLogRegistry implements LogRegistryIf {
  private initialized = false;
  private logs = new Map<string, LogMeta>();
  private entries = new Map<string, LogEntry[]>();
  private nextIds = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  constructor(private config: MemoryLogRegistryConfig) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.relayUnsubscribe = this.config.router.on(async (routingKey: string, payload: unknown) => {
      await this.handleRelayEvent(routingKey, payload);
    });

    this.initialized = true;
  }

  async dispose(): Promise<void> {
    if (this.relayUnsubscribe) {
      this.relayUnsubscribe();
      this.relayUnsubscribe = undefined;
    }

    for (const set of this.waiters.values()) {
      for (const cb of set) cb();
    }

    this.logs.clear();
    this.entries.clear();
    this.nextIds.clear();
    this.waiters.clear();
  }

  async touch(id: string, opts: LogResourceOptions): Promise<boolean> {
    const retention = opts.retention ?? '';
    const parsed = parseRetention(retention);
    const routingKeys = opts.routingKeys ?? [];

    const existing = this.logs.get(id);

    if (existing) {
      if (existing.retention === retention && arraysEqual(existing.routingKeys, routingKeys)) {
        return false;
      }

      existing.retention = retention;
      existing.parsed = parsed;
      existing.routingKeys = routingKeys;
      return true;
    }

    this.logs.set(id, { retention, parsed, routingKeys, createdAt: new Date() });
    this.entries.set(id, []);
    this.nextIds.set(id, 1);
    return true;
  }

  async open(id: string, opts: LogResourceOptions, mode?: ResourceMode): Promise<LogHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      this.entries.set(id, []);
      this.nextIds.set(id, 1);
    }

    const io: LogIO = {
      append: async (data: unknown, createdAt?: Date): Promise<LogEntryId> => {
        return this.append(id, data, createdAt);
      },
      read: async (limit: number, startId?: LogEntryId, signal?: AbortSignal): Promise<LogEntry[] | null> => {
        return this.read(id, limit, startId, signal);
      },
      seek: async (offset: number, whence: ResourceSeekMode, startId?: LogEntryId): Promise<LogEntryId> => {
        return this.seek(id, offset, whence, startId);
      },
    };

    const rh = new LogHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.logs.has(id);
  }

  async stat(id: string): Promise<LogStat> {
    const meta = this.logs.get(id);

    if (!meta) {
      throw new Error(`no log found: ${id}`);
    }

    const logEntries = this.entries.get(id) ?? [];

    return {
      retention: meta.retention,
      size: logEntries.length,
      routingKeys: meta.routingKeys,
    };
  }

  async statX(id: string): Promise<LogStat> {
    return this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.logs.has(id)) {
      return false;
    }

    this.logs.delete(id);
    this.entries.delete(id);
    this.nextIds.delete(id);

    const set = this.waiters.get(id);
    if (set) {
      for (const cb of set) cb();
      this.waiters.delete(id);
    }

    return true;
  }

  async list(): Promise<AsyncIterable<string>> {
    const keys = Array.from(this.logs.keys());

    return (async function* () {
      for (const key of keys) {
        yield key;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.logs.size;
  }

  private append(id: string, data: unknown, createdAt?: Date): LogEntryId {
    const logEntries = this.entries.get(id);
    if (!logEntries) throw new Error(`no log found: ${id}`);

    const entryId = this.nextIds.get(id)!;
    this.nextIds.set(id, entryId + 1);

    logEntries.push({ id: entryId, createdAt: createdAt ?? new Date(), data });

    const meta = this.logs.get(id);
    if (meta?.parsed.type === 'count' && logEntries.length > meta.parsed.limit) {
      logEntries.splice(0, logEntries.length - meta.parsed.limit);
    }

    this.notifyWaiters(id);

    return entryId;
  }

  private read(id: string, limit: number, startId?: LogEntryId, signal?: AbortSignal): Promise<LogEntry[] | null> {
    const logEntries = this.entries.get(id);
    if (!logEntries) throw new Error(`no log found: ${id}`);

    const threshold = startId ?? 0;
    const results = logEntries.filter((e) => e.id > threshold).slice(0, limit);

    if (results.length > 0 || !signal) {
      return Promise.resolve(results);
    }

    return new Promise<LogEntry[] | null>((resolve) => {
      const tryRead = () => {
        cleanup();
        const entries = logEntries.filter((e) => e.id > threshold).slice(0, limit);
        resolve(entries.length > 0 ? entries : null);
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      const removeWaiter = this.addWaiter(id, tryRead);

      const cleanup = () => {
        removeWaiter();
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private seek(id: string, offset: number, whence: ResourceSeekMode, startId?: LogEntryId): LogEntryId {
    const logEntries = this.entries.get(id);
    if (!logEntries) throw new Error(`no log found: ${id}`);

    let index: number;

    switch (whence) {
      case ResourceSeekMode.Start:
        index = offset;
        break;

      case ResourceSeekMode.Current: {
        if (startId === undefined) {
          throw new Error('current seek requires startId');
        }
        const baseIndex = logEntries.findIndex((e) => e.id === startId);
        if (baseIndex === -1) {
          throw new Error(`seek failed: ${id} (offset=${offset}, whence=${whence}, startId=${startId})`);
        }
        index = baseIndex + offset;
        break;
      }

      case ResourceSeekMode.End:
        index = logEntries.length - 1 - Math.abs(offset);
        break;

      default:
        throw new Error(`invalid whence: ${whence}`);
    }

    if (index < 0 || index >= logEntries.length) {
      throw new Error(`seek failed: ${id} (offset=${offset}, whence=${whence}, startId=${startId})`);
    }

    return logEntries[index].id;
  }

  private async handleRelayEvent(routingKey: string, payload: unknown): Promise<void> {
    for (const [id, meta] of this.logs) {
      if (routingKeysMatch(meta.routingKeys, routingKey)) {
        this.append(id, payload);
      }
    }
  }

  private addWaiter(id: string, callback: () => void): () => void {
    let set = this.waiters.get(id);
    if (!set) {
      set = new Set();
      this.waiters.set(id, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.waiters.delete(id);
    };
  }

  private notifyWaiters(id: string): void {
    const set = this.waiters.get(id);
    if (set) {
      for (const cb of set) cb();
    }
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
