import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { isAdmin } from '../../../../lib/access/mod.ts';
import { stampToObject } from '../../../../lib/datetime/mod.ts';
import { connectSsh, SftpConnection, type SshUser } from '../../../../lib/ssh/mod.ts';
import { createLogger } from '../../../logger/mod.ts';
import { MemoryBlobRegistry, PgBlobRegistry } from '../../../../registries/blob/mod.ts';
import { EmbeddingRegistry, MemoryEmbeddingRegistry } from '../../../../registries/embedding/mod.ts';
import { DiskFileRegistry, MemoryFileRegistry, TieredFileRegistry } from '../../../../registries/file/mod.ts';
import { SftpFileRegistry } from '../../../../registries/file/sftp-file-registry.ts';
import { MemoryPositionRegistry, PositionRegistry } from '../../../../registries/position/mod.ts';
import { MemoryLogRegistry, PgLogRegistry } from '../../../../registries/log/mod.ts';
import { NullRegistry } from '../../../../registries/null/mod.ts';
import { MemoryPoolRegistry, PgPoolRegistry } from '../../../../registries/pool/mod.ts';
import { MemoryQueueRegistry, PgQueueRegistry } from '../../../../registries/queue/mod.ts';
import { RouterRegistry } from '../../../../registries/router/mod.ts';
import { MemoryTrackRegistry, TrackRegistry } from '../../../../registries/track/mod.ts';
import { CommandStore } from '../../../../stores/command/index.ts';
import { FilesystemStore } from '../../../../stores/filesystem/index.ts';
import { InMemoryStore } from '../../../../stores/memory/index.ts';
import { SftpStore } from '../../../../stores/sftp/index.ts';
import { PgStore } from '../../../../stores/pg/index.ts';
import { LocalNodeVFS, NodeStore, NodeVFS, VfsRegistries } from '../../../../vfs/mod.ts';
import { color } from '../../../shell/terminal/color.ts';
import { Table } from '../../../shell/terminal/table.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { type FstabEntry, parseFstab, readFstab, updateFstab } from './fstab.ts';

const logger = createLogger('mount');

type MountOptions = Record<string, string>;

/** `k=v,k2,...` — a bare key means `1`. Values cannot hold `,` or `=`. */
function parseOptions(text: string | undefined): MountOptions {
  return Object.fromEntries(
    (text?.split(',').filter((o) => o !== '') || []).map((o): [string, string] => {
      if (o.includes('=')) {
        return o.split('=').slice(0, 2) as [string, string];
      }

      return [o, '1'];
    }),
  );
}

function parseId(value: string, what: string): number {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 0 || String(id) !== value) throw new Error(`bad ${what} '${value}'`);
  return id;
}

/**
 * The connection an sftp mount's store and registry share. Key auth only — a
 * mount reconnects on its own, long after anyone could type a password. The
 * first connection of an interactive `mount` may ask about an unknown host
 * key; later ones (and a boot's) only accept hosts already in known_hosts, or
 * the `hostkey=SHA256:…` pinned in the options.
 */
function sftpConnection(cmd: Command, options: MountOptions, lazy: boolean): SftpConnection {
  if (!options.host) throw new Error('sftp requires the host option');
  const port = options.port ? parseId(options.port, 'port') : 22;
  const remoteUser = options.user || cmd.env.USER;
  const identity = options.key ? resolve(cmd.cwd, options.key) : undefined;
  const label = `${remoteUser}@${options.host}:${options.path ?? ''}`;

  // Only values, not the command: the connection outlives it
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const user = cmd.env.USER;
  const home = cmd.env.HOME;
  let interactive = !lazy && cmd.tty;

  return new SftpConnection({
    label,
    path: options.path ?? '',
    connect: () => {
      const sshUser: SshUser = {
        vfs,
        access,
        user,
        home,
        ask: interactive ? (prompt, secret) => cmd.prompt(prompt, secret ? 'secret' : 'default') : undefined,
        warn: interactive ? (text) => cmd.writeError(text) : async (text) => logger.warn(text.trim(), { mount: label }),
      };
      interactive = false;
      return connectSsh(sshUser, {
        host: options.host,
        port,
        user: remoteUser,
        identity,
        hostKeyFingerprint: options.hostkey,
        passwordAuth: false,
        keepaliveInterval: 30_000,
      });
    },
  });
}

