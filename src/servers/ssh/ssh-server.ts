/**
 * SSH Server
 *
 * Provides SSH access to the EiN VFS with terminal and SFTP support.
 * Uses the ssh2 package for SSH protocol handling.
 */

import { basename, dirname, join } from '@std/path';
import { ulid } from '@std/ulid';
import { type Channel, type Connection, type ConnectionInfo, type PKAuthContext, Server, type ServerAuthContext, type Session, SFTP } from 'ssh2';
import { type Access, ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { accountByLoginName } from '../../lib/auth/email.ts';
import { userAccess } from '../../lib/auth/member-gids.ts';
import { passwordSignIn, type SignInAccount } from '../../lib/auth/account-password.ts';
import { BOOT_ID } from '../../lib/boot-id/mod.ts';
import { homePath, USERS_PATH } from '../../lib/paths.ts';
import type { BufferManagerIf } from '../../managers/buffer/mod.ts';
import type { ExecutionManager } from '../../managers/exec/mod.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import { InteractiveShell } from '../../managers/shell/interactive-shell.ts';
import { Shell } from '../../managers/shell/shell.ts';
import type { ResourceHandleIf } from '../../registries/types.ts';
import type { EventSubscription, Node, NodeEvent, NodeVFS } from '../../vfs/mod.ts';
import { StepTimer } from '../../lib/metrics/mod.ts';
import type { SessionAttrs } from '../../vfs/types/session.ts';
import { loginRefusal, NODE_TYPE_USER, type UserAttrs } from '../../vfs/types/user.ts';
import { findAuthorizedKey } from './authorized-keys.ts';
import { SFTPHandler } from './sftp-handler.ts';

const logger = createLogger('ssh-server');

export type SSHServerConfig = {
  port: number;
  hostKey: string;
  cem: ExecutionManager;
  vfs: NodeVFS;
  bufferManager: BufferManagerIf;
  env: Record<string, string>;
};

type AuthenticatedUser = {
  access: Access;
  username: string;
};

export class SSHServer {
  private server: Server;
  private connections = new Map<string, Connection>();
  /** The account each authenticated connection signed in as, by connection id. */
  private usernames = new Map<string, string>();
  private userWatch?: EventSubscription;

  constructor(private config: SSHServerConfig) {
    this.server = new Server(
      {
        hostKeys: [this.config.hostKey],
        debug: (msg: string) => {
          logger.debug('SSH2', { msg });
        },
        algorithms: {
          serverHostKey: [
            'ssh-ed25519',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
          ],
        },
      },
      (client: Connection, info: ConnectionInfo) => this.handleConnection(client, info),
    );
  }

  async start(): Promise<number> {
    this.userWatch = await this.watchUsers();
    await this.server.listen(this.config.port, '0.0.0.0');
    const port = this.server.address()?.port ?? this.config.port;
    logger.info('SSH server listening', { port });
    return port;
  }

  async stop(): Promise<void> {
    await this.userWatch?.unsubscribe();
    this.userWatch = undefined;
    this.server.close();
  }

  /**
   * End every connection of an account that is disabled or deleted. The check
   * at sign-in cannot reach a connection that is already open, and the shells,
   * exec channels and SFTP sessions on it all act as the account.
   */
  private async watchUsers(): Promise<EventSubscription | undefined> {
    if (!this.config.vfs.subscribe) return undefined;
    return await this.config.vfs.subscribe<UserAttrs>(() => ADMIN_ACCESS, (event) => {
      if (dirname(event.path) !== USERS_PATH || !endsAccount(event)) return;
      this.endConnectionsOf(basename(event.path));
    }, {
      pathPrefix: USERS_PATH,
      recursive: false,
      nodeTypes: [NODE_TYPE_USER],
      eventTypes: ['updated', 'deleted'],
    });
  }

  private endConnectionsOf(username: string): void {
    for (const [connId, name] of this.usernames) {
      if (name !== username) continue;
      logger.info('ending SSH connection of a disabled account', { connId, username });
      this.connections.get(connId)?.end();
    }
  }

  private handleConnection(
    client: Connection,
    info: ConnectionInfo,
  ): void {
    const connId = ulid();
    this.connections.set(connId, client);
    let authenticatedUser: AuthenticatedUser | null = null;

    logger.info('SSH connection', { connId, ip: info.ip });

    client.on('authentication', async (ctx: ServerAuthContext) => {
      try {
        if (ctx.method === 'password') {
          const user = await this.authenticatePassword(
            ctx.username,
            (ctx as ServerAuthContext & { password: string }).password,
            info.ip,
          );
          if (user) {
            authenticatedUser = user;
            ctx.accept();
            return;
          }
        } else if (ctx.method === 'publickey') {
          const pk = ctx as PKAuthContext;
          const user = await this.authenticateKey(ctx.username, pk);
          if (user) {
            // Without a signature the client only asks whether this key would
            // do; accept() answers PK_OK and the signed request follows
            if (pk.signature) authenticatedUser = user;
            ctx.accept();
            return;
          }
        }
        ctx.reject(['publickey', 'password']);
      } catch (err) {
        logger.error('authentication error', {
          error: (err as Error).message,
        });
        ctx.reject();
      }
    });

    client.on('ready', () => {
      logger.info('SSH client authenticated', {
        connId,
        username: authenticatedUser?.username,
      });
      if (authenticatedUser) this.usernames.set(connId, authenticatedUser.username);

      client.on('session', (accept, _reject) => {
        const session = accept();
        if (!session) return;
        this.handleSession(client, session, authenticatedUser!, connId, info.ip);
      });
    });

    client.on('close', () => {
      this.connections.delete(connId);
      this.usernames.delete(connId);
      logger.info('SSH client disconnected', { connId });
    });

    client.on('error', (err: Error) => {
      logger.error('SSH client error', { connId, error: err.message });
    });
  }

  /**
   * The account `typed` names, by username or e-mail address (`accountByLoginName`), when it may sign
   * in by key: not disabled, no password reset pending. Null otherwise, whatever the key.
   */
  private async keySignInAccount(typed: string): Promise<SignInAccount | null> {
    const account = await accountByLoginName(this.config.vfs, typed).catch(() => undefined);
    if (!account) return null;

    const refusal = loginRefusal(account.userNode.attrs);
    if (refusal) {
      logger.debug(`publickey auth blocked: ${refusal}`, { username: account.username });
      return null;
    }
    return account;
  }

  private async authenticatedAs(username: string, userNode: Node<UserAttrs>): Promise<AuthenticatedUser> {
    return {
      access: await userAccess(this.config.vfs, ADMIN_ACCESS, username, userNode),
      username,
    };
  }

  /**
   * A key from the user's `~/.ssh/authorized_keys`. Asked twice per login by a
   * normal client: first without a signature ("would this key do?"), then with
   * one, which is verified here against the listed key.
   */
  private async authenticateKey(username: string, pk: PKAuthContext): Promise<AuthenticatedUser | null> {
    try {
      const account = await this.keySignInAccount(username);
      if (!account) return null;

      const found = await findAuthorizedKey(this.config.vfs, homePath(account.username), account.userNode.attrs.uid, pk.key.data);
      if (!found) return null;
      if ('refused' in found) {
        logger.warn('key auth refused', { username: account.username, reason: found.refused });
        return null;
      }

      if (pk.signature) {
        const valid = await found.key.verify(pk.blob!, pk.signature, pk.hashAlgo);
        if (valid !== true) return null;
      }
      return await this.authenticatedAs(account.username, account.userNode);
    } catch (err) {
      logger.debug('key auth failed', { username, error: (err as Error).message });
      return null;
    }
  }

  private async authenticatePassword(
    username: string,
    password: string,
    from: string | undefined,
  ): Promise<AuthenticatedUser | null> {
    try {
      const account = await passwordSignIn(this.config.vfs, username, password, { env: this.config.env, from });
      return await this.authenticatedAs(account.username, account.userNode);
    } catch (err) {
      logger.debug('password auth failed', {
        username,
        error: (err as Error).message,
      });
    }
    return null;
  }

  private handleSession(
    client: Connection,
    session: Session,
    user: AuthenticatedUser,
    connId: string,
    from: string | undefined,
  ): void {
    let shell: InteractiveShell | null = null;
    let rows = 24;
    let cols = 80;
    let stdinHandle: ResourceHandleIf | null = null;

    session.on('pty', (accept, _reject, info) => {
      rows = info.rows;
      cols = info.cols;
      accept?.();
    });

    session.on('window-change', (accept, _reject, info) => {
      rows = info.rows;
      cols = info.cols;
      if (shell) {
        shell.resize(rows, cols);
      }
      accept?.();
    });

    session.on('shell', async (accept, _reject) => {
      const channel = accept();
      if (!channel) return;

      let sessionPath = '';

      try {
        sessionPath = await this.createSession(user);

        shell = new InteractiveShell({
          cem: this.config.cem,
          vfs: this.config.vfs,
          bufferManager: this.config.bufferManager,
          sessionPath,
          origin: 'ssh',
          from,
          env: {
            ...this.config.env,
            USER: user.username,
            HOME: homePath(user.username),
          },
          rows,
          cols,
        });
        await shell.open();

        stdinHandle = await shell.openIOHandle('rawStdin', 'w');

        this.pipeReadableToHandle(channel.readable, stdinHandle);

        this.pipeHandleToChannel(await shell.openIOHandle('stdout', 'r'), channel, { crlf: true });
        this.pipeHandleToChannel(await shell.openIOHandle('stderr', 'r'), channel, { crlf: true });

        // Hang up running commands and tear down the shell when the interactive
        // session ends — whether by EOF or an abrupt client disconnect. Shell.close
        // is idempotent, so the channel 'close' backstop below is safe too.
        shell.runInteractive().then(async () => {
          await shell?.close();
          await this.removeSession(sessionPath);
          channel.exit(0);
          channel.close();
        }).catch(async (err) => {
          logger.error('shell error', { error: (err as Error).message });
          await shell?.close();
          await this.removeSession(sessionPath);
          channel.exit(1);
          channel.close();
        });

        channel.on('close', () => {
          // Backstop for an abrupt disconnect. Shell.close is idempotent and the
          // unlink tolerates an already-removed node, so racing the path above
          // is harmless.
          shell?.close()
            .then(() => this.removeSession(sessionPath))
            .catch((err) => logger.error('shell close failed', { error: (err as Error).message }));
        });
      } catch (err) {
        logger.error('shell setup failed', {
          error: (err as Error).message,
        });
        // Setup can fail after the session node exists — nothing will ever
        // reach it, so it must not be left behind either.
        if (sessionPath) {
          await this.removeSession(sessionPath);
        }
        channel.exit(1);
        channel.close();
      }
    });

    session.on('exec', async (accept, _reject, info) => {
      const channel = accept();
      if (!channel) return;

      let sessionPath = '';
      // The whole exec round trip step by step; `LOG_MODULES=ssh-server:DEBUG`
      // (see Shell.open for the inside of its `open` step).
      const timer = new StepTimer();

      try {
        sessionPath = await this.createSession(user);
        timer.mark('session');

        const cmdShell = new Shell({
          cem: this.config.cem,
          vfs: this.config.vfs,
          bufferManager: this.config.bufferManager,
          sessionPath,
          origin: 'ssh-exec',
          from,
          env: {
            ...this.config.env,
            USER: user.username,
            HOME: homePath(user.username),
          },
        });
        await cmdShell.open();
        timer.mark('open');

        // Pipe channel stdin to shell stdin so exec commands can read input
        const stdinHandle = await cmdShell.openIOHandle('rawStdin', 'w');
        this.pipeReadableToHandle(channel.readable, stdinHandle);

        this.pipeHandleToChannel(await cmdShell.openIOHandle('stdout', 'r'), channel);
        this.pipeHandleToChannel(await cmdShell.openIOHandle('stderr', 'r'), channel);
        timer.mark('pipes');

        // A client that goes away hangs up what it ran, as an interactive session's does.
        channel.on('close', () => {
          cmdShell.close().catch((err) => logger.error('shell close failed', { error: (err as Error).message }));
        });

        const exitCode = await cmdShell.run(info.command);
        timer.mark('run');

        channel.exit(exitCode);
        channel.close();
        await cmdShell.close();
        timer.mark('close');
        logger.debug('exec', { command: info.command, ...timer.report() });
      } catch (err) {
        logger.error('exec failed', {
          error: (err as Error).message,
          command: info.command,
        });
        channel.write(`error: ${(err as Error).message}\n`);
        channel.exit(1);
        channel.close();
      } finally {
        if (sessionPath) {
          await this.removeSession(sessionPath);
        }
      }
    });

    session.on('sftp', (accept, _reject) => {
      const channel = accept();
      if (!channel) return;

      const sftp = new SFTP(
        { protocol: client.protocol },
        {
          type: 'session',
          incoming: channel.incoming,
          outgoing: channel.outgoing,
        },
        { server: true },
      );

      this.pipeReadable(channel.readable, (data) => sftp.push(data), () => {
        // One-shot OpenSSH clients finish by sending CHANNEL_EOF, then wait
        // for the subsystem server to complete its half of the teardown.
        // Closing only the SFTP file handle does not close the SSH channel. The
        // subsystem ends cleanly, as OpenSSH's sftp-server does, with exit status 0:
        // without one, scp reports every transfer as failed.
        sftp.push(null);
        channel.exit(0);
        channel.end();
      });

      const handler = new SFTPHandler({
        vfs: this.config.vfs,
        access: { ...user.access, gids: [...user.access.gids] },
        homePath: homePath(user.username),
      });

      handler.attach(sftp);
      logger.info('SFTP session started', { connId, username: user.username });
    });
  }

  private async createSession(user: AuthenticatedUser): Promise<string> {
    const sessionName = `session-ssh-${ulid()}`;
    const sessionPath = join(this.config.env.SESSIONS_PATH, sessionName);

    await this.config.vfs.create<SessionAttrs>(
      ADMIN_ACCESS,
      'session',
      this.config.env.SESSIONS_PATH,
      sessionName,
      {
        props: { mode: 0o700 },
        attrs: {
          secret: ulid(),
          access: { ...user.access, gids: [...user.access.gids] },
          env: {
            ...this.config.env,
            USER: user.username,
            HOME: homePath(user.username),
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
          bootId: BOOT_ID,
        },
      },
    );

    return sessionPath;
  }

  /**
   * Drop the session node behind a finished channel.
   *
   * An SSH session is reachable only through its channel, so once the shell is
   * closed nothing can ever use it again, and a multiplexed client opens an
   * exec channel — and so a session — per command.
   *
   * Recursive because a shell that failed to close cleanly still has its tty
   * underneath; the stamp on both means `session-reap` would get them at the
   * next boot anyway, but there is no reason to wait for that.
   */
  private async removeSession(sessionPath: string): Promise<void> {
    try {
      await this.config.vfs.unlink(
        ADMIN_ACCESS,
        sessionPath,
        this.config.env.SESSIONS_PATH,
        { recursive: true, readlink: true },
      );
    } catch (err) {
      logger.debug('session cleanup failed', { sessionPath, error: (err as Error).message });
    }
  }

  private pipeHandleToChannel(
    handle: ResourceHandleIf,
    channel: Channel,
    opts?: { crlf?: boolean },
  ): void {
    const reader = handle.readable.getReader();
    const crlf = opts?.crlf ?? false;

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            channel.write(crlf ? this.convertLfToCrlf(value) : value);
          }
        }
      } catch (_err) {
        // Channel closed
      } finally {
        reader.releaseLock();
        await handle.close();
      }
    };

    pump();
  }

  private pipeReadableToHandle(
    readable: ReadableStream<Uint8Array>,
    handle: ResourceHandleIf,
  ): void {
    const reader = readable.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await handle.write(value);
          }
        }
      } catch (_err) {
        // Stream closed
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private pipeReadable(
    readable: ReadableStream<Uint8Array>,
    onData: (data: Uint8Array) => void,
    onEnd: () => void,
  ): void {
    const reader = readable.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            onData(value);
          }
        }
      } catch (_err) {
        // Stream closed
      } finally {
        reader.releaseLock();
        onEnd();
      }
    })();
  }

  /**
   * Convert lone LF (\n) to CRLF (\r\n) for SSH terminal output.
   * Preserves existing CRLF sequences.
   */
  private convertLfToCrlf(data: Uint8Array): Uint8Array {
    const LF = 0x0a;
    const CR = 0x0d;

    let extraBytes = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === LF && (i === 0 || data[i - 1] !== CR)) {
        extraBytes++;
      }
    }

    if (extraBytes === 0) {
      return data;
    }

    const result = new Uint8Array(data.length + extraBytes);
    let j = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === LF && (i === 0 || data[i - 1] !== CR)) {
        result[j++] = CR;
      }
      result[j++] = data[i];
    }

    return result;
  }
}

/** The account was deleted, or is disabled and may no longer act. */
function endsAccount(event: NodeEvent<UserAttrs>): boolean {
  return event.type === 'deleted' || event.node.attrs.inactive === true;
}
