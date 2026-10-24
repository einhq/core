import { basename, dirname } from '@std/path';
import { ADMIN_ACCESS, ADMIN_GID, ADMIN_UID } from '../../lib/access/mod.ts';
import { NODE_TYPE_SESSION, SessionAttrs } from '../../vfs/types/session.ts';
import { createLogger } from '../logger/mod.ts';
import type { ManagerIf } from '../types.ts';
import type { EventSubscription } from '../../vfs/types.ts';
import { watchElevations } from './elevations.ts';
import { Shell, ShellConfig } from './shell.ts';

const logger = createLogger('shell-manager');

type ShellManagerConfig = Omit<ShellConfig, 'sessionPath' | 'env' | 'rows' | 'cols' | 'onPwdChange'>;

type ShellCreateOpts = Omit<ShellConfig, 'cem' | 'vfs' | 'bufferManager'>;

export interface ShellManagerIf extends ManagerIf {
  createShell(opts: ShellCreateOpts): Promise<Shell>;
  /** A shell with an admin session at `opts.sessionPath`, its output going to the log. */
  createSystemShell(opts: ShellCreateOpts): Promise<Shell>;
}

export class ShellManager implements ShellManagerIf {
  private shells = new Map<string, Shell>();
  private elevationWatch: EventSubscription[] = [];

  constructor(private config: ShellManagerConfig) {}

  async init(): Promise<void> {
    this.elevationWatch = await watchElevations(this.config.vfs, this.config.cem);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.elevationWatch.map((subscription) => subscription.unsubscribe()));
    this.elevationWatch = [];
    await Promise.all([...this.shells.values()].map((s) => s.close().catch(() => {})));
    this.shells.clear();
  }

  async createShell(opts: ShellCreateOpts): Promise<Shell> {
    const shell = new Shell({ ...this.config, ...opts });
    await shell.open();
    this.shells.set(shell.name, shell);
    return shell;
  }

  async createSystemShell(opts: ShellCreateOpts): Promise<Shell> {
    const decoder = new TextDecoder();

    await this.config.vfs.ensure<SessionAttrs>(
      ADMIN_ACCESS,
      NODE_TYPE_SESSION,
      dirname(opts.sessionPath),
      basename(opts.sessionPath),
      {
        props: {
          mode: 0o700,
        },
        attrs: {
          secret: crypto.randomUUID().replaceAll('-', ''),
          access: {
            uid: ADMIN_UID,
            gid: ADMIN_GID,
            gids: [ADMIN_GID],
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
          env: {},
        },
      },
    );

    const shell = await this.createShell(opts);

    const stdout = await shell.openIOHandle('stdout', 'r');
    stdout.readable.pipeTo(
      new WritableStream<Uint8Array>({
        write(line) {
          logger.info(decoder.decode(line).trimEnd());
        },
      }),
    ).catch((err) => logger.error('stdout pipe failed', err));

    const stderr = await shell.openIOHandle('stderr', 'r');
    stderr.readable.pipeTo(
      new WritableStream<Uint8Array>({
        write(line) {
          logger.error(decoder.decode(line).trimEnd());
        },
      }),
    ).catch((err) => logger.error('stderr pipe failed', err));

    return shell;
  }
}