/** The VFS for a mount of `type`, and whether its events go on the router */
async function buildVfs(
  cmd: Command,
  type: string,
  options: MountOptions,
  lazy: boolean,
): Promise<{ vfs: NodeVFS; publish: boolean }> {
  const rootMode = options.mode && /^[0-7]+$/.test(options.mode) ? Number.parseInt(options.mode, 8) : undefined;

  let store: NodeStore | undefined;
  const regs: VfsRegistries = {};
  let publish = true;

  if (type === 'memory') {
    // A single in-memory disk backend; the db tier's content (comments, events,
    // secrets) is held in a MemoryBlobRegistry, as PostgreSQL holds it in large objects.
    regs.file = new TieredFileRegistry({ disk: new MemoryFileRegistry(), db: new MemoryBlobRegistry() });
    regs.embedding = new MemoryEmbeddingRegistry();
    regs.position = new MemoryPositionRegistry();
    // No router dependency, unlike log/queue/router — a pool is claimed, not
    // published to, so it is wired up regardless of the router manager.
    regs.pool = new MemoryPoolRegistry();
    regs.null = new NullRegistry();

    if (cmd.sys.routerManager) {
      regs.log = new MemoryLogRegistry({
        router: cmd.sys.routerManager,
      });

      regs.queue = new MemoryQueueRegistry({
        router: cmd.sys.routerManager,
      });

      regs.router = new RouterRegistry({
        router: cmd.sys.routerManager,
      });

      regs.track = new MemoryTrackRegistry({
        router: cmd.sys.routerManager,
      });
    }

    store = new InMemoryStore({
      rootMode,
      rootId: options.id,
    });
  } else if (type === 'pg') {
    if (!cmd.sys.pgPool) {
      throw new Error('pg mount requires pgPool');
    }

    if (!options.name) {
      throw new Error('pg requires the name option');
    }

    if (!options.filesPath) {
      throw new Error('pg requires the filesPath option');
    }

    regs.embedding = new EmbeddingRegistry({
      name: options.name,
      pool: cmd.sys.pgPool,
    });

    regs.position = new PositionRegistry({
      name: options.name,
      pool: cmd.sys.pgPool,
    });

    regs.pool = new PgPoolRegistry({
      name: options.name,
      pool: cmd.sys.pgPool,
      listenPool: cmd.sys.pgListenPool,
    });

    regs.null = new NullRegistry();

    // Tiered file storage: originals/RAW versions on the durable `filesPath`
    // root, regenerable renditions on the optional faster `volatilePath` root
    // (falls back to `filesPath` when unset), and small content (comments,
    // events, secrets) on the `db` tier backed by PostgreSQL large objects.
    regs.file = new TieredFileRegistry({
      disk: new DiskFileRegistry({ rootPath: options.filesPath }),
      // Only a distinct volatile root makes a separate backend; when it equals
      // the durable root (single-disk default) the disk backend is reused.
      volatile: options.volatilePath && options.volatilePath !== options.filesPath ? new DiskFileRegistry({ rootPath: options.volatilePath }) : undefined,
      db: new PgBlobRegistry({
        pool: cmd.sys.pgPool,
        prefix: options.name,
      }),
    });

    if (cmd.sys.routerManager) {
      // Every registry below that holds a LISTEN connection takes it from
      // `pgListenPool`: one per registry, held for the process lifetime and
      // useless for queries, so not taken from the work pool.
      regs.log = new PgLogRegistry({
        router: cmd.sys.routerManager,
        name: options.name,
        pool: cmd.sys.pgPool,
        listenPool: cmd.sys.pgListenPool,
      });

      regs.queue = new PgQueueRegistry({
        router: cmd.sys.routerManager,
        name: options.name,
        pool: cmd.sys.pgPool,
        listenPool: cmd.sys.pgListenPool,
      });

      regs.router = new RouterRegistry({
        router: cmd.sys.routerManager,
      });

      regs.track = new TrackRegistry({
        router: cmd.sys.routerManager,
        name: options.name,
        pool: cmd.sys.pgPool,
        listenPool: cmd.sys.pgListenPool,
      });
    }

    store = new PgStore({
      pgPool: cmd.sys.pgPool,
      rootMode,
      rootId: options.id,
      name: options.name,
    });
  } else if (type === 'filesystem') {
    if (!options.filesPath) {
      throw new Error('filesystem requires the filesPath option');
    }

    regs.file = new DiskFileRegistry({
      rootPath: options.filesPath,
    });

    store = new FilesystemStore({
      rootPath: options.filesPath,
      rootMode,
      rootId: options.id,
    });
  } else if (type === 'sftp') {
    const conn = sftpConnection(cmd, options, lazy);
    regs.file = new SftpFileRegistry(conn);
    store = new SftpStore({
      rootMode,
      uid: options.uid ? parseId(options.uid, 'uid') : cmd.access.uid,
      gid: options.gid ? parseId(options.gid, 'gid') : cmd.access.gid,
      lazy,
    }, conn);
    // A mirror: pipelines must not try to give its files children
    publish = false;
  } else if (type === 'command') {
    store = new CommandStore({
      cem: cmd.sys.cem,
      rootMode,
      rootId: options.id,
    });
  } else {
    throw new Error(`invalid store type: '${type}'`);
  }

  if (!store) {
    throw new Error('failed to create VFS');
  }

  // `noaudit=/var:/tmp`: subtrees, in the mount's own paths, whose writes leave no audit record.
  const unaudited = options.noaudit?.split(':').filter((p) => p !== '');

  return { vfs: new LocalNodeVFS(store, cmd.sys.routerManager, regs, { unaudited }), publish };
}

/**
 * `mount -a`: every line of /etc/fstab not mounted yet. An sftp mount does not
 * wait for its server here, so an unreachable one cannot hold up boot; it
 * connects when the server answers.
 */
async function mountAll(cmd: Command): Promise<number> {
  const fstabPath = `${cmd.env.ETC_PATH}/fstab`;
  const entries = parseFstab(await readFstab(cmd.sys.vfs, cmd.access, fstabPath));
  const mounted = new Set((await cmd.sys.vfs.mounts(cmd.access)).map((m) => m.point.absPath));
  let failed = 0;

  for (const entry of entries) {
    if (mounted.has(entry.point)) continue;
    try {
      await mountOne(cmd, entry, true);
      if (!cmd.json) await cmd.write(`mounted ${entry.type} at '${entry.point}'\n`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`mount: cannot mount '${entry.point}': ${message}\n`);
    }
  }

  if (cmd.json) await cmd.writeJSON({ ok: failed === 0 });
  return failed ? 1 : 0;
}

async function mountOne(cmd: Command, entry: FstabEntry, lazy: boolean): Promise<void> {
  const options = parseOptions(entry.options);
  const { vfs, publish } = await buildVfs(cmd, entry.type, options, lazy);

  try {
    await cmd.sys.vfs.mount(cmd.access, entry.point, vfs, {
      readonly: options.readonly === '1',
      publish,
    });
  } catch (error) {
    // A connection opened for a mount that did not happen must not linger
    await vfs.dispose().catch(() => {});
    throw error;
  }
}

export const mount = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['a', 'save'] });
  const flagsPath = flags._[0] as string;
  const flagsType = flags._[1] as string;
  const flagsOptions = flags._[2] as string;

  if (!flagsPath && !flags.a) {
    const mounts = await cmd.sys.vfs.mounts(cmd.access);

    mounts.sort((a, b) => a.point.absPath.localeCompare(b.point.absPath));

    if (cmd.json) {
      await cmd.writeJSON(mounts.map((m) => ({
        path: m.point.absPath,
        type: m.vfs.name,
        ...(m.vfs.source ? { source: m.vfs.source } : {}),
        rw: !m.options?.readonly && m.vfs.type !== 'readonly',
        mounted: m.mounted.timestamp,
      })));
      return 0;
    }

    const table = new Table({
      columns: [
        { name: 'path', align: 'left' },
        { name: 'type', align: 'left' },
        { name: 'rw', align: 'left' },
        { name: 'day', align: 'right' },
        { name: 'month', align: 'left' },
        { name: 'year', align: 'right' },
        { name: 'time', align: 'right' },
      ],
    });

    for (const m of mounts) {
      const rw = !m.options?.readonly && m.vfs.type !== 'readonly';

      const time = stampToObject(m.mounted.timestamp);

      table.addRow({
        path: color('white', m.point.absPath),
        type: color('yellow', m.vfs.source ? `${m.vfs.name} ${m.vfs.source}` : m.vfs.name),
        rw: rw ? color('green', 'rw') : color('red', 'r'),
        day: color('dim', time.day),
        month: color('dim', time.month),
        year: color('dim', time.year),
        time: color('dim', `${time.hour}:${time.minute}:${time.second}`),
      });
    }

    await cmd.write(table.render());

    return 0;
  }

  if (!isAdmin(cmd.access)) {
    await cmd.writeError('mount: permission denied, only admin is allowed to mount\n');
    return 2;
  }

  if (flags.a) return await mountAll(cmd);

  if (!flagsType) {
    await cmd.writeError('mount: missing type\n');
    return 1;
  }

  const path = resolve(cmd.cwd, flagsPath);

  try {
    await mountOne(cmd, { point: path, type: flagsType, options: flagsOptions ?? '' }, false);

    if (flags.save) {
      await updateFstab(cmd.sys.vfs, cmd.access, `${cmd.env.ETC_PATH}/fstab`, path, {
        point: path,
        type: flagsType,
        options: flagsOptions ?? '',
      });
    }

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`mounted ${flagsType} at '${path}'${flags.save ? ' (saved in /etc/fstab)' : ''}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`mount: cannot mount '${flagsPath}': ${message}\n`);
    return 1;
  }

  return 0;
};

mount.spec = {
  name: 'mount',
  effect: 'write' as const,
  description: 'Mount a filesystem',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'mount point',
    },
    {
      name: 'type',
      type: 'string' as const,
      description: 'type: memory, pg, filesystem, command, sftp',
    },
    {
      name: 'options',
      type: 'string' as const,
      description:
        'k=v,... — any: readonly, noaudit (paths, separated by `:`, whose writes the audit trail skips); sftp: host, port, user, path, key (identity file), hostkey (SHA256:… to pin), uid, gid',
    },
  ],
  flags: [
    { name: 'save', type: 'bool' as const, description: 'also record the mount in /etc/fstab, so boot mounts it again' },
    { name: 'a', type: 'bool' as const, description: 'mount every /etc/fstab entry not mounted yet' },
  ],
  examples: [
    'mount',
    'mount --save /mnt/nas sftp "host=nas.local,user=anna,path=/srv/photos"',
    'mount /mnt/backup sftp "host=backup.example.com,port=2222,key=/home/admin/.ssh/backup,readonly"',
    'mount -a',
  ],
};
